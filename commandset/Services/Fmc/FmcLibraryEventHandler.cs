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
    /// Families in the pane (U15) on the Revit main thread. scan reads every loadable family in the active document
    /// (read-only, so it also works on live models); inspect reads an outside .rfa opened in the background; bring_in
    /// adds the kit's shared parameters, sets the keynote and saves the family under its standard name in library staging.
    /// The server checks names, folders and the kit first (fmc_library).
    /// </summary>
    public class FmcLibraryEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
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
                    case "scan": Result = Scan(app); break;
                    case "inspect": Result = WithFamilyFile(app, Parameters.Value<string>("path") ?? "", false, Inspect); break;
                    case "bring_in": Result = BringIn(app); break;
                    default: Error = $"Unknown FMC library action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                try { FmcSharedParams.RestoreIfPending(app.Application); } catch (Exception) { /* F-037: reported by the next build */ }
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC library";

        // ------------------------------------------------------------------ scan (read-only)

        private JObject Scan(UIApplication app)
        {
            using var target = FmcTarget.Resolve(app, Parameters, mayOpen: true);
            Document doc = target.Doc;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Scan reads the families loaded in a project; open a project.");
            var placed = new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>()
                .GroupBy(i => i.Symbol?.Family?.Id?.Value ?? -1).ToDictionary(g => g.Key, g => g.Count());
            var families = new JArray();
            foreach (Family f in new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>())
            {
                if (!f.IsEditable || f.IsInPlace) continue;
                var types = new JArray();
                var shared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ElementId id in f.GetFamilySymbolIds())
                {
                    if (!(doc.GetElement(id) is FamilySymbol s)) continue;
                    types.Add(new JObject
                    {
                        ["name"] = s.Name,
                        ["keynote"] = s.get_Parameter(BuiltInParameter.KEYNOTE_PARAM)?.AsString() ?? "",
                    });
                    foreach (Parameter p in s.Parameters)
                        if (p.IsShared) shared.Add(p.GUID.ToString());
                }
                families.Add(new JObject
                {
                    ["name"] = f.Name,
                    ["category"] = f.FamilyCategory?.Name ?? "",
                    ["types"] = types,
                    ["shared_guids"] = new JArray(shared),
                    ["placed"] = placed.TryGetValue(f.Id.Value, out int n) ? n : 0,
                });
            }
            return new JObject { ["document"] = doc.Title, ["families"] = families };
        }

        // ------------------------------------------------------------------ inspect an outside .rfa (read-only)

        private static JObject WithFamilyFile(UIApplication app, string path, bool keepOpen, Func<Document, JObject> work, bool readOnly = true)
        {
            if (!File.Exists(path)) throw new FileNotFoundException($"Family not found: {path}");
            // Already open (the person's window, or a build's session): read it and leave it open (F-023, F-039).
            Document already = app.Application.Documents.Cast<Document>().FirstOrDefault(d =>
                !d.IsLinked && string.Equals(d.PathName, path, StringComparison.OrdinalIgnoreCase));
            if (already != null && !readOnly)
                throw new InvalidOperationException($"{Path.GetFileName(path)} is open in Revit: close it there first, so the copy saved to staging can't take over the open file");
            Document doc;
            try { doc = already ?? app.Application.OpenDocumentFile(path); }
            catch (Exception e) { throw new InvalidOperationException($"Revit couldn't open {Path.GetFileName(path)}: {e.Message}", e); }
            try
            {
                if (!doc.IsFamilyDocument) throw new InvalidOperationException($"{Path.GetFileName(path)} is not a family.");
                JObject r = work(doc);
                if (already != null) r["already_open"] = true;
                return r;
            }
            finally
            {
                if (!keepOpen && already == null) doc.Close(false);
            }
        }

        private JObject Inspect(Document doc)
        {
            FamilyManager fm = doc.FamilyManager;
            var parameters = new JArray();
            foreach (FamilyParameter p in fm.Parameters)
                parameters.Add(new JObject { ["name"] = p.Definition.Name, ["shared"] = p.IsShared, ["guid"] = p.IsShared ? p.GUID.ToString() : "", ["instance"] = p.IsInstance });
            // F-039: each type's keynote as saved: the built-in Keynote and every text parameter named like a keynote
            // (the kit's keynote code parameter among them); the server decides what counts.
            var keynoteParams = new List<FamilyParameter>();
            FamilyParameter builtIn = fm.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
            if (builtIn != null) keynoteParams.Add(builtIn);
            keynoteParams.AddRange(fm.Parameters.Cast<FamilyParameter>().Where(p => p.StorageType == StorageType.String
                && p.Definition.Name.IndexOf("keynote", StringComparison.OrdinalIgnoreCase) >= 0 && (builtIn == null || p.Id != builtIn.Id)));
            var typeKeynotes = new JArray();
            foreach (FamilyType t in fm.Types.Cast<FamilyType>().Where(t => !string.IsNullOrWhiteSpace(t.Name)))
            {
                var values = new JObject();
                foreach (FamilyParameter p in keynoteParams)
                {
                    string v = "";
                    try { v = t.AsString(p) ?? ""; } catch (Exception) { /* not readable for this type */ }
                    values[p == builtIn ? "Keynote" : p.Definition.Name] = v;
                }
                typeKeynotes.Add(new JObject { ["name"] = t.Name, ["values"] = values });
            }
            return new JObject
            {
                ["name"] = Path.GetFileNameWithoutExtension(doc.PathName),
                ["category"] = doc.OwnerFamily?.FamilyCategory?.Name ?? "",
                ["size_mb"] = Math.Round(new FileInfo(doc.PathName).Length / 1048576.0, 2),
                ["imported_cad"] = new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)).GetElementCount(),
                ["nested"] = new FilteredElementCollector(doc).OfClass(typeof(Family)).GetElementCount(),
                ["types"] = new JArray(fm.Types.Cast<FamilyType>().Select(t => t.Name).Where(n => !string.IsNullOrWhiteSpace(n))),
                ["type_keynotes"] = typeKeynotes,
                ["parameters"] = parameters,
                ["legend"] = LegendFacts(doc),
            };
        }

        /// <summary>
        /// What a legend component, plan or elevation can show (owner, 18 Oct: legend elevations were blank). For every
        /// solid form: whether it is shown in plan, front/back and left/right views and at which detail levels, and its
        /// subcategory's line colour. The server fails the check on views with nothing in them or lines too light to see.
        /// </summary>
        private static JObject LegendFacts(Document doc)
        {
            int solids = 0, plan = 0, front = 0, side = 0;
            var front_at = new JObject { ["coarse"] = 0, ["medium"] = 0, ["fine"] = 0 };
            var light = new SortedSet<string>();
            var lines = new JObject();
            foreach (GenericForm g in new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>())
            {
                if (!g.IsSolid) continue;
                solids++;
                FamilyElementVisibility v = g.GetVisibility();
                if (v == null) { plan++; front++; side++; foreach (var k in new[] { "coarse", "medium", "fine" }) front_at[k] = (int)front_at[k] + 1; continue; }
                if (v.IsShownInTopBottom) plan++;
                if (v.IsShownInFrontBack) front++;
                if (v.IsShownInLeftRight) side++;
                if (v.IsShownInFrontBack)
                {
                    if (v.IsShownInCoarse) front_at["coarse"] = (int)front_at["coarse"] + 1;
                    if (v.IsShownInMedium) front_at["medium"] = (int)front_at["medium"] + 1;
                    if (v.IsShownInFine) front_at["fine"] = (int)front_at["fine"] + 1;
                }
                Category c = g.Subcategory ?? doc.OwnerFamily?.FamilyCategory;
                if (c == null) continue;
                Color col = c.LineColor;
                if (col == null || !col.IsValid) continue;
                string name = g.Subcategory?.Name ?? "(family category)";
                // clearance and coverage zones are analysis volumes in their own colour, not product lines
                if (name.StartsWith("Clearance", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Coverage", StringComparison.OrdinalIgnoreCase)) continue;
                lines[name] = new JArray(col.Red, col.Green, col.Blue);
                double lum = (0.2126 * col.Red + 0.7152 * col.Green + 0.0722 * col.Blue) / 255.0;
                if (lum > 0.6) light.Add(name);
            }
            return new JObject
            {
                ["solids"] = solids, ["plan"] = plan, ["front"] = front, ["side"] = side,
                ["front_at"] = front_at, ["light_lines"] = new JArray(light), ["line_colours"] = lines,
            };
        }

        // ------------------------------------------------------------------ bring in

        /// <summary>
        /// Opens the outside family, adds the kit's shared parameters (only from the kit's file, matched by GUID), sets
        /// the keynote on every type and saves it under its standard name in staging. The original file is never changed.
        /// </summary>
        private JObject BringIn(UIApplication app)
        {
            string source = Parameters.Value<string>("path") ?? "";
            string target = Parameters.Value<string>("save_path") ?? "";
            string spFile = Parameters.Value<string>("shared_parameter_file") ?? "";
            string keynote = Parameters.Value<string>("keynote") ?? "";
            var wanted = Parameters["parameters"] as JArray ?? new JArray();
            if (string.IsNullOrWhiteSpace(target)) throw new ArgumentException("save_path is required");
            if (wanted.Count > 0 && !File.Exists(spFile)) throw new FileNotFoundException($"Shared parameter file not found: {spFile}");

            var rvt = app.Application;
            var added = new JArray();
            var warnings = new JArray();
            // F-037: the kit's file only while bringing in; the person's comes back when the scope ends
            using (FmcSharedParams.Use(rvt, wanted.Count > 0 ? spFile : ""))
            {
                DefinitionFile df = wanted.Count > 0 ? rvt.OpenSharedParameterFile() : null;
                return WithFamilyFile(app, source, false, doc =>
                {
                    FamilyManager fm = doc.FamilyManager;
                    using (var t = new Transaction(doc, "Formcraft: bring in"))
                    {
                        t.Start();
                        foreach (JObject p in wanted.OfType<JObject>())
                        {
                            string name = p.Value<string>("name") ?? "", guid = p.Value<string>("guid") ?? "";
                            if (fm.Parameters.Cast<FamilyParameter>().Any(x => x.IsShared && string.Equals(x.GUID.ToString(), guid, StringComparison.OrdinalIgnoreCase))) continue;
                            ExternalDefinition def = df?.Groups.Cast<DefinitionGroup>().Select(g => g.Definitions.get_Item(name) as ExternalDefinition)
                                .FirstOrDefault(d => d != null && string.Equals(d.GUID.ToString(), guid, StringComparison.OrdinalIgnoreCase));
                            if (def == null) { warnings.Add($"{name}: not in the kit's shared parameter file with that GUID"); continue; }
                            try { fm.AddParameter(def, GroupTypeId.Data, p.Value<bool?>("instance") ?? false); added.Add(name); }
                            catch (Exception ex) { warnings.Add($"{name} not added: {ex.Message}"); }
                        }
                        if (keynote.Length > 0)
                        {
                            FamilyParameter kp = fm.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
                            if (kp == null) warnings.Add("This family has no keynote parameter");
                            else
                            {
                                if (fm.Types.Size == 0) fm.NewType(Path.GetFileNameWithoutExtension(target));
                                foreach (FamilyType ft in fm.Types)
                                {
                                    fm.CurrentType = ft;
                                    fm.Set(kp, keynote);
                                }
                            }
                        }
                        t.Commit();
                    }
                    int cad = new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)).GetElementCount();
                    if (cad > 0) warnings.Add($"{cad} imported CAD left in the family: purge it by hand before release");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    doc.SaveAs(target, new SaveAsOptions { OverwriteExistingFile = Parameters.Value<bool?>("overwrite") ?? false, MaximumBackups = 1 });
                    return new JObject { ["saved"] = target, ["added"] = added, ["keynote"] = keynote, ["warnings"] = warnings };
                }, readOnly: false);
            }
        }
    }
}
