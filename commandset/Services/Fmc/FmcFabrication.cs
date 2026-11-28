using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Fabrication;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// MEP fabrication support. Read-only: nothing is opened, loaded, changed or rolled back, so there is no transaction.
    /// It reports whether a FabricationConfiguration is loaded (and its name, version, path), the FabricationService list with
    /// the loaded and used ones, and one row per FabricationPart (service, specification, material, insulation, validation,
    /// connector state) with the ancillaries each part uses. The server decides what is a problem (server/src/fmc/fabrication.ts).
    /// With no configuration it answers configured=false and a message, never an error.
    /// Not yet run against a live Revit with a fabrication configuration (the Revit API calls are unverified).
    /// </summary>
    public class FmcFabricationHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const int PartCap = 20000;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft fabrication";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    bool wantParts = Parameters.Value<bool?>("parts") ?? true;
                    bool wantAncillaries = Parameters.Value<bool?>("ancillaries") ?? true;
                    var notes = new JArray();
                    FabricationConfiguration cfg = null;
                    string readProblem = "";
                    try { cfg = FabricationConfiguration.GetFabricationConfiguration(doc); }
                    catch (Exception ex) { readProblem = ex.Message; }
                    bool valid = false;
                    if (cfg != null)
                    {
                        try { valid = cfg.HasValidConfiguration(); }
                        catch (Exception ex) { notes.Add("HasValidConfiguration failed: " + ex.Message); }
                    }
                    if (cfg == null || !valid)
                    {
                        int count = CountParts(doc);
                        string why = cfg == null
                            ? "No fabrication configuration is loaded in this model" + (readProblem.Length > 0 ? " (" + readProblem + ")" : "") + "."
                            : "A fabrication configuration is attached to this model but it isn't valid (HasValidConfiguration is false), so its services can't be read.";
                        Result = new JObject
                        {
                            ["read_only"] = true,
                            ["transaction"] = false,
                            ["configured"] = false,
                            ["message"] = why + (count > 0 ? " The model holds " + count + " FabricationPart(s)." : ""),
                            ["fabrication_parts_in_model"] = count,
                            ["resolved_document"] = FmcTarget.Resolved(doc),
                            ["notes"] = notes,
                        };
                        return;
                    }

                    var info = new JObject { ["valid"] = true };
                    try
                    {
                        var ci = cfg.GetFabricationConfigurationInfo();
                        info["name"] = S(() => ci.Name);
                        info["description"] = S(() => ci.Description);
                        info["version"] = S(() => ci.Version);
                        info["product_version"] = S(() => ci.ProductVersion);
                        info["path"] = S(() => ci.Path);
                        info["guid"] = S(() => ci.GUID);
                        info["unit_system"] = S(() => ci.UnitSystem);
                        info["is_cloud"] = B(() => ci.IsCloudConfiguration);
                        info["is_locked"] = B(() => ci.IsLocked);
                    }
                    catch (Exception ex) { notes.Add("The configuration's name and version weren't readable: " + ex.Message); }

                    var loaded = new HashSet<int>();
                    var used = new HashSet<int>();
                    try { foreach (FabricationService s in cfg.GetAllLoadedServices()) loaded.Add(Convert.ToInt32(s.ServiceId)); }
                    catch (Exception ex) { notes.Add("Loaded services weren't readable: " + ex.Message); }
                    try { foreach (FabricationService s in cfg.GetAllUsedServices()) used.Add(Convert.ToInt32(s.ServiceId)); }
                    catch (Exception ex) { notes.Add("Used services weren't readable: " + ex.Message); }
                    var services = new JArray();
                    try
                    {
                        foreach (FabricationService s in cfg.GetAllServices())
                        {
                            int id = Convert.ToInt32(s.ServiceId);
                            services.Add(new JObject
                            {
                                ["id"] = id,
                                ["name"] = S(() => s.Name),
                                ["abbreviation"] = S(() => s.Abbreviation),
                                ["loaded"] = loaded.Contains(id),
                                ["used"] = used.Contains(id),
                            });
                        }
                    }
                    catch (Exception ex) { notes.Add("The service list wasn't readable: " + ex.Message); }

                    var rows = new JArray();
                    int total = 0;
                    bool cut = false;
                    foreach (Element e in new FilteredElementCollector(doc).OfClass(typeof(FabricationPart)).WhereElementIsNotElementType())
                    {
                        FabricationPart fp = e as FabricationPart;
                        if (fp == null) continue;
                        total++;
                        if (!wantParts) continue;
                        if (rows.Count >= PartCap) { cut = true; continue; }
                        rows.Add(Row(doc, cfg, fp, wantAncillaries));
                    }
                    if (cut) notes.Add("The part list stopped at " + PartCap + " of " + total + ".");

                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["configured"] = true,
                        ["config"] = info,
                        ["services"] = services,
                        ["parts_total"] = total,
                        ["parts_truncated"] = cut,
                        ["parts"] = wantParts ? rows : new JArray(),
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["notes"] = notes,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static int CountParts(Document doc)
        {
            try { return new FilteredElementCollector(doc).OfClass(typeof(FabricationPart)).WhereElementIsNotElementType().GetElementCount(); }
            catch { return 0; }
        }

        private static JObject Row(Document doc, FabricationConfiguration cfg, FabricationPart fp, bool ancillaries)
        {
            int specId = I(() => fp.Specification);
            int matId = I(() => fp.Material);
            int insId = I(() => fp.InsulationSpecification);
            int statusId = I(() => fp.PartStatus);
            string level = "";
            try { Level lv = doc.GetElement(fp.LevelId) as Level; if (lv != null) level = lv.Name; } catch { }
            int ends = 0, open = 0;
            try
            {
                ConnectorManager cm = fp.ConnectorManager;
                if (cm != null)
                    foreach (Connector c in cm.Connectors) { ends++; if (!c.IsConnected) open++; }
            }
            catch { }
            var anc = new JArray();
            if (ancillaries)
            {
                try
                {
                    var usage = fp.GetPartAncillaryUsage();
                    if (usage != null)
                        foreach (FabricationAncillaryUsage u in usage)
                        {
                            int aid = I(() => u.AncillaryId);
                            anc.Add(new JObject
                            {
                                ["id"] = aid,
                                ["name"] = S(() => cfg.GetAncillaryName(aid)),
                                ["usage"] = S(() => u.UsageType),
                                ["type"] = S(() => u.Type),
                                ["code"] = S(() => u.ProductCode),
                                ["qty"] = D(() => u.Quantity),
                                ["length_mm"] = D(() => u.Length) * FeetToMm,
                            });
                        }
                }
                catch { }
            }
            return new JObject
            {
                ["id"] = fp.Id.Value,
                ["category"] = fp.Category != null ? fp.Category.Name : "",
                ["level"] = level,
                ["service_id"] = I(() => fp.ServiceId),
                ["service"] = S(() => fp.ServiceName),
                ["spec_id"] = specId,
                ["spec"] = S(() => cfg.GetSpecificationName(specId)),
                ["material_id"] = matId,
                ["material"] = S(() => cfg.GetMaterialName(matId)),
                ["insulation_id"] = insId,
                ["insulation"] = S(() => cfg.GetInsulationSpecificationName(insId)),
                ["has_insulation"] = B(() => fp.HasInsulation),
                ["product"] = S(() => fp.ProductName),
                ["size"] = S(() => fp.Size),
                ["alias"] = S(() => fp.Alias),
                ["item_number"] = S(() => fp.ItemNumber),
                ["length_mm"] = D(() => fp.CenterlineLength) * FeetToMm,
                ["status_id"] = statusId,
                ["status"] = S(() => cfg.GetPartStatusDescription(statusId)),
                ["validation"] = S(() => fp.ValidationStatus),
                ["iso_update"] = B(() => fp.NeedToUpdateIsoDrawing),
                ["hanger"] = B(() => fp.IsAHanger()),
                ["straight"] = B(() => fp.IsAStraight()),
                ["bought_out"] = B(() => fp.IsBoughtOut),
                ["ends"] = ends,
                ["open_ends"] = open,
                ["no_connections"] = B(() => fp.HasNoConnections()),
                ["anc"] = anc,
            };
        }

        // Each property is read on its own: one the API refuses on one part must not lose the whole row.
        private static string S<T>(Func<T> read) { try { T v = read(); return v == null ? "" : v.ToString(); } catch { return ""; } }
        private static bool B<T>(Func<T> read) { try { return Convert.ToBoolean(read()); } catch { return false; } }
        private static int I<T>(Func<T> read) { try { return Convert.ToInt32(read()); } catch { return 0; } }
        private static double D<T>(Func<T> read) { try { return Convert.ToDouble(read()); } catch { return 0; } }
    }
}
