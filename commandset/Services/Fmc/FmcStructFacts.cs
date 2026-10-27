using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_struct_facts (owner 27 Oct: structural design from the architecture model), read-only: what the structure
    /// must carry and where, in mm and the host model's coordinates. From the active model, or a linked one (link: part
    /// of its name). Levels; walls (type, function, bearing or not, layers with material and density, thickness, length,
    /// height, base and top, the line); floors and roofs (type, level, area, thickness, layers, outline); rooms (name,
    /// number, level, area, department, occupancy); columns, framing and stairs (type, material, place). The server's
    /// load takedown (fmc/loads.ts) turns these into loads.
    /// </summary>
    public class FmcStructFactsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft structural facts";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = FmcStructRead.Facts(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open"), Parameters); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>The reader itself, self-contained (RevitAPI and Newtonsoft only), so a test can load it on its own.</summary>
    public sealed class FmcStructRead
    {
        public static JObject Facts(Document host, JObject parameters) => new FmcStructRead { Parameters = parameters ?? new JObject() }.Facts(host);
        private JObject Parameters;

        private static double Mm(double ft) => Math.Round(ft * 304.8, 1);
        private Transform _t = Transform.Identity;
        private JArray P(XYZ p) { XYZ q = _t.OfPoint(p); return new JArray(Mm(q.X), Mm(q.Y), Mm(q.Z)); }

        private JObject Facts(Document host)
        {
            Document doc = host;
            string from = host.Title;
            string link = Parameters.Value<string>("link");
            if (!string.IsNullOrEmpty(link))
            {
                var inst = new FilteredElementCollector(host).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>()
                    .FirstOrDefault(i => i.GetLinkDocument()?.Title.IndexOf(link, StringComparison.OrdinalIgnoreCase) >= 0)
                    ?? throw new InvalidOperationException($"no loaded link named like {link}");
                doc = inst.GetLinkDocument(); _t = inst.GetTotalTransform(); from = doc.Title + " (link)";
            }
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
            string LevelName(ElementId id) => doc.GetElement(id)?.Name ?? "";

            var mats = new Dictionary<ElementId, JObject>();
            JObject Mat(ElementId id)
            {
                if (mats.TryGetValue(id, out JObject m)) return m;
                var mat = doc.GetElement(id) as Material;
                double? density = null;
                if (mat != null && doc.GetElement(mat.StructuralAssetId) is PropertySetElement ps && ps.GetStructuralAsset() is StructuralAsset sa && sa.Density > 0)
                    density = Math.Round(UnitUtils.ConvertFromInternalUnits(sa.Density, UnitTypeId.KilogramsPerCubicMeter));
                m = new JObject { ["name"] = mat?.Name ?? "(none)", ["class"] = mat?.MaterialClass, ["density_kg_m3"] = density };
                return mats[id] = m;
            }
            JArray Layers(HostObjAttributes t)
            {
                var cs = t?.GetCompoundStructure();
                if (cs == null) return new JArray();
                return new JArray(cs.GetLayers().Select(l => new JObject
                {
                    ["function"] = l.Function.ToString(), ["thickness_mm"] = Mm(l.Width), ["material"] = Mat(l.MaterialId)["name"],
                    ["class"] = Mat(l.MaterialId)["class"], ["density_kg_m3"] = Mat(l.MaterialId)["density_kg_m3"],
                }));
            }

            var walls = new JArray();
            foreach (Wall w in new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>())
            {
                if (!(w.Location is LocationCurve lc) || w.WallType.Kind == WallKind.Curtain && Parameters.Value<bool?>("curtain") != true) continue;
                double h = w.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble() ?? 0;
                walls.Add(new JObject
                {
                    ["id"] = w.Id.Value, ["type"] = w.WallType.Name, ["kind"] = w.WallType.Kind.ToString(), ["function"] = w.WallType.Function.ToString(),
                    ["structural"] = w.get_Parameter(BuiltInParameter.WALL_STRUCTURAL_SIGNIFICANT)?.AsInteger() == 1, ["usage"] = w.StructuralUsage.ToString(),
                    ["thickness_mm"] = Mm(w.Width), ["length_mm"] = Mm(lc.Curve.Length), ["height_mm"] = Mm(h),
                    ["base_level"] = LevelName(w.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId() ?? ElementId.InvalidElementId),
                    ["base_offset_mm"] = Mm(w.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0),
                    ["top_level"] = LevelName(w.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.AsElementId() ?? ElementId.InvalidElementId),
                    ["start_mm"] = P(lc.Curve.GetEndPoint(0)), ["end_mm"] = P(lc.Curve.GetEndPoint(1)), ["arc"] = !(lc.Curve is Line),
                    ["openings_area_m2"] = Math.Round(Openings(doc, w), 2),
                    ["layers"] = Layers(w.WallType),
                });
            }

            JArray Outline(Element e)
            {
                try
                {
                    if (e is Floor f && doc.GetElement(f.SketchId) is Sketch sk)
                        return new JArray(sk.Profile.Cast<CurveArray>().Select(loop => new JArray(loop.Cast<Curve>().Select(c => P(c.GetEndPoint(0))))));
                }
                catch (Exception) { }
                return null;
            }
            var floors = new JArray();
            foreach (Floor f in new FilteredElementCollector(doc).OfClass(typeof(Floor)).Cast<Floor>())
                floors.Add(new JObject
                {
                    ["id"] = f.Id.Value, ["type"] = f.FloorType.Name, ["level"] = LevelName(f.LevelId),
                    ["offset_mm"] = Mm(f.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.AsDouble() ?? 0),
                    ["structural"] = f.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger() == 1,
                    ["area_m2"] = Math.Round((f.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED)?.AsDouble() ?? 0) * 0.09290304, 2),
                    ["thickness_mm"] = Mm(f.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM)?.AsDouble() ?? 0),
                    ["layers"] = Layers(f.FloorType), ["outline_mm"] = Outline(f),
                });
            var roofs = new JArray();
            foreach (RoofBase r in new FilteredElementCollector(doc).OfClass(typeof(RoofBase)).Cast<RoofBase>())
            {
                BoundingBoxXYZ b = r.get_BoundingBox(null);
                roofs.Add(new JObject
                {
                    ["id"] = r.Id.Value, ["type"] = r.RoofType.Name, ["level"] = LevelName(r.LevelId),
                    ["area_m2"] = Math.Round((r.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED)?.AsDouble() ?? 0) * 0.09290304, 2),
                    ["plan_min_mm"] = b != null ? P(b.Min) : null, ["plan_max_mm"] = b != null ? P(b.Max) : null, ["layers"] = Layers(r.RoofType),
                });
            }
            var rooms = new JArray(new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).Cast<Room>().Where(r => r.Area > 0).Select(r => new JObject
            {
                ["id"] = r.Id.Value, ["number"] = r.Number, ["name"] = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(), ["level"] = r.Level?.Name,
                ["area_m2"] = Math.Round(r.Area * 0.09290304, 2), ["department"] = r.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)?.AsString(),
                ["occupancy"] = r.get_Parameter(BuiltInParameter.ROOM_OCCUPANCY)?.AsString(),
                ["at_mm"] = r.Location is LocationPoint lp ? P(lp.Point) : null,
            }));
            JArray Members(BuiltInCategory cat) => new JArray(new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType().Cast<FamilyInstance>().Select(fi => new JObject
            {
                ["id"] = fi.Id.Value, ["type"] = fi.Symbol?.Name, ["family"] = fi.Symbol?.FamilyName, ["material"] = fi.StructuralMaterialId != ElementId.InvalidElementId ? doc.GetElement(fi.StructuralMaterialId)?.Name : null,
                ["level"] = LevelName(fi.LevelId != ElementId.InvalidElementId ? fi.LevelId : fi.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)?.AsElementId() ?? ElementId.InvalidElementId),
                ["at_mm"] = fi.Location is LocationPoint lp ? P(lp.Point) : null,
                ["start_mm"] = fi.Location is LocationCurve c ? P(c.Curve.GetEndPoint(0)) : null, ["end_mm"] = fi.Location is LocationCurve c2 ? P(c2.Curve.GetEndPoint(1)) : null,
            }));
            var stairs = new JArray(new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Stairs).WhereElementIsNotElementType().Select(s => new JObject
            {
                ["id"] = s.Id.Value, ["type"] = doc.GetElement(s.GetTypeId())?.Name, ["box_mm"] = s.get_BoundingBox(null) is BoundingBoxXYZ sb ? new JArray(P(sb.Min), P(sb.Max)) : null,
            }));

            return new JObject
            {
                ["from"] = from, ["units"] = "mm, m², kg/m³; the host model's coordinates",
                ["levels"] = new JArray(levels.Select(l => new JObject { ["name"] = l.Name, ["elevation_mm"] = Mm(_t.OfPoint(new XYZ(0, 0, l.Elevation)).Z) })),
                ["walls"] = walls, ["floors"] = floors, ["roofs"] = roofs, ["rooms"] = rooms,
                ["columns"] = Members(BuiltInCategory.OST_StructuralColumns), ["arch_columns"] = Members(BuiltInCategory.OST_Columns),
                ["framing"] = Members(BuiltInCategory.OST_StructuralFraming), ["stairs"] = stairs,
                ["counts"] = new JObject { ["walls"] = walls.Count, ["floors"] = floors.Count, ["roofs"] = roofs.Count, ["rooms"] = rooms.Count },
            };
        }

        /// <summary>Door and window openings in a wall, m² (width x height of each hosted insert).</summary>
        private static double Openings(Document doc, Wall w)
        {
            double a = 0;
            foreach (ElementId id in w.FindInserts(true, false, false, false))
                if (doc.GetElement(id) is FamilyInstance fi)
                {
                    double wd = fi.Symbol.get_Parameter(BuiltInParameter.DOOR_WIDTH)?.AsDouble() ?? fi.Symbol.get_Parameter(BuiltInParameter.WINDOW_WIDTH)?.AsDouble()
                        ?? fi.get_Parameter(BuiltInParameter.DOOR_WIDTH)?.AsDouble() ?? 0;
                    double ht = fi.Symbol.get_Parameter(BuiltInParameter.DOOR_HEIGHT)?.AsDouble() ?? fi.Symbol.get_Parameter(BuiltInParameter.WINDOW_HEIGHT)?.AsDouble()
                        ?? fi.get_Parameter(BuiltInParameter.DOOR_HEIGHT)?.AsDouble() ?? 0;
                    a += wd * ht * 0.09290304;
                }
            return a;
        }
    }
}
