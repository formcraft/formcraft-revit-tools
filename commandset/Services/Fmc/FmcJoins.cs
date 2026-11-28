using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One read for fmc_joins. Collectors are scoped by level, category, bounding box, room, space or ids.
    /// An unscoped scan above the cap is refused before geometry is walked.
    /// No transaction, no checkout, no save, and the active view is not switched.
    /// A picture is exported only when images is true.
    /// </summary>
    public class FmcJoinsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft joins";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_joins needs document: a title or a full path. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-JOINS] fmc_joins runs on a project model.");
                    bool images = Parameters.Value<bool?>("images") == true;
                    Result = FmcJoinsRead.Collect(doc, Parameters);
                    Result["read_only"] = true;
                    Result["saved"] = false;
                    Result["is_central"] = FmcPhaseIds.IsCentral(doc);
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    if (images && Result.Value<bool?>("refused") != true)
                    {
                        try { Result["images"] = FmcJoinsRead.Images(app, doc); }
                        catch (Exception ex)
                        {
                            Result["images"] = new JArray();
                            Result["images_reason"] = ex.Message;
                        }
                    }
                    else Result["images"] = new JArray();
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }
    }

    /// <summary>Scoped collectors and the measurements the server classifies. CheckoutElements is never called.</summary>
    internal static class FmcJoinsRead
    {
        private const double Mm = 304.8;

        private static FmcNonFamily Skipped = new FmcNonFamily();

        internal static JObject Collect(Document doc, JObject parameters)
        {
            Skipped = new FmcNonFamily();
            string action = (parameters.Value<string>("action") ?? "audit").Trim().ToLowerInvariant();
            string mode = (parameters.Value<string>("mode") ?? "envelope").Trim().ToLowerInvariant();
            int cap = Math.Max(1, parameters.Value<int?>("scan_cap") ?? 800);
            int maxPairs = Math.Max(1, parameters.Value<int?>("max_pairs") ?? 400);
            double search = Math.Max(1, parameters.Value<double?>("search_mm") ?? 300) / Mm;
            double hostTol = Math.Max(0, parameters.Value<double?>("host_offset_mm") ?? 20) / Mm;
            double resolution = Math.Max(50, parameters.Value<double?>("resolution_mm") ?? 250) / Mm;
            int maxRays = Math.Max(1, Math.Min(96, parameters.Value<int?>("max_rays") ?? 48));
            string category = parameters.Value<string>("category") ?? "";
            bool scoped = Scoped(parameters);
            ElementId level = LevelOf(doc, parameters.Value<string>("level"), out bool levelMissing);
            ElementFilter box = BoxOf(parameters["bbox"] as JObject);
            if (!string.IsNullOrWhiteSpace(parameters.Value<string>("room")) || !string.IsNullOrWhiteSpace(parameters.Value<string>("space")))
            {
                SpatialElement place = FindPlace(doc, parameters.Value<string>("room"), parameters.Value<string>("space"), out bool missing);
                if (missing) return WithSkip(Empty(action, "room_not_found", true));
                if (box == null && place?.get_BoundingBox(null) is BoundingBoxXYZ placeBox)
                    box = new BoundingBoxIntersectsFilter(OutlineOf(placeBox.Min, placeBox.Max, search));
            }
            if (levelMissing) return WithSkip(Empty(action, "level_not_found", true));
            var cats = Categories(action, category);
            int count = Count(doc, cats, level, box, parameters["ids"] as JArray);
            if (!scoped && count > cap)
            {
                return WithSkip(new JObject
                {
                    ["refused"] = true,
                    ["code"] = "FMC-JOINS-SCOPE",
                    ["message"] = "[FMC-JOINS-SCOPE] Name a level, category, bounding box, room, space or element ids. An unscoped scan above the cap is refused.",
                    ["element_count"] = count,
                    ["scoped"] = false,
                });
            }
            bool partial = false;
            var body = new JObject { ["scoped"] = scoped, ["element_count"] = count, ["pairs"] = new JArray(), ["hosts"] = new JArray(), ["rooms"] = new JArray(), ["room_walls"] = new JArray(), ["leaks"] = new JArray() };
            if (action == "audit" || action == "fix")
                body["pairs"] = Pairs(doc, level, box, category, cap, maxPairs, search, parameters["ids"] as JArray, ref partial);
            if (action == "hosting" || action == "fix")
                body["hosts"] = Hosts(doc, level, box, category, Single(category), cap, search, hostTol, parameters["ids"] as JArray, ref partial);
            if (action == "rooms" || (action == "pressure_test" && mode == "rooms"))
            {
                body["rooms"] = Places(doc, level, box, cap, ref partial);
                body["room_walls"] = RoomWalls(doc, level, box, cap, ref partial);
                body["envelope"] = new JObject { ["built"] = true, ["incomplete"] = false, ["capped"] = partial, ["reason"] = "Room and space closure.", ["rays"] = 0, ["voxels"] = 0, ["booleans"] = 0 };
            }
            if (action == "pressure_test" && mode != "rooms")
            {
                JObject pressure = Pressure(doc, level, box, cap, maxPairs, maxRays, search, resolution, ref partial);
                body["leaks"] = pressure["leaks"];
                body["envelope"] = pressure["envelope"];
            }
            body["partial"] = partial;
            return WithSkip(body);
        }

        internal static JArray Images(UIApplication app, Document doc)
        {
            View view = new FilteredElementCollector(doc).OfClass(typeof(View3D)).OfType<View>().FirstOrDefault(v => !v.IsTemplate)
                ?? new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).OfType<View>().FirstOrDefault(v => !v.IsTemplate);
            if (view == null) throw new InvalidOperationException("This document has no view to export.");
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Formcraft", "joins");
            Directory.CreateDirectory(dir);
            string stem = Path.Combine(dir, "joins-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"));
            var options = new ImageExportOptions
            {
                ExportRange = ExportRange.SetOfViews,
                FilePath = stem,
                HLRandWFViewsFileType = ImageFileType.PNG,
                ShadowViewsFileType = ImageFileType.PNG,
                ImageResolution = ImageResolution.DPI_72,
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = 640,
                FitDirection = FitDirectionType.Horizontal,
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });
            FmcImageExport.Export(app, doc, options);
            string file = Directory.GetFiles(dir, Path.GetFileName(stem) + "*.png").FirstOrDefault();
            if (file == null) throw new InvalidOperationException("Revit made no image.");
            return new JArray(new JObject { ["path"] = file });
        }

        private static JObject Empty(string action, string note, bool scoped)
        {
            return new JObject
            {
                ["scoped"] = scoped, ["element_count"] = 0, ["note"] = note, ["partial"] = false,
                ["pairs"] = new JArray(), ["hosts"] = new JArray(), ["rooms"] = new JArray(), ["room_walls"] = new JArray(), ["leaks"] = new JArray(),
            };
        }

        private static bool Scoped(JObject parameters)
        {
            if (!string.IsNullOrWhiteSpace(parameters.Value<string>("level"))) return true;
            if (!string.IsNullOrWhiteSpace(parameters.Value<string>("category"))) return true;
            if (!string.IsNullOrWhiteSpace(parameters.Value<string>("room"))) return true;
            if (!string.IsNullOrWhiteSpace(parameters.Value<string>("space"))) return true;
            if (parameters["bbox"] is JObject) return true;
            return parameters["ids"] is JArray ids && ids.Count > 0;
        }

        private static JArray Pairs(Document doc, ElementId level, ElementFilter box, string category, int cap, int maxPairs, double search, JArray ids, ref bool partial)
        {
            bool curtainOnly = category.IndexOf("curtain", StringComparison.OrdinalIgnoreCase) >= 0;
            var walls = Of<Wall>(doc, BuiltInCategory.OST_Walls, level, box, cap, ids, ref partial)
                .Where(w => curtainOnly ? IsCurtain(w) : Want(w, category)).ToList();
            var floors = Of<Floor>(doc, BuiltInCategory.OST_Floors, level, box, cap, ids, ref partial);
            var roofs = Of<RoofBase>(doc, BuiltInCategory.OST_Roofs, level, box, cap, ids, ref partial);
            var columns = new List<Element>();
            columns.AddRange(Of<Element>(doc, BuiltInCategory.OST_StructuralColumns, level, box, cap, ids, ref partial));
            columns.AddRange(Of<Element>(doc, BuiltInCategory.OST_Columns, level, box, cap, ids, ref partial));
            var framing = Of<Element>(doc, BuiltInCategory.OST_StructuralFraming, level, box, cap, ids, ref partial);
            var stairs = Of<Element>(doc, BuiltInCategory.OST_Stairs, level, box, cap, ids, ref partial);
            var railings = Of<Element>(doc, BuiltInCategory.OST_Railings, level, box, cap, ids, ref partial);
            var edges = Of<Element>(doc, BuiltInCategory.OST_EdgeSlab, level, box, cap, ids, ref partial);
            var pairs = new JArray();
            int n = 0;
            foreach (Wall wall in walls)
            {
                if (n >= maxPairs) { partial = true; break; }
                if (wall.Location is not LocationCurve location) continue;
                bool curtain = IsCurtain(wall);
                BoundingBoxXYZ wallBox = wall.get_BoundingBox(null);
                for (int end = 0; end < 2 && n < maxPairs; end++)
                {
                    bool open = OpenEnd(location, wall, end, out _);
                    XYZ point = location.Curve.GetEndPoint(end);
                    string other = "";
                    double? gap = null;
                    double best = search;
                    foreach (Wall candidate in walls)
                    {
                        if (candidate.Id.Value == wall.Id.Value || candidate.Location is not LocationCurve otherLocation) continue;
                        IntersectionResult hit = otherLocation.Curve.Project(point);
                        if (hit == null) continue;
                        double face = hit.Distance - Half(candidate);
                        if (face < best) { best = face; other = Id(candidate); gap = face; }
                    }
                    double overlap = gap != null && gap.Value < 0 ? -gap.Value : 0;
                    var row = Pair(curtain ? "curtain_wall" : "wall_end", wall, other, end, gap, overlap, !open, open, false, point);
                    Stamp(doc, wall, other.Length == 0 ? null : doc.GetElement(new ElementId(long.Parse(other))), row);
                    pairs.Add(row);
                    n++;
                }
                foreach (Floor floor in floors)
                {
                    if (n >= maxPairs) break;
                    if (!Near(wallBox, floor.get_BoundingBox(null), search)) continue;
                    double? gap = VerticalGap(wallBox, floor.get_BoundingBox(null), true);
                    pairs.Add(Stamped(doc, wall, floor, Pair("wall_floor", wall, Id(floor), null, gap, 0, false, false, Attached(wall, false), Mid(wallBox))));
                    n++;
                }
                foreach (RoofBase roof in roofs)
                {
                    if (n >= maxPairs) break;
                    if (!Near(wallBox, roof.get_BoundingBox(null), search)) continue;
                    double? gap = VerticalGap(wallBox, roof.get_BoundingBox(null), false);
                    pairs.Add(Stamped(doc, wall, roof, Pair("wall_roof", wall, Id(roof), null, gap, 0, false, false, Attached(wall, true), Top(wallBox))));
                    n++;
                }
                n = NearElements(doc, pairs, n, maxPairs, wall, wallBox, columns, "wall_column", search);
                n = NearElements(doc, pairs, n, maxPairs, wall, wallBox, framing, "wall_framing", search);
                if (!curtain) n = Parallel(doc, pairs, n, maxPairs, wall, walls, search);
            }
            foreach (Floor floor in floors)
            {
                if (n >= maxPairs) break;
                BoundingBoxXYZ floorBox = floor.get_BoundingBox(null);
                foreach (Element edge in edges)
                {
                    if (n >= maxPairs) break;
                    BoundingBoxXYZ edgeBox = edge.get_BoundingBox(null);
                    if (!Near(floorBox, edgeBox, search)) continue;
                    double gap = BoxGap(floorBox, edgeBox);
                    pairs.Add(Stamped(doc, floor, edge, Pair("slab_edge", floor, Id(edge), null, gap, gap < 0 ? -gap : 0, false, false, false, Mid(edgeBox))));
                    n++;
                }
                foreach (Wall wall in walls)
                {
                    if (n >= maxPairs) break;
                    BoundingBoxXYZ wallBox = wall.get_BoundingBox(null);
                    if (!Near(floorBox, wallBox, search)) continue;
                    double gap = HorizontalGap(floorBox, wallBox);
                    if (gap <= 0 || gap > search) continue;
                    pairs.Add(Stamped(doc, floor, wall, Pair("floor_edge", floor, Id(wall), null, gap, 0, false, false, false, Mid(floorBox))));
                    n++;
                }
            }
            n = VerticalHosts(doc, pairs, n, maxPairs, stairs, floors, "stair_floor", search);
            VerticalHosts(doc, pairs, n, maxPairs, railings, floors, "railing_floor", search);
            return pairs;
        }

        private static int NearElements(Document doc, JArray pairs, int n, int max, Wall wall, BoundingBoxXYZ wallBox, List<Element> others, string relation, double search)
        {
            foreach (Element other in others)
            {
                if (n >= max) return n;
                BoundingBoxXYZ otherBox = other.get_BoundingBox(null);
                if (!Near(wallBox, otherBox, search)) continue;
                double gap = other.Location is LocationPoint point ? PointGap(wall, point.Point) : BoxGap(wallBox, otherBox);
                pairs.Add(Stamped(doc, wall, other, Pair(relation, wall, Id(other), null, gap, gap < 0 ? -gap : 0, false, false, false, other.Location is LocationPoint lp ? lp.Point : Mid(otherBox))));
                n++;
            }
            return n;
        }

        private static int VerticalHosts(Document doc, JArray pairs, int n, int max, List<Element> items, List<Floor> floors, string relation, double search)
        {
            foreach (Element item in items)
            {
                if (n >= max) return n;
                BoundingBoxXYZ itemBox = item.get_BoundingBox(null);
                Floor floor = floors.FirstOrDefault(candidate => Near(itemBox, candidate.get_BoundingBox(null), search));
                if (floor == null) continue;
                double? gap = itemBox == null || floor.get_BoundingBox(null) == null ? null : (double?)(itemBox.Min.Z - floor.get_BoundingBox(null).Max.Z);
                pairs.Add(Stamped(doc, item, floor, Pair(relation, item, Id(floor), null, gap, 0, false, false, false, Mid(itemBox))));
                n++;
            }
            return n;
        }

        private static int Parallel(Document doc, JArray pairs, int n, int max, Wall wall, List<Wall> walls, double search)
        {
            if (wall.Location is not LocationCurve location || location.Curve is not Line line) return n;
            foreach (Wall other in walls)
            {
                if (n >= max || other.Id.Value == wall.Id.Value) continue;
                if (other.Location is not LocationCurve otherLocation || otherLocation.Curve is not Line otherLine) continue;
                if (Math.Abs(Math.Abs(line.Direction.DotProduct(otherLine.Direction)) - 1) > 1e-3) continue;
                double face = line.Distance(otherLine.GetEndPoint(0)) - Half(wall) - Half(other);
                if (Math.Abs(face) > search) continue;
                double s0 = (otherLine.GetEndPoint(0) - line.GetEndPoint(0)).DotProduct(line.Direction);
                double s1 = (otherLine.GetEndPoint(1) - line.GetEndPoint(0)).DotProduct(line.Direction);
                double lo = Math.Max(0, Math.Min(s0, s1));
                double hi = Math.Min(line.Length, Math.Max(s0, s1));
                if (hi - lo < 1e-4) continue;
                double overlap = face < 0 ? -face : 0;
                pairs.Add(Stamped(doc, wall, other, Pair("wall_wall", wall, Id(other), null, Math.Max(0, face), overlap, false, false, false, line.Evaluate(0.5, true))));
                n++;
            }
            return n;
        }

        private static JArray Hosts(Document doc, ElementId level, ElementFilter box, string category, BuiltInCategory? hostCategory, int cap, double search, double hostTol, JArray ids, ref bool partial)
        {
            var supports = new List<(string id, BoundingBoxXYZ box, Wall wall)>();
            foreach (Wall wall in Of<Wall>(doc, BuiltInCategory.OST_Walls, level, box, cap, null, ref partial))
                supports.Add((Id(wall), wall.get_BoundingBox(null), wall));
            foreach (Floor floor in Of<Floor>(doc, BuiltInCategory.OST_Floors, level, box, cap, null, ref partial))
                supports.Add((Id(floor), floor.get_BoundingBox(null), null));
            var rows = new JArray();
            int seen = 0;
            foreach (FamilyInstance instance in Of<FamilyInstance>(doc, hostCategory, level, box, cap, ids, ref partial))
            {
                if (seen >= cap) { partial = true; break; }
                if (instance.Category == null || !Want(instance, category)) continue;
                long cat = instance.Category.Id.Value;
                bool door = cat == (long)BuiltInCategory.OST_Doors;
                bool window = cat == (long)BuiltInCategory.OST_Windows;
                bool fixture = IsFixture(cat);
                if (!door && !window && !fixture && !string.IsNullOrWhiteSpace(category) && !Want(instance, category)) continue;
                if (!door && !window && !fixture && string.IsNullOrWhiteSpace(category) && !ShouldHost(instance) && ParamMm(instance, BuiltInParameter.INSTANCE_ELEVATION_PARAM) == null)
                    continue;
                XYZ point = (instance.Location as LocationPoint)?.Point;
                Element host = null;
                try { host = instance.Host; } catch (Exception) { host = null; }
                bool outside = false;
                if (host != null && point != null)
                {
                    BoundingBoxXYZ hostBox = host.get_BoundingBox(null);
                    outside = hostBox != null && !Inside(hostBox, point, hostTol);
                }
                bool? cuts = null;
                if ((door || window) && host is Wall wall && point != null) cuts = Cuts(wall, instance, point);
                double? offset = null;
                string flavour = "";
                double? free = ParamMm(instance, BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM);
                double? elev = ParamMm(instance, BuiltInParameter.INSTANCE_ELEVATION_PARAM);
                if (free != null) { offset = free; flavour = "host"; }
                else if (!door && !window && elev != null) { offset = elev; flavour = "level"; }
                var candidates = new JArray();
                XYZ move = null;
                if (host == null && point != null)
                {
                    foreach (var support in supports)
                    {
                        if (support.box == null || !Inside(support.box, point, search) && BoxGap(new BoundingBoxXYZ { Min = point, Max = point }, support.box) > search) continue;
                        candidates.Add(support.id);
                        if (candidates.Count == 1 && support.wall != null && support.wall.Location is LocationCurve curve)
                        {
                            IntersectionResult hit = curve.Curve.Project(point);
                            if (hit != null) move = hit.XYZPoint - point;
                        }
                        if (candidates.Count >= 3) break;
                    }
                }
                string kind = door ? "door" : window ? "window" : fixture ? "fixture" : "family";
                var row = new JObject
                {
                    ["id"] = Id(instance),
                    ["category"] = instance.Category.Name ?? "",
                    ["kind"] = kind,
                    ["host_id"] = host == null ? "" : Id(host),
                    ["host_category"] = host?.Category?.Name ?? "",
                    ["level_id"] = instance.LevelId == null ? "" : instance.LevelId.Value.ToString(),
                    ["offset_mm"] = offset == null ? null : Math.Round(offset.Value, 1),
                    ["float"] = flavour,
                    ["outside"] = outside,
                    ["cuts"] = cuts == null ? (JToken)JValue.CreateNull() : new JValue(cuts.Value),
                    ["touching"] = !fixture || Touches(point, supports, hostTol) == null ? (JToken)JValue.CreateNull() : new JValue(Touches(point, supports, hostTol).Value),
                    ["should_host"] = door || window || ShouldHost(instance),
                    ["candidates"] = candidates,
                    ["xyz"] = MmPoint(point),
                    ["pinned"] = instance.Pinned,
                };
                if (move != null) row["move_mm"] = MmPoint(move);
                Stamp(doc, instance, null, row);
                rows.Add(row);
                seen++;
            }
            if (string.IsNullOrWhiteSpace(category) || category.Contains("floor", StringComparison.OrdinalIgnoreCase) || category.Contains("roof", StringComparison.OrdinalIgnoreCase) || category.Contains("ceiling", StringComparison.OrdinalIgnoreCase))
            {
                void SystemRow(Element element, BuiltInParameter parameter, string name)
                {
                    if (seen >= cap || !Want(element, category)) return;
                    double? offset = ParamMm(element, parameter);
                    if (offset == null || Math.Abs(offset.Value) < 1) return;
                    rows.Add(new JObject
                    {
                        ["id"] = Id(element), ["category"] = name, ["kind"] = "system", ["host_id"] = "", ["float"] = "level",
                        ["offset_mm"] = Math.Round(offset.Value, 1), ["outside"] = false, ["should_host"] = false,
                        ["candidates"] = new JArray(), ["xyz"] = MmPoint(Mid(element.get_BoundingBox(null))), ["pinned"] = element.Pinned,
                        ["cuts"] = JValue.CreateNull(), ["touching"] = JValue.CreateNull(),
                    });
                    seen++;
                }
                foreach (Floor floor in Of<Floor>(doc, BuiltInCategory.OST_Floors, level, box, cap, ids, ref partial))
                    SystemRow(floor, BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM, "Floors");
                foreach (Element ceiling in Of<Element>(doc, BuiltInCategory.OST_Ceilings, level, box, cap, ids, ref partial))
                    SystemRow(ceiling, BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM, "Ceilings");
            }
            return rows;
        }

        private static JArray Places(Document doc, ElementId level, ElementFilter box, int cap, ref bool partial)
        {
            var rows = new JArray();
            var rooms = Of<SpatialElement>(doc, BuiltInCategory.OST_Rooms, level, box, cap, null, ref partial).OfType<Room>().ToList();
            var spaces = Of<SpatialElement>(doc, BuiltInCategory.OST_MEPSpaces, level, box, cap, null, ref partial).OfType<Space>().ToList();
            bool truncated = false;
            void Add(SpatialElement place, string kind)
            {
                if (rows.Count >= cap) { truncated = true; return; }
                bool placed = place.Location != null;
                bool? api = EnclosedApi(place);
                bool boundary = Boundary(place, out double gapFeet);
                double area = 0;
                try { area = place.Area; } catch (Exception) { area = 0; }
                bool redundant = placed && area <= 1e-6 && boundary && api != true;
                bool unbounded = !placed;
                bool? enclosed = api ?? (placed && area > 1e-6 ? true : placed ? false : (bool?)null);
                rows.Add(new JObject
                {
                    ["id"] = Id(place), ["kind"] = kind, ["number"] = place.Number ?? "", ["name"] = place.Name ?? "",
                    ["level_id"] = place.LevelId == null ? "" : place.LevelId.Value.ToString(),
                    ["area_m2"] = Math.Round(area * 0.09290304, 3),
                    ["placed"] = placed, ["enclosed"] = enclosed == null ? (JToken)JValue.CreateNull() : new JValue(enclosed.Value),
                    ["redundant"] = redundant, ["unbounded"] = unbounded,
                    ["boundary_gap_mm"] = boundary ? (JToken)new JValue(Math.Round(gapFeet * Mm, 1)) : JValue.CreateNull(),
                    ["xyz"] = MmPoint((place.Location as LocationPoint)?.Point),
                });
            }
            foreach (Room room in rooms) Add(room, "room");
            foreach (Space space in spaces) Add(space, "space");
            if (truncated) partial = true;
            var numbers = new Dictionary<string, int>();
            foreach (JObject row in rows.OfType<JObject>())
            {
                string key = (row.Value<string>("level_id") ?? "") + "/" + (row.Value<string>("number") ?? "");
                numbers[key] = numbers.TryGetValue(key, out int have) ? have + 1 : 1;
            }
            foreach (JObject row in rows.OfType<JObject>())
            {
                string key = (row.Value<string>("level_id") ?? "") + "/" + (row.Value<string>("number") ?? "");
                if (numbers[key] > 1 && row.Value<double?>("area_m2") <= 0) row["redundant"] = true;
            }
            return rows;
        }

        private static JArray RoomWalls(Document doc, ElementId level, ElementFilter box, int cap, ref bool partial)
        {
            var rows = new JArray();
            foreach (Wall wall in Of<Wall>(doc, BuiltInCategory.OST_Walls, level, box, cap, null, ref partial))
            {
                if (rows.Count >= cap) { partial = true; break; }
                Parameter parameter = wall.get_Parameter(BuiltInParameter.WALL_ATTR_ROOM_BOUNDING);
                if (parameter == null) continue;
                var row = new JObject { ["id"] = Id(wall), ["room_bounding"] = parameter.AsInteger() != 0, ["level_id"] = wall.LevelId == null ? "" : wall.LevelId.Value.ToString(), ["pinned"] = wall.Pinned };
                Stamp(doc, wall, null, row);
                rows.Add(row);
            }
            return rows;
        }

        private static JObject Pressure(Document doc, ElementId level, ElementFilter box, int cap, int maxPairs, int maxRays, double search, double resolution, ref bool partial)
        {
            var walls = Of<Wall>(doc, BuiltInCategory.OST_Walls, level, box, cap, null, ref partial);
            var exterior = walls.Where(IsExterior).Take(cap).ToList();
            var roofs = Of<RoofBase>(doc, BuiltInCategory.OST_Roofs, level, box, cap, null, ref partial);
            var floors = Of<Floor>(doc, BuiltInCategory.OST_Floors, level, box, cap, null, ref partial);
            var grade = Grade(floors);
            var doors = Of<FamilyInstance>(doc, BuiltInCategory.OST_Doors, level, box, cap, null, ref partial);
            var windows = Of<FamilyInstance>(doc, BuiltInCategory.OST_Windows, level, box, cap, null, ref partial);
            var openings = doors.Concat(windows).Select(item => item.get_BoundingBox(null)).Where(item => item != null).ToList();
            var leaks = new JArray();
            var seen = new HashSet<string>();
            int curtain = walls.Count(IsCurtain);
            foreach (Wall wall in exterior)
            {
                if (leaks.Count >= maxPairs) { partial = true; break; }
                BoundingBoxXYZ wallBox = wall.get_BoundingBox(null);
                if (wall.Location is LocationCurve location)
                {
                    for (int end = 0; end < 2; end++)
                    {
                        if (!OpenEnd(location, wall, end, out _)) continue;
                        XYZ point = location.Curve.GetEndPoint(end);
                        if (Covered(openings, point)) continue;
                        Leak(leaks, seen, "LEAK-CORNER", point, NearestGap(wall, end, exterior), new[] { Id(wall) }, "corner");
                    }
                }
                RoofBase roof = roofs.FirstOrDefault(item => Near(wallBox, item.get_BoundingBox(null), search));
                if (roof != null && !Attached(wall, true))
                {
                    double? gap = VerticalGap(wallBox, roof.get_BoundingBox(null), false);
                    XYZ at = Top(wallBox);
                    if (at == null || !Covered(openings, at)) Leak(leaks, seen, "LEAK-ROOF-EDGE", at, gap * Mm, new[] { Id(wall), Id(roof) }, "roof");
                }
                Floor floor = grade.FirstOrDefault(item => Near(wallBox, item.get_BoundingBox(null), search));
                if (floor != null)
                {
                    double? gap = VerticalGap(wallBox, floor.get_BoundingBox(null), true);
                    XYZ at = wallBox == null ? null : new XYZ((wallBox.Min.X + wallBox.Max.X) / 2, (wallBox.Min.Y + wallBox.Max.Y) / 2, wallBox.Min.Z);
                    if (gap != null && gap > 0 && (at == null || !Covered(openings, at)))
                        Leak(leaks, seen, "LEAK-WALL-BASE", at, gap * Mm, new[] { Id(wall), Id(floor) }, "base");
                }
            }
            foreach (Floor floor in grade)
            {
                if (leaks.Count >= maxPairs) break;
                BoundingBoxXYZ floorBox = floor.get_BoundingBox(null);
                foreach (Wall wall in exterior)
                {
                    double gap = HorizontalGap(floorBox, wall.get_BoundingBox(null));
                    if (gap <= 0 || gap > search) continue;
                    XYZ at = Mid(floorBox);
                    if (at != null && Covered(openings, at)) continue;
                    Leak(leaks, seen, "LEAK-FLOOR-EDGE", at, gap * Mm, new[] { Id(floor), Id(wall) }, "floor");
                    break;
                }
            }
            var solids = new List<Solid>();
            var options = new Options { ComputeReferences = false, IncludeNonVisibleObjects = false, DetailLevel = ViewDetailLevel.Fine };
            foreach (Element element in exterior.OfType<Element>().Concat(roofs).Concat(grade))
            {
                if (solids.Count >= 40) { partial = true; break; }
                Solids(element, options, solids, 40);
            }
            int booleans = 0;
            for (int i = 0; i < exterior.Count && booleans < 20; i++)
            {
                for (int j = i + 1; j < exterior.Count && booleans < 20; j++)
                {
                    if (!Near(exterior[i].get_BoundingBox(null), exterior[j].get_BoundingBox(null), search)) continue;
                    Solid left = FirstSolid(exterior[i], options);
                    Solid right = FirstSolid(exterior[j], options);
                    if (left == null || right == null) continue;
                    booleans++;
                    try
                    {
                        Solid common = BooleanOperationsUtils.ExecuteBooleanOperation(left, right, BooleanOperationsType.Intersect);
                        double gap = BoxGap(exterior[i].get_BoundingBox(null), exterior[j].get_BoundingBox(null));
                        if ((common == null || common.Volume < 1e-9) && gap > 0 && gap < search)
                            Leak(leaks, seen, "LEAK-GAP", Mid(exterior[i].get_BoundingBox(null)), gap * Mm, new[] { Id(exterior[i]), Id(exterior[j]) }, "boolean");
                    }
                    catch (Exception) { /* a boolean that Revit cannot run is skipped */ }
                }
            }
            int rays = 0;
            int voxels = 0;
            XYZ seed = Seed(doc, level, exterior, grade);
            if (seed != null && solids.Count > 0)
            {
                double length = Math.Min(search * 20, 80);
                for (int i = 0; i < maxRays; i++)
                {
                    rays++;
                    double angle = Math.PI * 2 * i / maxRays;
                    var direction = new XYZ(Math.Cos(angle), Math.Sin(angle), i % 6 == 0 ? 0.2 : 0);
                    direction = direction.Normalize();
                    Line ray = Line.CreateBound(seed, seed + direction * length);
                    double hit = FirstHit(solids, ray);
                    if (hit < length - 0.05) continue;
                    XYZ at = seed + direction * Math.Min(2, length);
                    if (Covered(openings, at)) continue;
                    Leak(leaks, seen, direction.Z > 0.15 ? "LEAK-ROOF-EDGE" : "LEAK-GAP", at, resolution * Mm, exterior.Take(1).Select(Id).ToArray(), "ray");
                    if (leaks.Count >= maxPairs) { partial = true; break; }
                }
                foreach (Wall wall in exterior.Take(20))
                {
                    if (wall.Location is not LocationCurve location) continue;
                    int steps = Math.Min(20, Math.Max(1, (int)(location.Curve.Length / resolution)));
                    for (int step = 0; step <= steps && voxels < 400; step++)
                    {
                        voxels++;
                        XYZ point = location.Curve.Evaluate(step / (double)steps, true);
                        if (wall.get_BoundingBox(null) == null) continue;
                        XYZ top = new XYZ(point.X, point.Y, wall.get_BoundingBox(null).Max.Z);
                        if (Covered(openings, top)) continue;
                        if (roofs.Count == 0) continue;
                        double rise = roofs.Min(item => item.get_BoundingBox(null) == null ? double.MaxValue : Math.Max(0, item.get_BoundingBox(null).Min.Z - top.Z));
                        if (rise > resolution && rise < search)
                            Leak(leaks, seen, "LEAK-ROOF-EDGE", top, rise * Mm, new[] { Id(wall) }, "voxel");
                    }
                }
            }
            bool built = exterior.Count + roofs.Count + grade.Count > 0;
            var envelope = new JObject
            {
                ["built"] = built,
                ["exterior_walls"] = exterior.Count,
                ["roofs"] = roofs.Count,
                ["floors"] = grade.Count,
                ["curtain"] = curtain,
                ["doors"] = doors.Count,
                ["windows"] = windows.Count,
                ["rays"] = rays,
                ["voxels"] = voxels,
                ["booleans"] = booleans,
                ["capped"] = partial,
                ["incomplete"] = !built || solids.Count == 0,
                ["reason"] = !built ? "No exterior wall, roof or grade floor was in scope." : solids.Count == 0 ? "The envelope elements had no solid." : "",
            };
            return new JObject { ["leaks"] = leaks, ["envelope"] = envelope };
        }

        private static void Leak(JArray leaks, HashSet<string> seen, string code, XYZ point, double? sizeMm, string[] ids, string relation)
        {
            string key = code + "|" + string.Join(",", ids) + "|" + (point == null ? "" : Math.Round(point.X, 2) + "," + Math.Round(point.Y, 2));
            if (!seen.Add(key)) return;
            leaks.Add(new JObject
            {
                ["code"] = code,
                ["xyz"] = MmPoint(point),
                ["size_mm"] = sizeMm == null ? JValue.CreateNull() : Math.Round(sizeMm.Value, 1),
                ["ids"] = new JArray(ids),
                ["relation"] = relation,
                ["closed"] = false,
            });
        }

        private static List<T> Of<T>(Document doc, BuiltInCategory? category, ElementId level, ElementFilter box, int cap, JArray ids, ref bool partial) where T : Element
        {
            if (ids != null && ids.Count > 0)
            {
                var picked = new List<T>();
                foreach (JToken token in ids)
                {
                    if (!long.TryParse(token.ToString(), out long value)) continue;
                    Element found = doc.GetElement(new ElementId(value));
                    if (found is T element) picked.Add(element);
                    else if (found != null) NoteSkip<T>(found);
                }
                return picked;
            }
            FilteredElementCollector collector = category == null
                ? new FilteredElementCollector(doc).OfClass(typeof(T))
                : new FilteredElementCollector(doc).OfCategory(category.Value).WhereElementIsNotElementType();
            if (category == null) collector.WhereElementIsNotElementType();
            if (level != null && level != ElementId.InvalidElementId) collector.WherePasses(new ElementLevelFilter(level));
            if (box != null) collector.WherePasses(box);
            var list = new List<T>();
            foreach (Element element in collector)
            {
                if (list.Count >= cap) { partial = true; break; }
                if (element is T typed) list.Add(typed);
                else NoteSkip<T>(element);
            }
            return list;
        }

        private static JObject WithSkip(JObject body)
        {
            if (body != null) body["skipped_non_family"] = Skipped.Report();
            return body;
        }

        /// <summary>A category filter can return a DirectShape. Record it instead of casting.</summary>
        private static void NoteSkip<T>(Element element) where T : Element
        {
            if (element == null || element is T) return;
            bool familyOrCurve = typeof(FamilyInstance).IsAssignableFrom(typeof(T)) || typeof(MEPCurve).IsAssignableFrom(typeof(T));
            if (!familyOrCurve && element is not DirectShape) return;
            Skipped.Add(element);
        }

        private static int Count(Document doc, BuiltInCategory[] cats, ElementId level, ElementFilter box, JArray ids)
        {
            if (ids != null && ids.Count > 0) return ids.Count;
            int total = 0;
            if (cats == null || cats.Length == 0)
            {
                var collector = new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).WhereElementIsNotElementType();
                if (level != null && level != ElementId.InvalidElementId) collector.WherePasses(new ElementLevelFilter(level));
                if (box != null) collector.WherePasses(box);
                return collector.GetElementCount();
            }
            foreach (BuiltInCategory cat in cats)
            {
                var collector = new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType();
                if (level != null && level != ElementId.InvalidElementId) collector.WherePasses(new ElementLevelFilter(level));
                if (box != null) collector.WherePasses(box);
                total += collector.GetElementCount();
            }
            return total;
        }

        private static BuiltInCategory[] Categories(string action, string category)
        {
            BuiltInCategory[] mapped = Map(category);
            if (mapped != null) return mapped;
            if (action == "hosting") return new[] { BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_Furniture, BuiltInCategory.OST_FurnitureSystems, BuiltInCategory.OST_Casework, BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_SpecialityEquipment, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Ceilings };
            if (action == "rooms") return new[] { BuiltInCategory.OST_Rooms, BuiltInCategory.OST_MEPSpaces, BuiltInCategory.OST_Walls };
            if (action == "pressure_test") return new[] { BuiltInCategory.OST_Walls, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_Rooms, BuiltInCategory.OST_MEPSpaces };
            return new[] { BuiltInCategory.OST_Walls, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_Columns, BuiltInCategory.OST_StructuralFraming, BuiltInCategory.OST_Stairs, BuiltInCategory.OST_Railings, BuiltInCategory.OST_EdgeSlab };
        }

        private static BuiltInCategory? Single(string category)
        {
            BuiltInCategory[] mapped = Map(category);
            if (mapped == null || mapped.Length != 1) return null;
            if (mapped[0] == BuiltInCategory.OST_Floors || mapped[0] == BuiltInCategory.OST_Roofs || mapped[0] == BuiltInCategory.OST_Ceilings || mapped[0] == BuiltInCategory.OST_Walls)
                return null;
            return mapped[0];
        }

        private static BuiltInCategory[] Map(string name)
        {
            switch ((name ?? "").Trim().ToLowerInvariant())
            {
                case "": return null;
                case "wall":
                case "walls": return new[] { BuiltInCategory.OST_Walls };
                case "floor":
                case "floors": return new[] { BuiltInCategory.OST_Floors };
                case "roof":
                case "roofs": return new[] { BuiltInCategory.OST_Roofs };
                case "column":
                case "columns": return new[] { BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_Columns };
                case "framing": return new[] { BuiltInCategory.OST_StructuralFraming };
                case "door":
                case "doors": return new[] { BuiltInCategory.OST_Doors };
                case "window":
                case "windows": return new[] { BuiltInCategory.OST_Windows };
                case "stair":
                case "stairs": return new[] { BuiltInCategory.OST_Stairs };
                case "railing":
                case "railings": return new[] { BuiltInCategory.OST_Railings };
                case "room":
                case "rooms": return new[] { BuiltInCategory.OST_Rooms };
                case "space":
                case "spaces": return new[] { BuiltInCategory.OST_MEPSpaces };
                case "curtain":
                case "curtain wall":
                case "curtain walls": return new[] { BuiltInCategory.OST_Walls };
                default: return Array.Empty<BuiltInCategory>();
            }
        }

        private static ElementId LevelOf(Document doc, string key, out bool missing)
        {
            missing = false;
            if (string.IsNullOrWhiteSpace(key)) return null;
            if (long.TryParse(key, out long id) && doc.GetElement(new ElementId(id)) is Level byId) return byId.Id;
            Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).OfType<Level>().FirstOrDefault(item => string.Equals(item.Name, key, StringComparison.OrdinalIgnoreCase));
            if (level == null) { missing = true; return null; }
            return level.Id;
        }

        private static SpatialElement FindPlace(Document doc, string room, string space, out bool missing)
        {
            string key = string.IsNullOrWhiteSpace(room) ? space : room;
            missing = false;
            if (string.IsNullOrWhiteSpace(key)) return null;
            var places = new FilteredElementCollector(doc).OfClass(typeof(SpatialElement)).OfType<SpatialElement>()
                .Where(item => item is Room || item is Space).ToList();
            SpatialElement found = places.FirstOrDefault(item => Id(item) == key || string.Equals(item.Number, key, StringComparison.OrdinalIgnoreCase) || string.Equals(item.Name, key, StringComparison.OrdinalIgnoreCase));
            if (found == null) missing = true;
            return found;
        }

        private static ElementFilter BoxOf(JObject bbox)
        {
            if (bbox?["min"] is not JObject min || bbox["max"] is not JObject max) return null;
            var a = new XYZ(min.Value<double>("x") / Mm, min.Value<double>("y") / Mm, min.Value<double>("z") / Mm);
            var b = new XYZ(max.Value<double>("x") / Mm, max.Value<double>("y") / Mm, max.Value<double>("z") / Mm);
            return new BoundingBoxIntersectsFilter(OutlineOf(a, b, 0));
        }

        private static Outline OutlineOf(XYZ a, XYZ b, double pad)
        {
            return new Outline(
                new XYZ(Math.Min(a.X, b.X) - pad, Math.Min(a.Y, b.Y) - pad, Math.Min(a.Z, b.Z) - pad),
                new XYZ(Math.Max(a.X, b.X) + pad, Math.Max(a.Y, b.Y) + pad, Math.Max(a.Z, b.Z) + pad));
        }

        private static bool Want(Element element, string category)
        {
            if (string.IsNullOrWhiteSpace(category) || element?.Category == null) return !string.IsNullOrWhiteSpace(category) ? false : true;
            string name = element.Category.Name ?? "";
            return name.Equals(category, StringComparison.OrdinalIgnoreCase) || name.IndexOf(category, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool IsCurtain(Wall wall)
        {
            try { return wall.WallType != null && wall.WallType.Kind == WallKind.Curtain; } catch (Exception) { return false; }
        }

        private static bool IsExterior(Wall wall)
        {
            try
            {
                Parameter parameter = wall.get_Parameter(BuiltInParameter.FUNCTION_PARAM);
                return parameter != null && parameter.AsInteger() == (int)WallFunction.Exterior;
            }
            catch (Exception) { return false; }
        }

        private static bool Attached(Wall wall, bool top)
        {
            try
            {
                Parameter parameter = wall.get_Parameter(top ? BuiltInParameter.WALL_TOP_IS_ATTACHED : BuiltInParameter.WALL_BOTTOM_IS_ATTACHED);
                if (parameter != null && parameter.AsInteger() == 1) return true;
                return wall.GetAttachmentIds(top ? AttachmentLocation.Top : AttachmentLocation.Base).Count > 0;
            }
            catch (Exception) { return false; }
        }

        private static bool OpenEnd(LocationCurve location, Wall wall, int end, out List<string> ids)
        {
            ids = new List<string>();
            try
            {
                foreach (Element element in location.get_ElementsAtJoin(end).OfType<Element>())
                    if (element != null && element.Id.Value != wall.Id.Value) ids.Add(Id(element));
            }
            catch (Exception) { /* an end that cannot report joins is treated as open */ }
            return ids.Count == 0;
        }

        private static double NearestGap(Wall wall, int end, List<Wall> walls)
        {
            if (wall.Location is not LocationCurve location) return 0;
            XYZ point = location.Curve.GetEndPoint(end);
            double best = double.MaxValue;
            foreach (Wall other in walls)
            {
                if (other.Id.Value == wall.Id.Value || other.Location is not LocationCurve otherLocation) continue;
                IntersectionResult hit = otherLocation.Curve.Project(point);
                if (hit == null) continue;
                best = Math.Min(best, Math.Max(0, hit.Distance - Half(other)) * Mm);
            }
            return best == double.MaxValue ? 0 : best;
        }

        private static bool IsFixture(long category)
        {
            return category == (long)BuiltInCategory.OST_PlumbingFixtures || category == (long)BuiltInCategory.OST_Furniture
                || category == (long)BuiltInCategory.OST_Casework || category == (long)BuiltInCategory.OST_LightingFixtures
                || category == (long)BuiltInCategory.OST_ElectricalFixtures || category == (long)BuiltInCategory.OST_MechanicalEquipment
                || category == (long)BuiltInCategory.OST_SpecialityEquipment || category == (long)BuiltInCategory.OST_FurnitureSystems;
        }

        private static bool ShouldHost(FamilyInstance instance)
        {
            try
            {
                FamilyPlacementType place = instance.Symbol.Family.FamilyPlacementType;
                return place == FamilyPlacementType.OneLevelBasedHosted || place == FamilyPlacementType.WorkPlaneBased;
            }
            catch (Exception) { return false; }
        }

        private static bool? Cuts(Wall wall, FamilyInstance instance, XYZ point)
        {
            try
            {
                var type = instance.Document.GetElement(instance.GetTypeId());
                double height = (instance.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM) ?? type?.get_Parameter(BuiltInParameter.DOOR_HEIGHT) ?? type?.get_Parameter(BuiltInParameter.WINDOW_HEIGHT))?.AsDouble() ?? 3;
                XYZ mid = point + XYZ.BasisZ * (height / 2);
                XYZ normal = wall.Orientation.Normalize();
                Line across = Line.CreateBound(mid - normal * Math.Max(wall.Width, 0.1), mid + normal * Math.Max(wall.Width, 0.1));
                double inside = 0;
                foreach (Solid solid in SolidsOf(wall))
                {
                    SolidCurveIntersection hit = solid.IntersectWithCurve(across, new SolidCurveIntersectionOptions());
                    for (int i = 0; i < hit.SegmentCount; i++) inside += hit.GetCurveSegment(i).Length;
                }
                return inside <= Math.Max(wall.Width, 0.1) * 0.5;
            }
            catch (Exception) { return null; }
        }

        private static bool? Touches(XYZ point, List<(string id, BoundingBoxXYZ box, Wall wall)> supports, double pad)
        {
            if (point == null) return null;
            if (supports.Count == 0) return null;
            return supports.Any(item => item.box != null && (Inside(item.box, point, pad) || BoxGap(new BoundingBoxXYZ { Min = point, Max = point }, item.box) <= pad));
        }

        private static bool? EnclosedApi(SpatialElement place)
        {
            try
            {
                PropertyInfo property = place.GetType().GetProperty("IsEnclosed");
                if (property != null && property.PropertyType == typeof(bool)) return (bool)property.GetValue(place);
                MethodInfo method = place.GetType().GetMethod("IsEnclosed", Type.EmptyTypes);
                if (method != null && method.ReturnType == typeof(bool)) return (bool)method.Invoke(place, null);
            }
            catch (Exception) { /* the boundary is the fallback */ }
            return null;
        }

        private static bool Boundary(SpatialElement place, out double gapFeet)
        {
            gapFeet = 0;
            try
            {
                var options = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };
                IList<IList<BoundarySegment>> loops = place.GetBoundarySegments(options);
                if (loops == null || loops.Count == 0) return false;
                foreach (IList<BoundarySegment> loop in loops)
                {
                    if (loop == null || loop.Count == 0) continue;
                    for (int i = 0; i < loop.Count; i++)
                    {
                        Curve current = loop[i].GetCurve();
                        Curve next = loop[(i + 1) % loop.Count].GetCurve();
                        gapFeet = Math.Max(gapFeet, current.GetEndPoint(1).DistanceTo(next.GetEndPoint(0)));
                    }
                }
                return true;
            }
            catch (Exception) { return false; }
        }

        private static List<Floor> Grade(List<Floor> floors)
        {
            if (floors.Count == 0) return floors;
            double lowest = floors.Min(floor => floor.LevelId == null ? 0 : (floor.Document.GetElement(floor.LevelId) as Level)?.Elevation ?? 0);
            return floors.Where(floor => Math.Abs(((floor.Document.GetElement(floor.LevelId) as Level)?.Elevation ?? 0) - lowest) < 1e-6).ToList();
        }

        private static XYZ Seed(Document doc, ElementId level, List<Wall> walls, List<Floor> floors)
        {
            Room room = null;
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType())
            {
                if (element is Room item && item.Location != null && (level == null || item.LevelId == level))
                {
                    room = item;
                    break;
                }
                if (element is not Room) NoteSkip<Room>(element);
            }
            if (room?.Location is LocationPoint point) return point.Point + XYZ.BasisZ;
            BoundingBoxXYZ box = walls.Select(item => item.get_BoundingBox(null)).FirstOrDefault(item => item != null)
                ?? floors.Select(item => item.get_BoundingBox(null)).FirstOrDefault(item => item != null);
            return box == null ? null : (box.Min + box.Max) / 2;
        }

        private static void Solids(Element element, Options options, List<Solid> into, int cap)
        {
            try
            {
                void Walk(GeometryElement geometry)
                {
                    if (geometry == null) return;
                    foreach (GeometryObject item in geometry)
                    {
                        if (into.Count >= cap) return;
                        if (item is Solid solid && solid.Volume > 1e-6) into.Add(solid);
                        else if (item is GeometryInstance instance) Walk(instance.GetInstanceGeometry());
                    }
                }
                Walk(element.get_Geometry(options));
            }
            catch (Exception) { /* this element adds no solid */ }
        }

        private static List<Solid> SolidsOf(Element element)
        {
            var list = new List<Solid>();
            Solids(element, new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Fine }, list, 8);
            return list;
        }

        private static Solid FirstSolid(Element element, Options options)
        {
            var list = new List<Solid>();
            Solids(element, options, list, 1);
            return list.FirstOrDefault();
        }

        private static double FirstHit(List<Solid> solids, Line ray)
        {
            double best = double.MaxValue;
            var options = new SolidCurveIntersectionOptions();
            foreach (Solid solid in solids)
            {
                try
                {
                    SolidCurveIntersection hit = solid.IntersectWithCurve(ray, options);
                    for (int i = 0; i < hit.SegmentCount; i++)
                        best = Math.Min(best, ray.GetEndPoint(0).DistanceTo(hit.GetCurveSegment(i).GetEndPoint(0)));
                }
                catch (Exception) { /* this solid does not cut the ray */ }
            }
            return best;
        }

        private static bool Covered(List<BoundingBoxXYZ> boxes, XYZ point)
        {
            return point != null && boxes.Any(box => Inside(box, point, 0.2));
        }

        private static JObject Pair(string relation, Element a, string b, int? end, double? gapFeet, double overlapFeet, bool joined, bool open, bool attached, XYZ point)
        {
            return new JObject
            {
                ["relation"] = relation,
                ["a"] = Id(a),
                ["b"] = b ?? "",
                ["end"] = end == null ? (JToken)JValue.CreateNull() : new JValue(end.Value),
                ["gap_mm"] = gapFeet == null ? (JToken)JValue.CreateNull() : new JValue(Math.Round(Math.Max(0, gapFeet.Value) * Mm, 1)),
                ["overlap_mm"] = new JValue(Math.Round(Math.Max(0, overlapFeet) * Mm, 1)),
                ["joined"] = joined,
                ["open_end"] = open,
                ["attached"] = attached,
                ["xyz"] = MmPoint(point),
            };
        }

        private static JObject Stamped(Document doc, Element a, Element b, JObject row)
        {
            Stamp(doc, a, b, row);
            return row;
        }

        private static void Stamp(Document doc, Element a, Element b, JObject row)
        {
            row["pinned"] = (a?.Pinned ?? false) || (b?.Pinned ?? false);
            void One(Element element, string side)
            {
                if (element == null) return;
                JObject held = FmcCheckout.Hold(doc, element.Id);
                if (held == null) return;
                row["checkout_" + side] = held.Value<string>("code");
                row["owner_" + side] = held.Value<string>("owner");
                if (side == "a" && row["checkout"] == null)
                {
                    row["checkout"] = held.Value<string>("code");
                    row["owner"] = held.Value<string>("owner");
                }
            }
            One(a, "a");
            One(b, "b");
        }

        private static double? VerticalGap(BoundingBoxXYZ wall, BoundingBoxXYZ other, bool floor)
        {
            if (wall == null || other == null) return null;
            return floor ? wall.Min.Z - other.Max.Z : other.Min.Z - wall.Max.Z;
        }

        private static double HorizontalGap(BoundingBoxXYZ a, BoundingBoxXYZ b)
        {
            if (a == null || b == null) return double.MaxValue;
            double dx = AxisGap(a.Min.X, a.Max.X, b.Min.X, b.Max.X);
            double dy = AxisGap(a.Min.Y, a.Max.Y, b.Min.Y, b.Max.Y);
            if (dx == 0 && dy == 0) return 0;
            if (dx == 0) return dy;
            if (dy == 0) return dx;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        private static double BoxGap(BoundingBoxXYZ a, BoundingBoxXYZ b)
        {
            if (a == null || b == null) return double.MaxValue;
            double dx = AxisGap(a.Min.X, a.Max.X, b.Min.X, b.Max.X);
            double dy = AxisGap(a.Min.Y, a.Max.Y, b.Min.Y, b.Max.Y);
            double dz = AxisGap(a.Min.Z, a.Max.Z, b.Min.Z, b.Max.Z);
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        private static double AxisGap(double a0, double a1, double b0, double b1)
        {
            if (a1 < b0) return b0 - a1;
            if (b1 < a0) return a0 - b1;
            return 0;
        }

        private static double PointGap(Wall wall, XYZ point)
        {
            if (wall.Location is not LocationCurve location) return double.MaxValue;
            IntersectionResult hit = location.Curve.Project(point);
            if (hit == null) return double.MaxValue;
            return hit.Distance - Half(wall);
        }

        private static bool Near(BoundingBoxXYZ a, BoundingBoxXYZ b, double pad)
        {
            if (a == null || b == null) return false;
            return a.Min.X - pad <= b.Max.X && a.Max.X + pad >= b.Min.X
                && a.Min.Y - pad <= b.Max.Y && a.Max.Y + pad >= b.Min.Y
                && a.Min.Z - pad <= b.Max.Z && a.Max.Z + pad >= b.Min.Z;
        }

        private static bool Inside(BoundingBoxXYZ box, XYZ point, double pad)
        {
            return box != null && point != null
                && point.X >= box.Min.X - pad && point.X <= box.Max.X + pad
                && point.Y >= box.Min.Y - pad && point.Y <= box.Max.Y + pad
                && point.Z >= box.Min.Z - pad && point.Z <= box.Max.Z + pad;
        }

        private static double Half(Wall wall)
        {
            try { return wall.Width * 0.5; } catch (Exception) { return 0; }
        }

        private static double? ParamMm(Element element, BuiltInParameter parameter)
        {
            try
            {
                Parameter value = element.get_Parameter(parameter);
                if (value == null || !value.HasValue || value.StorageType != StorageType.Double) return null;
                return value.AsDouble() * Mm;
            }
            catch (Exception) { return null; }
        }

        private static XYZ Mid(BoundingBoxXYZ box) => box == null ? null : (box.Min + box.Max) / 2;
        private static XYZ Top(BoundingBoxXYZ box) => box == null ? null : new XYZ((box.Min.X + box.Max.X) / 2, (box.Min.Y + box.Max.Y) / 2, box.Max.Z);

        private static JToken MmPoint(XYZ point)
        {
            if (point == null) return JValue.CreateNull();
            return new JObject { ["x"] = Math.Round(point.X * Mm, 1), ["y"] = Math.Round(point.Y * Mm, 1), ["z"] = Math.Round(point.Z * Mm, 1) };
        }

        private static string Id(Element element) => element == null ? "" : element.Id.Value.ToString();
    }
}
