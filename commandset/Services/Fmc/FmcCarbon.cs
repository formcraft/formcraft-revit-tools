using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// GAP-24 read only: material volumes and areas by material and by category and type, for fmc_carbon. No transaction.
    /// Revit 2025 has no embodied-carbon API; the server applies the kit's factors.
    /// </summary>
    public class FmcCarbonHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private static readonly BuiltInCategory[] Defaults =
        {
            BuiltInCategory.OST_Walls, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Ceilings,
            BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_Columns, BuiltInCategory.OST_StructuralFraming,
            BuiltInCategory.OST_StructuralFoundation, BuiltInCategory.OST_Stairs, BuiltInCategory.OST_Railings, BuiltInCategory.OST_Ramps,
            BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_CurtainWallPanels, BuiltInCategory.OST_CurtainWallMullions,
            BuiltInCategory.OST_GenericModel,
        };

        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft carbon read";

        private sealed class Sum { public string Name = ""; public string Class = ""; public double Volume; public double Area; public int Elements; }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_carbon needs document. Refusing to use the active document.");
                int max = Parameters.Value<int?>("max_elements") ?? 100000;
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var cats = Categories(doc, Parameters["categories"] as JArray);
                    var materials = new Dictionary<long, Sum>();
                    var assemblies = new Dictionary<string, (string cat, string type, string mat, double vol, int n)>();
                    var unmeasured = new Dictionary<string, int>();
                    int read = 0;
                    bool capped = false;
                    var collector = new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats)).WhereElementIsNotElementType();
                    foreach (Element e in collector)
                    {
                        if (read >= max) { capped = true; break; }
                        read++;
                        string cat = e.Category?.Name ?? "";
                        string type = FmcGap.NameOf(doc, e.GetTypeId());
                        ICollection<ElementId> ids;
                        try { ids = e.GetMaterialIds(false); } catch (Exception) { ids = new List<ElementId>(); }
                        bool any = false;
                        foreach (ElementId mid in ids)
                        {
                            double vol = 0, area = 0;
                            try { vol = e.GetMaterialVolume(mid) * FmcGap.Ft3ToM3; } catch (Exception) { /* no volume for this material */ }
                            try { area = e.GetMaterialArea(mid, false) * FmcGap.Ft2ToM2; } catch (Exception) { /* no area for this material */ }
                            if (vol <= 0 && area <= 0) continue;
                            any = true;
                            if (!materials.TryGetValue(mid.Value, out Sum s))
                            {
                                var m = doc.GetElement(mid) as Material;
                                materials[mid.Value] = s = new Sum { Name = m?.Name ?? "", Class = m?.MaterialClass ?? "" };
                            }
                            s.Volume += vol;
                            s.Area += area;
                            s.Elements++;
                            string k = cat + "\u0001" + type + "\u0001" + s.Name;
                            assemblies.TryGetValue(k, out var a);
                            assemblies[k] = (cat, type, s.Name, a.vol + vol, a.n + 1);
                        }
                        if (!any) unmeasured[cat] = (unmeasured.TryGetValue(cat, out int n) ? n : 0) + 1;
                    }
                    var matRows = new JArray(materials.Select(kv => new JObject
                    {
                        ["id"] = kv.Key.ToString(), ["name"] = kv.Value.Name, ["class"] = kv.Value.Class,
                        ["volume_m3"] = Math.Round(kv.Value.Volume, 4), ["area_m2"] = Math.Round(kv.Value.Area, 3), ["elements"] = kv.Value.Elements,
                    }));
                    var asmRows = new JArray(assemblies.Values.Select(a => new JObject
                    {
                        ["category"] = a.cat, ["type"] = a.type, ["material"] = a.mat, ["volume_m3"] = Math.Round(a.vol, 4), ["elements"] = a.n,
                    }));
                    var un = new JObject();
                    foreach (var kv in unmeasured) un[kv.Key] = kv.Value;
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["revit_version"] = app.Application.VersionNumber ?? "",
                        ["materials"] = matRows,
                        ["assemblies"] = asmRows,
                        ["unmeasured"] = un,
                        ["elements_read"] = read,
                        ["capped"] = capped,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static List<BuiltInCategory> Categories(Document doc, JArray names)
        {
            var wanted = (names ?? new JArray()).Select(n => n.ToString().Trim()).Where(n => n.Length > 0).ToList();
            if (wanted.Count == 0) return Defaults.ToList();
            var list = new List<BuiltInCategory>();
            foreach (Category c in doc.Settings.Categories)
                if (c != null && c.CategoryType == CategoryType.Model && wanted.Any(w => string.Equals(w, c.Name, StringComparison.OrdinalIgnoreCase)))
                    list.Add((BuiltInCategory)c.Id.Value);
            if (list.Count == 0) throw new InvalidOperationException("[FMC-CARBON-CATEGORIES] None of the categories is a model category in this document.");
            return list;
        }
    }
}
