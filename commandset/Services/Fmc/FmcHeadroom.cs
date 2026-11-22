using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Clear headroom over stairs, corridors and rooms. Read-only.
    /// Nothing is started, nothing is rolled back, and a missing 3D view is not created.
    /// ReferenceIntersector runs only when a 3D view already exists. Otherwise bounding boxes are returned.
    /// </summary>
    public class FmcHeadroomHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const int ZoneCap = 2000;
        private const int ObstacleCap = 8000;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft headroom";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_headroom needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var levels = new HashSet<string>(StringComparison.OrdinalIgnoreCase);
                    foreach (JToken token in Parameters["levels"] as JArray ?? new JArray())
                        if (!string.IsNullOrWhiteSpace(token.ToString())) levels.Add(token.ToString().Trim());
                    bool host = Wants(Parameters["sources"] as JArray, "host");
                    bool links = Wants(Parameters["sources"] as JArray, "link");
                    View3D view = Find3D(doc);
                    ReferenceIntersector ray = null;
                    if (view != null)
                    {
                        ray = new ReferenceIntersector(new ElementMulticategoryFilter(ObstacleCategories()), FindReferenceTarget.Element, view);
                        ray.FindReferencesInRevitLinks = links;
                    }
                    var notes = new JArray();
                    if (view == null) notes.Add("No 3D view is in the model. ReferenceIntersector needs one, and none was created. Clearance is from bounding boxes.");
                    var zones = new JArray();
                    var obstacles = new JArray();
                    var unloaded = new JArray();
                    bool zonesCut = false;
                    bool obstaclesCut = false;
                    if (host) Collect(doc, doc, Transform.Identity, "host", "", levels, ray, zones, obstacles, ref zonesCut, ref obstaclesCut);
                    if (links)
                    {
                        foreach (RevitLinkInstance link in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
                        {
                            Document linked = link.GetLinkDocument();
                            if (linked == null) { unloaded.Add(link.Name ?? ""); continue; }
                            Collect(doc, linked, link.GetTotalTransform(), "link", link.Name ?? "", levels, ray, zones, obstacles, ref zonesCut, ref obstaclesCut);
                        }
                    }
                    if (zonesCut) notes.Add("Zone list stopped at " + ZoneCap + ".");
                    if (obstaclesCut) notes.Add("Obstacle list stopped at " + ObstacleCap + ".");
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["applied"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["method"] = view == null ? "bbox" : "ray",
                        ["view3d"] = view == null ? "" : view.Name,
                        ["notes"] = notes,
                        ["unloaded_links"] = unloaded,
                        ["zones"] = zones,
                        ["obstacles"] = obstacles,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static void Collect(Document host, Document source, Transform toHost, string side, string linkName, HashSet<string> levels, ReferenceIntersector ray, JArray zones, JArray obstacles, ref bool zonesCut, ref bool obstaclesCut)
        {
            foreach (Element element in new FilteredElementCollector(source).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType())
            {
                if (zones.Count >= ZoneCap) { zonesCut = true; break; }
                if (!(element is Room room)) continue;
                BoundingBoxXYZ box = room.get_BoundingBox(null);
                if (box == null) continue;
                string level = LevelName(source, room.LevelId);
                if (!LevelOk(levels, level)) continue;
                double floor = (LevelElevation(source, room.LevelId) ?? box.Min.Z) + room.BaseOffset;
                string kind = Corridor(room) ? "corridor" : "room";
                zones.Add(ZoneRow(host, room, box, toHost, side, linkName, kind, level, floor, ray, false));
            }
            foreach (Element element in new FilteredElementCollector(source).OfCategory(BuiltInCategory.OST_Stairs).WhereElementIsNotElementType())
            {
                if (zones.Count >= ZoneCap) { zonesCut = true; break; }
                string level = StairLevel(source, element);
                if (!LevelOk(levels, level)) continue;
                if (element is Stairs stair && stair.GetStairsRuns().Count > 0)
                {
                    foreach (ElementId runId in stair.GetStairsRuns())
                    {
                        if (zones.Count >= ZoneCap) { zonesCut = true; break; }
                        Element run = source.GetElement(runId);
                        BoundingBoxXYZ box = run?.get_BoundingBox(null);
                        if (box == null) continue;
                        zones.Add(ZoneRow(host, run, box, toHost, side, linkName, "stair", level, box.Min.Z, ray, true));
                    }
                }
                else
                {
                    BoundingBoxXYZ box = element.get_BoundingBox(null);
                    if (box == null) continue;
                    zones.Add(ZoneRow(host, element, box, toHost, side, linkName, "stair", level, box.Min.Z, ray, true));
                }
            }
            foreach (BuiltInCategory category in ObstacleCategories())
            {
                foreach (Element element in new FilteredElementCollector(source).OfCategory(category).WhereElementIsNotElementType())
                {
                    if (obstacles.Count >= ObstacleCap) { obstaclesCut = true; return; }
                    string kind = KindOf(element);
                    if (kind.Length == 0) continue;
                    BoundingBoxXYZ box = element.get_BoundingBox(null);
                    if (box == null || !WorldBox(box, toHost, out XYZ min, out XYZ max)) continue;
                    obstacles.Add(new JObject
                    {
                        ["id"] = element.Id.Value.ToString(),
                        ["kind"] = kind,
                        ["name"] = element.Name ?? "",
                        ["source"] = side,
                        ["link"] = linkName,
                        ["min"] = Triple(min),
                        ["max"] = Triple(max),
                    });
                }
            }
        }

        private static JObject ZoneRow(Document host, Element element, BoundingBoxXYZ box, Transform toHost, string side, string linkName, string kind, string level, double floorZ, ReferenceIntersector ray, bool slope)
        {
            WorldBox(box, toHost, out XYZ min, out XYZ max);
            double floor = toHost.OfPoint(new XYZ(0, 0, floorZ)).Z;
            var samples = new JArray();
            if (ray != null)
            {
                var seen = new Dictionary<string, JObject>();
                foreach (XYZ point in SamplePoints(box, slope))
                {
                    double walking = slope ? point.Z : floorZ;
                    XYZ origin = toHost.OfPoint(new XYZ(point.X, point.Y, walking));
                    origin = new XYZ(origin.X, origin.Y, origin.Z + 0.03);
                    IList<ReferenceWithContext> hits = ray.Find(origin, XYZ.BasisZ);
                    if (hits == null) continue;
                    foreach (ReferenceWithContext hit in hits.OrderBy(item => item.Proximity))
                    {
                        if (hit.Proximity < 0.03) continue;
                        Reference reference = hit.GetReference();
                        if (reference == null) continue;
                        Element other = Resolve(host, reference);
                        if (other == null) continue;
                        string obstacleKind = KindOf(other);
                        if (obstacleKind.Length == 0) continue;
                        string id = other.Id.Value.ToString();
                        double clear = hit.Proximity * FeetToMm;
                        if (seen.TryGetValue(id, out JObject prior) && prior.Value<double>("clear_mm") <= clear) continue;
                        seen[id] = new JObject
                        {
                            ["x"] = Math.Round(origin.X * FeetToMm, 1),
                            ["y"] = Math.Round(origin.Y * FeetToMm, 1),
                            ["z"] = Math.Round(toHost.OfPoint(new XYZ(0, 0, walking)).Z * FeetToMm, 1),
                            ["clear_mm"] = Math.Round(clear, 1),
                            ["obstacle_id"] = id,
                            ["obstacle_kind"] = obstacleKind,
                        };
                        break;
                    }
                    if (seen.Count >= 8) break;
                }
                foreach (JObject sample in seen.Values) samples.Add(sample);
            }
            return new JObject
            {
                ["id"] = element.Id.Value.ToString(),
                ["kind"] = kind,
                ["name"] = element.Name ?? "",
                ["level"] = level,
                ["source"] = side,
                ["link"] = linkName,
                ["floor_z_mm"] = Math.Round(floor * FeetToMm, 1),
                ["min"] = Triple(min),
                ["max"] = Triple(max),
                ["samples"] = samples,
            };
        }

        private static IEnumerable<XYZ> SamplePoints(BoundingBoxXYZ box, bool slope)
        {
            double x0 = box.Min.X, x1 = box.Max.X, y0 = box.Min.Y, y1 = box.Max.Y;
            if (!slope)
            {
                double dx = (x1 - x0) * 0.2, dy = (y1 - y0) * 0.2;
                yield return new XYZ((x0 + x1) / 2, (y0 + y1) / 2, box.Min.Z);
                yield return new XYZ(x0 + dx, y0 + dy, box.Min.Z);
                yield return new XYZ(x1 - dx, y0 + dy, box.Min.Z);
                yield return new XYZ(x0 + dx, y1 - dy, box.Min.Z);
                yield return new XYZ(x1 - dx, y1 - dy, box.Min.Z);
                yield break;
            }
            bool alongX = Math.Abs(x1 - x0) >= Math.Abs(y1 - y0);
            for (int i = 0; i < 3; i++)
            {
                double t = (i + 1) / 4.0;
                double z = box.Min.Z + (box.Max.Z - box.Min.Z) * t;
                yield return alongX
                    ? new XYZ(x0 + (x1 - x0) * t, (y0 + y1) / 2, z)
                    : new XYZ((x0 + x1) / 2, y0 + (y1 - y0) * t, z);
            }
        }

        private static Element Resolve(Document host, Reference reference)
        {
            ElementId linked = reference.LinkedElementId;
            if (linked != null && linked != ElementId.InvalidElementId)
            {
                var instance = host.GetElement(reference.ElementId) as RevitLinkInstance;
                return instance?.GetLinkDocument()?.GetElement(linked);
            }
            return host.GetElement(reference.ElementId);
        }

        private static List<BuiltInCategory> ObstacleCategories() => new List<BuiltInCategory>
        {
            BuiltInCategory.OST_StructuralFraming,
            BuiltInCategory.OST_DuctCurves, BuiltInCategory.OST_FlexDuctCurves, BuiltInCategory.OST_DuctFitting,
            BuiltInCategory.OST_PipeCurves, BuiltInCategory.OST_FlexPipeCurves, BuiltInCategory.OST_PipeFitting,
            BuiltInCategory.OST_Ceilings, BuiltInCategory.OST_Floors, BuiltInCategory.OST_GenericModel,
        };

        private static string KindOf(Element element)
        {
            if (element?.Category == null) return "";
            long id = element.Category.Id.Value;
            if (id == (long)BuiltInCategory.OST_StructuralFraming)
            {
                if (element is FamilyInstance instance && (instance.StructuralType == StructuralType.Column || instance.StructuralType == StructuralType.Footing)) return "";
                return "beam";
            }
            if (id == (long)BuiltInCategory.OST_DuctCurves || id == (long)BuiltInCategory.OST_FlexDuctCurves || id == (long)BuiltInCategory.OST_DuctFitting) return "duct";
            if (id == (long)BuiltInCategory.OST_PipeCurves || id == (long)BuiltInCategory.OST_FlexPipeCurves || id == (long)BuiltInCategory.OST_PipeFitting) return "pipe";
            if (id == (long)BuiltInCategory.OST_Ceilings) return "soffit";
            if (id == (long)BuiltInCategory.OST_Floors) return "soffit";
            if (id == (long)BuiltInCategory.OST_GenericModel && (element.Name ?? "").IndexOf("soffit", StringComparison.OrdinalIgnoreCase) >= 0) return "soffit";
            return "";
        }

        private static bool Corridor(Room room)
        {
            string blob = (room.Name ?? "") + " " + (room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "") + " " + (room.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)?.AsString() ?? "");
            return System.Text.RegularExpressions.Regex.IsMatch(blob, "corridor|circulation|hallway|passage|concourse", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        }

        private static string StairLevel(Document doc, Element stair)
        {
            Parameter parameter = stair.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL_PARAM);
            if (parameter == null || parameter.StorageType != StorageType.ElementId) return "";
            return LevelName(doc, parameter.AsElementId());
        }

        private static string LevelName(Document doc, ElementId id)
        {
            return doc.GetElement(id) is Level level ? level.Name ?? "" : "";
        }

        private static double? LevelElevation(Document doc, ElementId id)
        {
            return doc.GetElement(id) is Level level ? level.Elevation : null;
        }

        private static bool LevelOk(HashSet<string> levels, string name)
        {
            if (levels.Count == 0) return true;
            return levels.Contains(name ?? "");
        }

        private static bool Wants(JArray sources, string name)
        {
            if (sources == null || sources.Count == 0) return true;
            return sources.Any(token => string.Equals(token.ToString(), name, StringComparison.OrdinalIgnoreCase));
        }

        private static View3D Find3D(Document doc)
        {
            var views = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().Where(v => !v.IsTemplate).ToList();
            return views.FirstOrDefault(v => !v.IsPerspective) ?? views.FirstOrDefault();
        }

        private static bool WorldBox(BoundingBoxXYZ box, Transform toHost, out XYZ min, out XYZ max)
        {
            min = max = null;
            if (box == null) return false;
            var corners = new[]
            {
                new XYZ(box.Min.X, box.Min.Y, box.Min.Z), new XYZ(box.Max.X, box.Min.Y, box.Min.Z),
                new XYZ(box.Min.X, box.Max.Y, box.Min.Z), new XYZ(box.Max.X, box.Max.Y, box.Min.Z),
                new XYZ(box.Min.X, box.Min.Y, box.Max.Z), new XYZ(box.Max.X, box.Min.Y, box.Max.Z),
                new XYZ(box.Min.X, box.Max.Y, box.Max.Z), new XYZ(box.Max.X, box.Max.Y, box.Max.Z),
            };
            bool any = false;
            foreach (XYZ corner in corners)
            {
                XYZ world = toHost.OfPoint(corner);
                if (!any) { min = max = world; any = true; }
                else
                {
                    min = new XYZ(Math.Min(min.X, world.X), Math.Min(min.Y, world.Y), Math.Min(min.Z, world.Z));
                    max = new XYZ(Math.Max(max.X, world.X), Math.Max(max.Y, world.Y), Math.Max(max.Z, world.Z));
                }
            }
            return any;
        }

        private static JArray Triple(XYZ point) => new JArray { Math.Round(point.X * FeetToMm, 1), Math.Round(point.Y * FeetToMm, 1), Math.Round(point.Z * FeetToMm, 1) };
    }
}
