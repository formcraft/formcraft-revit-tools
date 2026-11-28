using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_exports (GAP-04): IFC4, DWG, NWC and gbXML from the kit's setups. dry_run=true only checks (views, the DWG
    /// setup, the Navisworks exporter). A real run writes only into the server's hidden arrival folder
    /// (&lt;project&gt;\02_Shared|03_Published\...\.fmc_export_&lt;run&gt;); the server verifies the files and moves them into place.
    /// The model is not changed: the IFC export runs in a transaction that is rolled back.
    /// </summary>
    public class FmcExportsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft exports";

        private static View FindView(Document doc, string key)
        {
            key = (key ?? "").Trim();
            if (key.Length == 0) return null;
            if (long.TryParse(key, out _) && doc.GetElement(FmcExtStoreSchema.ToId(key)) is View byId && !byId.IsTemplate) return byId;
            return new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .FirstOrDefault(v => !v.IsTemplate && string.Equals(v.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>The arrival folder must be the server's hidden folder inside 02_Shared or 03_Published.</summary>
        private static string CheckArrival(string folder)
        {
            folder = (folder ?? "").Trim();
            if (folder.Length == 0) return "[FMC-EXPORTS-FOLDER] A real export needs the arrival folder.";
            string leaf = Path.GetFileName(folder.TrimEnd('\\', '/'));
            if (!leaf.StartsWith(".fmc_export_", StringComparison.Ordinal)) return "[FMC-EXPORTS-FOLDER] The folder is not an fmc_exports arrival folder.";
            string[] parts = folder.Split('\\', '/');
            if (!parts.Any(p => p.Equals("02_Shared", StringComparison.OrdinalIgnoreCase) || p.Equals("03_Published", StringComparison.OrdinalIgnoreCase)))
                return "[FMC-EXPORTS-FOLDER] The arrival folder must be inside 02_Shared or 03_Published.";
            if (!Directory.Exists(folder)) return "[FMC-EXPORTS-FOLDER] The arrival folder does not exist.";
            return "";
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_exports needs document.");
                bool dry = Parameters.Value<bool?>("dry_run") != false;
                string folder = Parameters.Value<string>("folder") ?? "";
                if (!dry)
                {
                    string why = CheckArrival(folder);
                    if (why.Length > 0) throw new InvalidOperationException(why);
                }
                JArray exports = Parameters["exports"] as JArray ?? new JArray();
                JObject names = Parameters["names"] as JObject ?? new JObject();
                string psets = Parameters.Value<string>("ifc_psets_file") ?? "";
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var problems = new JArray();
                    var warnings = new JArray();
                    var checks = new JObject();
                    var made = new JArray();

                    var viewKeys = (Parameters["views"] as JArray ?? new JArray()).Select(v => v.ToString()).ToList();
                    var views = new List<View>();
                    foreach (string k in viewKeys)
                    {
                        View v = FindView(doc, k);
                        if (v == null) problems.Add("No view or sheet named " + k);
                        else views.Add(v);
                    }
                    View3D first3d = views.OfType<View3D>().FirstOrDefault(v => !v.IsTemplate);

                    foreach (JObject setup in exports.OfType<JObject>())
                    {
                        string fmt = setup.Value<string>("format") ?? "";
                        string name = names.Value<string>(fmt) ?? (doc.Title ?? "model");
                        switch (fmt)
                        {
                            case "ifc":
                            {
                                View v = FindView(doc, setup.Value<string>("view")) ?? first3d;
                                checks["ifc"] = new JObject
                                {
                                    ["version"] = setup.Value<string>("version") ?? "IFC4RV",
                                    ["view"] = v?.Name ?? "(whole model)",
                                    ["psets_file"] = psets.Length > 0 ? psets : "(none found)",
                                };
                                if (psets.Length == 0) warnings.Add("IFC: the kit property set file was not found; FMC psets are not exported");
                                if (dry) break;
                                var o = new IFCExportOptions();
                                string ver = setup.Value<string>("version") ?? "IFC4RV";
                                o.FileVersion = ver == "IFC4" ? IFCVersion.IFC4 : ver == "IFC4DTV" ? IFCVersion.IFC4DTV : IFCVersion.IFC4RV;
                                o.ExportBaseQuantities = setup.Value<bool?>("base_quantities") ?? true;
                                o.WallAndColumnSplitting = setup.Value<bool?>("split_walls_columns") ?? false;
                                if (v != null) o.FilterViewId = v.Id;
                                if (psets.Length > 0)
                                {
                                    o.AddOption("ExportUserDefinedPsets", "true");
                                    o.AddOption("ExportUserDefinedPsetsFileName", psets);
                                }
                                bool ok;
                                using (var t = new Transaction(doc, "Formcraft: IFC export (rolled back)"))
                                {
                                    t.Start();
                                    ok = doc.Export(folder, name + ".ifc", o);
                                    t.RollBack();
                                }
                                made.Add(new JObject { ["format"] = "ifc", ["file"] = Path.Combine(folder, name + ".ifc"), ["revit_ok"] = ok });
                                break;
                            }
                            case "dwg":
                            {
                                string setupName = setup.Value<string>("setup") ?? "FMC_DWG";
                                DWGExportOptions o = DWGExportOptions.GetPredefinedOptions(doc, setupName);
                                checks["dwg"] = new JObject { ["setup"] = setupName, ["setup_found"] = o != null, ["views"] = new JArray(views.Select(x => x.Name)) };
                                if (o == null) { problems.Add("DWG: no export setup named " + setupName + " in the model (load it from the FMC template)"); break; }
                                if (views.Count == 0) { problems.Add("DWG: no views or sheets"); break; }
                                if (dry) break;
                                o.MergedViews = setup.Value<bool?>("merged_views") ?? true;
                                bool ok = doc.Export(folder, name, views.Select(x => x.Id).ToList(), o);
                                made.Add(new JObject { ["format"] = "dwg", ["prefix"] = name, ["revit_ok"] = ok });
                                break;
                            }
                            case "nwc":
                            {
                                bool available = OptionalFunctionalityUtils.IsNavisworksExporterAvailable();
                                View v = FindView(doc, setup.Value<string>("view")) ?? first3d;
                                checks["nwc"] = new JObject { ["exporter_available"] = available, ["view"] = v?.Name ?? "(whole model)" };
                                if (!available) { problems.Add("NWC: the Navisworks exporter is not installed for this Revit version"); break; }
                                if (dry) break;
                                var o = new NavisworksExportOptions
                                {
                                    Coordinates = (setup.Value<string>("coordinates") ?? "shared") == "internal" ? NavisworksCoordinates.Internal : NavisworksCoordinates.Shared,
                                    ExportLinks = setup.Value<bool?>("links") ?? false,
                                    ExportRoomGeometry = setup.Value<bool?>("rooms") ?? false,
                                };
                                if (v != null) { o.ExportScope = NavisworksExportScope.View; o.ViewId = v.Id; }
                                else o.ExportScope = NavisworksExportScope.Model;
                                doc.Export(folder, name + ".nwc", o);
                                made.Add(new JObject { ["format"] = "nwc", ["file"] = Path.Combine(folder, name + ".nwc") });
                                break;
                            }
                            case "gbxml":
                            {
                                checks["gbxml"] = new JObject { ["ok"] = true };
                                if (dry) break;
                                bool ok = doc.Export(folder, name + ".xml", new GBXMLExportOptions());
                                made.Add(new JObject { ["format"] = "gbxml", ["file"] = Path.Combine(folder, name + ".xml"), ["revit_ok"] = ok });
                                break;
                            }
                            default:
                                problems.Add("Unknown export format " + fmt);
                                break;
                        }
                    }
                    Result = new JObject
                    {
                        ["dry_run"] = dry,
                        ["model_changed"] = false,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["checks"] = checks,
                        ["problems"] = problems,
                        ["warnings"] = warnings,
                        ["made"] = made,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
