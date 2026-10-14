using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Templates (U14) on the Revit main thread: read a template for the audit, and change its text and dimension fonts
    /// for a brand pack. Folder rules are checked by the server first (fmc_template): a template is only changed in a
    /// staging write root, and every change is a dry run first. A template that isn't open is opened in the background
    /// and closed again; it is saved only by a real brand run.
    /// </summary>
    public class FmcTemplateEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                switch (Action)
                {
                    case "audit": Result = WithTemplate(app, false, Audit); break;
                    case "brand": Result = WithTemplate(app, Parameters.Value<bool?>("dry_run") == false, Brand); break;
                    case "create":
                        Result = FmcTemplateBuild.Create(app.Application, Parameters.Value<string>("seed_path") ?? "", Parameters.Value<string>("template_path") ?? "");
                        break;
                    case "build":
                    {
                        // One layer of the base recipe (Phase 1). A dry run applies it inside a group and rolls it back,
                        // so it reports what would change even on a template that is already open; only a real run saves.
                        bool dry = Parameters.Value<bool?>("dry_run") != false;
                        string layer = Parameters.Value<string>("layer") ?? "";
                        var payload = Parameters["payload"] as JObject ?? new JObject();
                        double seconds = Parameters.Value<double?>("seconds") ?? 33;
                        Result = WithTemplate(app, !dry, doc =>
                        {
                            using (var tg = new TransactionGroup(doc, "Formcraft template: " + layer))
                            {
                                tg.Start();
                                JObject r = FmcTemplateBuild.Apply(doc, layer, payload, seconds);
                                if (dry) tg.RollBack(); else tg.Assimilate();
                                r["dry_run"] = dry;
                                return r;
                            }
                        });
                        break;
                    }
                    case "names": Result = WithTemplate(app, false, FmcTemplateBuild.Names); break;
                    default: Error = $"Unknown FMC template action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC template";

        /// <summary>Runs on the template (open already, or opened in the background); saves only when asked to.</summary>
        private JObject WithTemplate(UIApplication app, bool save, Func<Document, JObject> work)
        {
            string path = Parameters.Value<string>("template_path") ?? "";
            if (!File.Exists(path)) throw new FileNotFoundException($"Template not found: {path}");
            Document doc = app.Application.Documents.Cast<Document>()
                .FirstOrDefault(d => !d.IsLinked && !string.IsNullOrEmpty(d.PathName) &&
                                     string.Equals(Path.GetFullPath(d.PathName), Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase));
            bool opened = doc == null;
            if (opened) doc = app.Application.OpenDocumentFile(path);
            try
            {
                if (doc.IsWorkshared) throw new InvalidOperationException($"{doc.Title} is workshared. Tools never change workshared files.");
                JObject result = work(doc);
                if (save)
                {
                    if (opened) doc.Save(new SaveOptions());
                    else doc.Save();
                    result["saved"] = path;
                }
                return result;
            }
            finally
            {
                if (opened) doc.Close(false);
            }
        }

        /// <summary>The facts the audit needs; the server compares them with the kit.</summary>
        private JObject Audit(Document doc)
        {
            var shared = new JArray();
            foreach (SharedParameterElement p in new FilteredElementCollector(doc).OfClass(typeof(SharedParameterElement)))
                shared.Add(new JObject { ["name"] = p.Name, ["guid"] = p.GuidValue.ToString() });

            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().ToList();
            var textTypes = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>()
                .Select(t => new JObject { ["name"] = t.Name, ["font"] = t.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString() ?? "" });
            var dimTypes = new FilteredElementCollector(doc).OfClass(typeof(DimensionType)).Cast<DimensionType>()
                .Where(t => t.get_Parameter(BuiltInParameter.TEXT_FONT) != null)
                .Select(t => new JObject { ["name"] = t.Name, ["font"] = t.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString() ?? "" });

            var placedTypes = new HashSet<ElementId>(new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance))
                .Cast<FamilyInstance>().Select(i => i.Symbol?.Family?.Id).Where(id => id != null));
            int families = 0, unused = 0;
            foreach (Family f in new FilteredElementCollector(doc).OfClass(typeof(Family)))
            {
                if (!f.IsEditable) continue;
                families++;
                if (!placedTypes.Contains(f.Id)) unused++;
            }

            return new JObject
            {
                ["title"] = doc.Title,
                ["size_mb"] = Math.Round(new FileInfo(doc.PathName).Length / 1048576.0, 1),
                ["shared_parameters"] = shared,
                ["view_templates"] = views.Count(v => v.IsTemplate),
                ["filters"] = new FilteredElementCollector(doc).OfClass(typeof(ParameterFilterElement)).GetElementCount(),
                ["text_types"] = new JArray(textTypes),
                ["dimension_types"] = new JArray(dimTypes),
                ["title_blocks"] = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().GetElementCount(),
                ["schedules"] = views.Count(v => v is ViewSchedule && !v.IsTemplate),
                ["browser_organisations"] = new FilteredElementCollector(doc).OfClass(typeof(BrowserOrganization)).GetElementCount(),
                ["families"] = families,
                ["unused_families"] = unused,
                ["warnings"] = doc.GetWarnings().Count,
            };
        }

        /// <summary>
        /// Brand pack: text and dimension types get the pack's fonts (title types its title font); sizes never change.
        /// Dry run returns what each type would become; a real run changes and the caller saves.
        /// </summary>
        private JObject Brand(Document doc)
        {
            string main = Parameters.Value<string>("main_font") ?? "";
            string title = Parameters.Value<string>("title_font") ?? main;
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            if (string.IsNullOrWhiteSpace(main)) throw new ArgumentException("main_font is required");

            var changes = new JArray();
            var types = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<ElementType>()
                .Concat(new FilteredElementCollector(doc).OfClass(typeof(DimensionType)).Cast<ElementType>())
                .Where(t => t.get_Parameter(BuiltInParameter.TEXT_FONT) is Parameter p && !p.IsReadOnly).ToList();
            Transaction t0 = dry ? null : new Transaction(doc, "Formcraft: brand pack");
            t0?.Start();
            try
            {
                foreach (ElementType t in types)
                {
                    Parameter font = t.get_Parameter(BuiltInParameter.TEXT_FONT);
                    string now = font.AsString() ?? "";
                    string after = t.Name.IndexOf("title", StringComparison.OrdinalIgnoreCase) >= 0 ? title : main;
                    if (string.Equals(now, after, StringComparison.OrdinalIgnoreCase)) continue;
                    changes.Add(new JObject { ["item"] = (t is TextNoteType ? "Text: " : "Dimension: ") + t.Name, ["now"] = now, ["after"] = after });
                    if (!dry) font.Set(after);
                }
                t0?.Commit();
            }
            finally
            {
                t0?.Dispose();
            }
            return new JObject { ["title"] = doc.Title, ["dry_run"] = dry, ["changes"] = changes };
        }
    }
}
