using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Analysis;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The energy analytical model report for fmc_energy mode analytical (GAP-23). Read-only: no transaction, the energy
    /// analytical model is read when it exists and is never created, nothing is written. Every call that changed between
    /// Revit versions is wrapped, and EnergyDataSettings is read by property name so a property Revit 2025 does not have is
    /// simply left out. The findings are drawn in the server (server/src/fmc/energyexport.ts analyticalFindings).
    /// </summary>
    public static class FmcEnergyAnalytical
    {
        private const double FeetToMm = 304.8;
        private const double SqFtToM2 = 0.09290304;
        private const int IdSample = 20;

        private static readonly string[] SettingNames =
        {
            "AnalysisType", "BuildingType", "BuildingServiceType", "BuildingConstructionClass", "BuildingOperatingSchedule",
            "ExportCategory", "ExportComplexity", "ExportDefaults", "GroundPlane", "ProjectPhase", "SliverSpaceTolerance",
            "AnalyticalSpaceResolution", "AnalyticalSurfaceResolution", "CoreOffset", "DividePerimeter", "IsGlazingShaded",
            "PercentageGlazing", "PercentageSkylights", "UseThermalProperties", "IncludeThermalProperties", "EnergyModel",
        };

        private static readonly HashSet<string> InteriorSurfaceTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "InteriorWall", "Ceiling", "InteriorFloor", "Air",
        };

        public static JObject Report(Document doc)
        {
            var report = new JObject();
            var errors = new JArray();
            report["settings"] = Settings(doc, errors);
            report["location"] = Location(doc, errors);
            try { report["levels"] = new FilteredElementCollector(doc).OfClass(typeof(Level)).GetElementCount(); }
            catch (Exception ex) { errors.Add("levels: " + ex.Message); }
            report["rooms"] = Spatial(doc, BuiltInCategory.OST_Rooms, errors);
            report["spaces"] = Spatial(doc, BuiltInCategory.OST_MEPSpaces, errors);
            report["model"] = Model(doc, errors);
            report["warnings"] = Warnings(doc, errors);
            report["errors"] = errors;
            return report;
        }

        private static JObject Settings(Document doc, JArray errors)
        {
            var s = new JObject();
            EnergyDataSettings e = null;
            try { e = EnergyDataSettings.GetFromDocument(doc); }
            catch (Exception ex) { errors.Add("EnergyDataSettings: " + ex.Message); }
            if (e == null) { s["present"] = false; return s; }
            s["present"] = true;
            foreach (string name in SettingNames)
            {
                try
                {
                    PropertyInfo pi = e.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                    if (pi == null || pi.GetIndexParameters().Length > 0) continue;
                    s[Snake(name)] = Value(doc, pi.GetValue(e));
                }
                catch (Exception ex) { errors.Add("EnergyDataSettings." + name + ": " + (ex.InnerException ?? ex).Message); }
            }
            try
            {
                PropertyInfo gp = e.GetType().GetProperty("GroundPlane");
                ElementId id = gp?.GetValue(e) as ElementId;
                s["ground_plane_missing"] = id == null || id == ElementId.InvalidElementId || !(doc.GetElement(id) is Level);
            }
            catch (Exception) { }
            return s;
        }

        private static JToken Value(Document doc, object v)
        {
            if (v == null) return JValue.CreateNull();
            if (v is ElementId id)
            {
                if (id == ElementId.InvalidElementId) return JValue.CreateNull();
                Element el = doc.GetElement(id);
                return new JObject { ["id"] = id.Value.ToString(), ["name"] = el?.Name ?? "" };
            }
            if (v is bool b) return b;
            if (v is int i) return i;
            if (v is double d) return Math.Round(d, 6);
            if (v is string str) return str;
            if (v is Enum) return v.ToString();
            return v.ToString();
        }

        private static JObject Location(Document doc, JArray errors)
        {
            var o = new JObject();
            try
            {
                SiteLocation site = doc.SiteLocation;
                if (site != null)
                {
                    o["place"] = site.PlaceName ?? "";
                    o["latitude_deg"] = Math.Round(site.Latitude * 180 / Math.PI, 6);
                    o["longitude_deg"] = Math.Round(site.Longitude * 180 / Math.PI, 6);
                    o["time_zone"] = site.TimeZone;
                    o["elevation_mm"] = Math.Round(site.Elevation * FeetToMm, 1);
                }
            }
            catch (Exception ex) { errors.Add("SiteLocation: " + ex.Message); }
            try
            {
                ProjectPosition pos = doc.ActiveProjectLocation?.GetProjectPosition(XYZ.Zero);
                if (pos != null)
                {
                    o["true_north_angle_rad"] = Math.Round(pos.Angle, 6);
                    o["shared_east_west_mm"] = Math.Round(pos.EastWest * FeetToMm, 1);
                    o["shared_north_south_mm"] = Math.Round(pos.NorthSouth * FeetToMm, 1);
                    o["shared_elevation_mm"] = Math.Round(pos.Elevation * FeetToMm, 1);
                }
            }
            catch (Exception ex) { errors.Add("ProjectPosition: " + ex.Message); }
            try
            {
                BasePoint pbp = BasePoint.GetProjectBasePoint(doc);
                if (pbp != null) o["project_base_point"] = new JObject { ["position_mm"] = Vec(pbp.Position), ["shared_mm"] = Vec(pbp.SharedPosition) };
                BasePoint sp = BasePoint.GetSurveyPoint(doc);
                if (sp != null) o["survey_point"] = new JObject { ["position_mm"] = Vec(sp.Position), ["shared_mm"] = Vec(sp.SharedPosition) };
            }
            catch (Exception ex) { errors.Add("BasePoint: " + ex.Message); }
            return o;
        }

        private static JObject Spatial(Document doc, BuiltInCategory bic, JArray errors)
        {
            var o = new JObject();
            int placed = 0, notPlaced = 0, unbounded = 0, missingLevel = 0;
            double area = 0;
            var notPlacedIds = new JArray(); var unboundedIds = new JArray(); var missingLevelIds = new JArray();
            try
            {
                foreach (SpatialElement se in new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().OfType<SpatialElement>())
                {
                    string id = se.Id.Value.ToString();
                    bool hasLevel = se.LevelId != null && se.LevelId != ElementId.InvalidElementId && doc.GetElement(se.LevelId) is Level;
                    if (!hasLevel) { missingLevel++; if (missingLevelIds.Count < IdSample) missingLevelIds.Add(id); }
                    if (se.Location == null) { notPlaced++; if (notPlacedIds.Count < IdSample) notPlacedIds.Add(id); continue; }
                    if (se.Area <= 0) { unbounded++; if (unboundedIds.Count < IdSample) unboundedIds.Add(id); continue; }
                    placed++;
                    area += se.Area * SqFtToM2;
                }
            }
            catch (Exception ex) { errors.Add(bic + ": " + ex.Message); }
            o["placed"] = placed;
            o["placed_area_m2"] = Math.Round(area, 2);
            o["not_placed"] = notPlaced;
            o["not_placed_ids"] = notPlacedIds;
            o["unbounded"] = unbounded;
            o["unbounded_ids"] = unboundedIds;
            o["missing_level"] = missingLevel;
            o["missing_level_ids"] = missingLevelIds;
            return o;
        }

        private static JObject Model(Document doc, JArray errors)
        {
            var o = new JObject();
            EnergyAnalysisDetailModel m = null;
            try { m = EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc); }
            catch (Exception ex) { errors.Add("GetMainEnergyAnalysisDetailModel: " + ex.Message); }
            o["exists"] = m != null;
            if (m == null) return o;
            o["id"] = m.Id.Value.ToString();
            try { o["spaces"] = m.GetAnalyticalSpaces().Count; } catch (Exception ex) { errors.Add("GetAnalyticalSpaces: " + ex.Message); }
            try { o["openings"] = m.GetAnalyticalOpenings().Count; } catch (Exception ex) { errors.Add("GetAnalyticalOpenings: " + ex.Message); }
            try { o["shading_surfaces"] = m.GetAnalyticalShadingSurfaces().Count; } catch (Exception ex) { errors.Add("GetAnalyticalShadingSurfaces: " + ex.Message); }
            try
            {
                MethodInfo zones = m.GetType().GetMethod("GetAnalyticalZones", Type.EmptyTypes);
                if (zones != null && zones.Invoke(m, null) is System.Collections.ICollection z) o["zones"] = z.Count;
            }
            catch (Exception ex) { errors.Add("GetAnalyticalZones: " + (ex.InnerException ?? ex).Message); }
            try
            {
                IList<EnergyAnalysisSurface> surfaces = m.GetAnalyticalSurfaces();
                var types = new JObject();
                int noSpace = 0, interiorNoAdjacent = 0;
                var noSpaceIds = new JArray(); var noAdjacentIds = new JArray();
                foreach (EnergyAnalysisSurface s in surfaces)
                {
                    string type = "";
                    try { type = s.SurfaceType.ToString(); } catch (Exception) { }
                    types[type] = (types.Value<int?>(type) ?? 0) + 1;
                    EnergyAnalysisSpace own = null, other = null;
                    try { own = s.GetAnalyticalSpace(); } catch (Exception) { }
                    try { other = s.GetAdjacentAnalyticalSpace(); } catch (Exception) { }
                    if (own == null && type != "Shade") { noSpace++; if (noSpaceIds.Count < IdSample) noSpaceIds.Add(s.Id.Value.ToString()); }
                    if (InteriorSurfaceTypes.Contains(type) && other == null) { interiorNoAdjacent++; if (noAdjacentIds.Count < IdSample) noAdjacentIds.Add(s.Id.Value.ToString()); }
                }
                o["surfaces"] = surfaces.Count;
                o["surface_types"] = types;
                o["surfaces_no_space"] = noSpace;
                o["surfaces_no_space_ids"] = noSpaceIds;
                o["interior_no_adjacent"] = interiorNoAdjacent;
                o["interior_no_adjacent_ids"] = noAdjacentIds;
            }
            catch (Exception ex) { errors.Add("GetAnalyticalSurfaces: " + ex.Message); }
            return o;
        }

        private static JObject Warnings(Document doc, JArray errors)
        {
            var o = new JObject();
            var byText = new Dictionary<string, int>();
            int count = 0;
            try
            {
                foreach (FailureMessage w in doc.GetWarnings())
                {
                    string text = w.GetDescriptionText() ?? "";
                    string low = text.ToLowerInvariant();
                    if (!(low.Contains("room") || low.Contains("space") || low.Contains("bound") || low.Contains("energy") || low.Contains("analytic") || low.Contains("level"))) continue;
                    count++;
                    byText[text] = byText.TryGetValue(text, out int n) ? n + 1 : 1;
                }
            }
            catch (Exception ex) { errors.Add("GetWarnings: " + ex.Message); }
            o["count"] = count;
            var top = new JArray();
            foreach (var pair in byText.OrderByDescending(p => p.Value).Take(15)) top.Add(new JObject { ["text"] = pair.Key, ["count"] = pair.Value });
            o["top"] = top;
            return o;
        }

        private static string Snake(string name)
        {
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                if (char.IsUpper(c) && i > 0) sb.Append('_');
                sb.Append(char.ToLowerInvariant(c));
            }
            return sb.ToString();
        }

        private static JArray Vec(XYZ p) => p == null ? new JArray() : new JArray(Math.Round(p.X * FeetToMm, 1), Math.Round(p.Y * FeetToMm, 1), Math.Round(p.Z * FeetToMm, 1));
    }
}
