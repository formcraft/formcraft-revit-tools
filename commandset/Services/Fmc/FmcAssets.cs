using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_assets_read (gap-analysis proposal 20): what a COBie-style asset register needs from the model. The project
    /// information (Facility), rooms and MEP spaces (Space), the element types in use (Type), the family instances of the
    /// named categories (Component) and the MEP systems (System). Read-only: no transaction, nothing saved, no file
    /// written. The server shapes the sheets and returns them inline.
    /// </summary>
    public class FmcAssetsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double SqFtToSqM = 0.09290304;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft asset register read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_assets needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    List<string> categories = FmcPhaseIds.Strings(Parameters["categories"] as JArray);
                    List<string> typeParams = FmcPhaseIds.Strings(Parameters["type_parameters"] as JArray);
                    List<string> componentParams = FmcPhaseIds.Strings(Parameters["component_parameters"] as JArray);
                    int max = Math.Max(1, Math.Min(200000, Parameters.Value<int?>("max_elements") ?? 20000));
                    var unknown = new JArray();
                    var types = new Dictionary<long, JObject>();
                    JArray components = Components(doc, categories, componentParams, typeParams, max, types, unknown, out bool truncated);
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_family"] = doc.IsFamilyDocument,
                        ["is_workshared"] = doc.IsWorkshared,
                        ["revit_version"] = app.Application.VersionNumber ?? "",
                        ["facility"] = Facility(doc),
                        ["spaces"] = Spaces(doc),
                        ["types"] = new JArray(types.Values),
                        ["components"] = components,
                        ["systems"] = Systems(doc),
                        ["unknown_categories"] = unknown,
                        ["truncated"] = truncated,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject Facility(Document doc)
        {
            ProjectInfo info = doc.ProjectInformation;
            string site = "";
            try { site = doc.SiteLocation?.PlaceName ?? ""; } catch (Exception) { }
            return new JObject
            {
                ["project_name"] = info?.Name ?? "",
                ["project_number"] = info?.Number ?? "",
                ["building_name"] = info?.BuildingName ?? "",
                ["client_name"] = info?.ClientName ?? "",
                ["address"] = info?.Address ?? "",
                ["status"] = info?.Status ?? "",
                ["site_name"] = site,
                ["unique_id"] = info?.UniqueId ?? "",
            };
        }

        private static JArray Spaces(Document doc)
        {
            var rows = new JArray();
            foreach (BuiltInCategory bic in new[] { BuiltInCategory.OST_Rooms, BuiltInCategory.OST_MEPSpaces })
            {
                IList<Element> found;
                try { found = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().ToElements(); }
                catch (Exception) { continue; }
                foreach (SpatialElement s in found.OfType<SpatialElement>())
                {
                    double area = 0;
                    try { area = s.Area * SqFtToSqM; } catch (Exception) { }
                    rows.Add(new JObject
                    {
                        ["id"] = s.Id.Value.ToString(),
                        ["unique_id"] = s.UniqueId ?? "",
                        ["kind"] = bic == BuiltInCategory.OST_Rooms ? "room" : "space",
                        ["number"] = s.Number ?? "",
                        ["name"] = s.Name ?? "",
                        ["level"] = s.Level?.Name ?? "",
                        ["area_m2"] = Math.Round(area, 3),
                        ["placed"] = s.Location != null,
                        ["department"] = Value(s.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)),
                    });
                }
            }
            return rows;
        }

        private static JArray Components(Document doc, List<string> categories, List<string> names, List<string> typeNames, int max,
            Dictionary<long, JObject> types, JArray unknown, out bool truncated)
        {
            truncated = false;
            var rows = new JArray();
            foreach (string name in categories)
            {
                if (!Enum.TryParse(name, true, out BuiltInCategory bic)) { unknown.Add(name); continue; }
                IList<Element> found;
                try { found = new FilteredElementCollector(doc).OfCategory(bic).OfClass(typeof(FamilyInstance)).WhereElementIsNotElementType().ToElements(); }
                catch (Exception) { unknown.Add(name); continue; }
                foreach (FamilyInstance e in found.OfType<FamilyInstance>())
                {
                    if (e.Category == null || e.ViewSpecific) continue;
                    if (e.SuperComponent != null) continue; // nested parts are not assets of their own
                    if (rows.Count >= max) { truncated = true; continue; }
                    ElementType type = doc.GetElement(e.GetTypeId()) as ElementType;
                    if (type != null && !types.ContainsKey(type.Id.Value)) types[type.Id.Value] = TypeRow(type, bic, typeNames);
                    if (type != null) types[type.Id.Value]["count"] = (types[type.Id.Value].Value<int?>("count") ?? 0) + 1;
                    var values = new JObject();
                    foreach (string param in names)
                    {
                        Parameter p = e.LookupParameter(param);
                        if (p != null) values[param] = Value(p);
                    }
                    rows.Add(new JObject
                    {
                        ["id"] = e.Id.Value.ToString(),
                        ["unique_id"] = e.UniqueId ?? "",
                        ["category"] = bic.ToString(),
                        ["category_name"] = e.Category.Name ?? "",
                        ["type_id"] = type?.Id.Value.ToString() ?? "",
                        ["family"] = type?.FamilyName ?? "",
                        ["type"] = type?.Name ?? "",
                        ["level"] = LevelOf(doc, e),
                        ["mark"] = Value(e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)),
                        ["space"] = SpaceOf(e),
                        ["values"] = values,
                    });
                }
            }
            return rows;
        }

        private static JObject TypeRow(ElementType type, BuiltInCategory bic, List<string> names)
        {
            var values = new JObject();
            foreach (string param in names)
            {
                Parameter p = type.LookupParameter(param);
                if (p != null) values[param] = Value(p);
            }
            return new JObject
            {
                ["id"] = type.Id.Value.ToString(),
                ["unique_id"] = type.UniqueId ?? "",
                ["category"] = bic.ToString(),
                ["family"] = type.FamilyName ?? "",
                ["type"] = type.Name ?? "",
                ["manufacturer"] = Value(type.get_Parameter(BuiltInParameter.ALL_MODEL_MANUFACTURER)),
                ["model"] = Value(type.get_Parameter(BuiltInParameter.ALL_MODEL_MODEL)),
                ["description"] = Value(type.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION)),
                ["type_mark"] = Value(type.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK)),
                ["assembly_code"] = Value(type.get_Parameter(BuiltInParameter.UNIFORMAT_CODE)),
                ["omniclass"] = Value(type.get_Parameter(BuiltInParameter.OMNICLASS_CODE)),
                ["values"] = values,
                ["count"] = 0,
            };
        }

        private static string LevelOf(Document doc, Element e)
        {
            try
            {
                if (e.LevelId != null && e.LevelId != ElementId.InvalidElementId) return doc.GetElement(e.LevelId)?.Name ?? "";
                Parameter p = e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM) ?? e.get_Parameter(BuiltInParameter.SCHEDULE_LEVEL_PARAM);
                return Value(p);
            }
            catch (Exception) { return ""; }
        }

        /// <summary>The room, else the MEP space, the instance is in (Revit's last phase). Empty when it is in neither.</summary>
        private static string SpaceOf(FamilyInstance e)
        {
            try { if (e.Room != null) return e.Room.Number ?? ""; } catch (Exception) { }
            try { if (e.Space != null) return e.Space.Number ?? ""; } catch (Exception) { }
            return "";
        }

        private static JArray Systems(Document doc)
        {
            var rows = new JArray();
            IList<Element> found;
            try { found = new FilteredElementCollector(doc).OfClass(typeof(MEPSystem)).WhereElementIsNotElementType().ToElements(); }
            catch (Exception) { return rows; }
            foreach (MEPSystem sys in found.OfType<MEPSystem>())
            {
                var ids = new JArray();
                try
                {
                    ElementSet members = sys.Elements;
                    if (members != null) foreach (Element m in members) if (m != null) ids.Add(m.Id.Value.ToString());
                }
                catch (Exception) { }
                rows.Add(new JObject
                {
                    ["id"] = sys.Id.Value.ToString(),
                    ["unique_id"] = sys.UniqueId ?? "",
                    ["name"] = sys.Name ?? "",
                    ["classification"] = Value(sys.get_Parameter(BuiltInParameter.RBS_SYSTEM_CLASSIFICATION_PARAM)),
                    ["system_type"] = doc.GetElement(sys.GetTypeId())?.Name ?? "",
                    ["element_ids"] = ids,
                });
            }
            return rows;
        }

        private static string Value(Parameter p)
        {
            if (p == null || !p.HasValue) return "";
            try
            {
                switch (p.StorageType)
                {
                    case StorageType.String: return p.AsString() ?? "";
                    case StorageType.ElementId: return p.AsValueString() ?? "";
                    default: return p.AsValueString() ?? p.AsString() ?? "";
                }
            }
            catch (Exception) { return ""; }
        }
    }
}
