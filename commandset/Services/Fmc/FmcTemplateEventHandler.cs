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
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
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

        /// <summary>
        /// The facts the audit needs; the server compares them with the kit. F-044: the names of title block families,
        /// schedules, view templates, legends, panel schedule templates and every material (used, textures), not only counts.
        /// </summary>
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

            // F-044: names, so the server can check the template against the kit both ways (never a count passed as a check)
            var titleBlockFamilies = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType()
                .OfType<FamilySymbol>().Select(s => s.FamilyName).Distinct().OrderBy(n => n);
            var schedules = views.OfType<ViewSchedule>().Where(v => !v.IsTemplate && !v.IsTitleblockRevisionSchedule && !v.IsInternalKeynoteSchedule);
            var panelTemplates = new FilteredElementCollector(doc).OfClass(typeof(Autodesk.Revit.DB.Electrical.PanelScheduleTemplate)).Select(e => e.Name);
            var materials = new JArray();
            try
            {
                var used = FmcMaterialEventHandler.UsedMaterials(doc);
                foreach (Material m in new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>())
                {
                    IEnumerable<string> textures;
                    try { textures = FmcMaterialEventHandler.Textures(doc, m).Select(ResolveTexture).ToList(); } catch (Exception) { textures = Enumerable.Empty<string>(); }
                    materials.Add(new JObject { ["name"] = m.Name, ["used"] = used.Contains(m.Id.Value), ["textures"] = new JArray(textures) });
                }
            }
            catch (Exception) { materials = null; /* the server says Not checked */ }

            var result = new JObject
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
                ["title_block_families"] = new JArray(titleBlockFamilies),
                ["schedule_names"] = new JArray(schedules.Select(v => v.Name)),
                ["view_template_names"] = new JArray(views.Where(v => v.IsTemplate).Select(v => v.Name)),
                ["legend_names"] = new JArray(views.Where(v => !v.IsTemplate && v.ViewType == ViewType.Legend).Select(v => v.Name)),
                ["panel_schedule_templates"] = new JArray(panelTemplates),
            };
            if (materials != null) result["materials"] = materials;
            return result;
        }

        /// <summary>Autodesk's library textures are stored relative ("1\Mats\…"): resolved against the shared Textures folders; else as stored.</summary>
        private static readonly string[] TextureRoots = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles),
            }
            .Where(r => !string.IsNullOrEmpty(r)).Distinct()
            .Select(r => Path.Combine(r, "Autodesk Shared", "Materials", "Textures")).ToArray();

        private static string ResolveTexture(string stored)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(stored) || Path.IsPathRooted(stored)) return stored;
                foreach (string root in TextureRoots)
                {
                    string full = Path.Combine(root, stored);
                    if (File.Exists(full)) return full;
                }
            }
            catch (Exception) { /* an odd path stays as stored, and the server reports it as not found */ }
            return stored;
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
