using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The Ogala report's missing ops (owner 26 Oct): create_wall, create_floor and create_ceiling (with holes),
    /// create_room, place_family (hosted on a wall made earlier in the batch: "$n"), rehost (to another level, keeping
    /// its place), and, outside the op transaction, edit_sketch (a floor's, ceiling's or roof's boundary) and wall_profile
    /// (a wall's elevation shape: arches, gable tops).
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject CoreOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "create_wall":
                {
                    // start_mm, end_mm (or points_mm, a polyline); height_mm or top_level; base_offset_mm; structural?
                    Level level = LevelOf(doc, op["level"]);
                    ElementId t = TypeFor(doc, op, new FilteredElementCollector(doc).OfClass(typeof(WallType)).ToElementIds(), doc.GetDefaultElementTypeId(ElementTypeGroup.WallType));
                    var pts = op["points_mm"] != null ? Points(op["points_mm"], "points_mm is [[x, y], ...]") : new List<XYZ> { Vec(op["start_mm"], "create_wall needs start_mm and end_mm"), Vec(op["end_mm"], "create_wall needs end_mm") };
                    double h = Ft(op.Value<double?>("height_mm") ?? 3000), off = Ft(op.Value<double?>("base_offset_mm") ?? 0);
                    for (int i = 0; i + 1 < pts.Count; i++)
                    {
                        var line = Line.CreateBound(new XYZ(pts[i].X, pts[i].Y, level.Elevation), new XYZ(pts[i + 1].X, pts[i + 1].Y, level.Elevation));
                        Wall w = Wall.Create(doc, line, t, level.Id, h, off, op.Value<bool?>("flip") ?? false, op.Value<bool?>("structural") ?? false);
                        if (op["top_level"] != null) w.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(LevelOf(doc, op["top_level"]).Id);
                        if (op["top_offset_mm"] != null) w.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.Set(Ft(op.Value<double>("top_offset_mm")));
                        created.Add(w.Id);
                    }
                    return new JObject { ["walls"] = pts.Count - 1 };
                }
                case "create_floor":
                case "create_ceiling":
                {
                    // loops_mm: the outline first, then holes; offset_mm above the level
                    Level level = LevelOf(doc, op["level"]);
                    var loops = Loops(op).Select(l => CurveLoop.CreateViaTransform(l, Transform.CreateTranslation(new XYZ(0, 0, level.Elevation)))).ToList();
                    Element e;
                    if (name == "create_floor")
                    {
                        var types = new FilteredElementCollector(doc).OfClass(typeof(FloorType)).ToElementIds();
                        e = Floor.Create(doc, loops, TypeFor(doc, op, types, doc.GetDefaultElementTypeId(ElementTypeGroup.FloorType)), level.Id);
                        if (op["offset_mm"] != null) e.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(Ft(op.Value<double>("offset_mm")));
                        if (op["structural"] != null) e.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.Set(op.Value<bool>("structural") ? 1 : 0);
                    }
                    else
                    {
                        var types = new FilteredElementCollector(doc).OfClass(typeof(CeilingType)).ToElementIds();
                        e = Ceiling.Create(doc, loops, TypeFor(doc, op, types, types.First()), level.Id);
                        if (op["offset_mm"] != null) e.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(Ft(op.Value<double>("offset_mm")));
                    }
                    created.Add(e.Id);
                    return new JObject { [name == "create_floor" ? "floor" : "ceiling"] = e.Id.Value, ["holes"] = loops.Count - 1 };
                }
                case "create_room":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var ids = new JArray();
                    foreach (JArray p in PointList(op))
                    {
                        XYZ at = Vec(p, "points_mm are [x, y] inside the room");
                        Room r = doc.Create.NewRoom(level, new UV(at.X, at.Y));
                        if (op["name"] != null) r.Name = op.Value<string>("name");
                        if (op["number"] != null) r.Number = op.Value<string>("number");
                        created.Add(r.Id); ids.Add(r.Id.Value);
                    }
                    return new JObject { ["rooms"] = ids };
                }
                case "place_family":
                {
                    // any family type at points_mm; host: a wall (or floor, ceiling) by id or "$n" for doors and windows
                    Level level = op["level"] != null ? LevelOf(doc, op["level"]) : null;
                    var types = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).ToElementIds();
                    var sym = (FamilySymbol)doc.GetElement(TypeFor(doc, op, types));
                    if (!sym.IsActive) sym.Activate();
                    Element host = op["host"] != null ? doc.GetElement(Ref(doc, op["host"], made)) : null;
                    var ids = new JArray();
                    foreach (JArray p in PointList(op))
                    {
                        XYZ at = Vec(p, "points_mm are [x, y, z]");
                        if (level != null && p.Count < 3) at = new XYZ(at.X, at.Y, level.Elevation);
                        FamilyInstance fi = host != null
                            ? (level != null ? doc.Create.NewFamilyInstance(at, sym, host, level, StructuralType.NonStructural) : doc.Create.NewFamilyInstance(at, sym, host, StructuralType.NonStructural))
                            : doc.Create.NewFamilyInstance(at, sym, level ?? throw new InvalidOperationException("place_family needs level or host"), StructuralType.NonStructural);
                        if (op["sill_mm"] != null) fi.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.Set(Ft(op.Value<double>("sill_mm")));
                        if (op["offset_mm"] != null) fi.get_Parameter(BuiltInParameter.INSTANCE_ELEVATION_PARAM)?.Set(Ft(op.Value<double>("offset_mm")));
                        if (op["rotation_deg"] != null) ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(at, at + XYZ.BasisZ), op.Value<double>("rotation_deg") * Math.PI / 180);
                        if (op.Value<bool?>("flip_facing") == true && fi.CanFlipFacing) fi.flipFacing();
                        if (op.Value<bool?>("flip_hand") == true && fi.CanFlipHand) fi.flipHand();
                        created.Add(fi.Id); ids.Add(fi.Id.Value);
                    }
                    return new JObject { ["placed"] = ids };
                }
                case "rehost":
                {
                    // to another level, keeping each element where it is (its offset changes instead)
                    Level to = LevelOf(doc, op["level"]);
                    var moved = new JArray(); var kept = new JArray();
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        Element e = doc.GetElement(id);
                        (BuiltInParameter lv, BuiltInParameter off)[] pairs =
                        {
                            (BuiltInParameter.WALL_BASE_CONSTRAINT, BuiltInParameter.WALL_BASE_OFFSET), (BuiltInParameter.LEVEL_PARAM, BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM),
                            (BuiltInParameter.LEVEL_PARAM, BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM), (BuiltInParameter.ROOF_BASE_LEVEL_PARAM, BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM),
                            (BuiltInParameter.STAIRS_BASE_LEVEL_PARAM, BuiltInParameter.STAIRS_BASE_OFFSET), (BuiltInParameter.FAMILY_LEVEL_PARAM, BuiltInParameter.INSTANCE_ELEVATION_PARAM),
                            (BuiltInParameter.SCHEDULE_LEVEL_PARAM, BuiltInParameter.INSTANCE_ELEVATION_PARAM),
                        };
                        bool done = false;
                        foreach (var (lvP, offP) in pairs)
                        {
                            Parameter l = e.get_Parameter(lvP), o = e.get_Parameter(offP);
                            if (l == null || o == null || l.IsReadOnly || o.IsReadOnly) continue;
                            var from = doc.GetElement(l.AsElementId()) as Level; if (from == null) continue;
                            double z = from.Elevation + o.AsDouble();
                            l.Set(to.Id); o.Set(z - to.Elevation);
                            done = true; break;
                        }
                        (done ? moved : kept).Add(id.Value);
                    }
                    var r = new JObject { ["rehosted"] = moved, ["level"] = to.Name };
                    if (kept.Count > 0) { r["not_rehosted"] = kept; r["hint"] = "Revit keeps these on their level (no editable level and offset): recreate them on the new level"; }
                    return r;
                }
                default: return null;
            }
        }

        /// <summary>Sketch edits (Edit Boundary, Edit Profile) run in Revit's sketch mode, outside the op's own transaction.</summary>
        private JObject SketchOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            Element e = doc.GetElement(Ref(doc, op["id"], made) ?? throw new InvalidOperationException($"{name} needs id"));
            Sketch sketch;
            Func<double, double, XYZ> map;
            if (name == "wall_profile")
            {
                // profile_mm: [[u, v], ...] with u along the wall from its start and v up from its base: an arch, a gable top
                var w = e as Wall ?? throw new InvalidOperationException($"{e.Id.Value} isn't a wall");
                if (!w.CanHaveProfileSketch()) throw new InvalidOperationException("this wall can't have an edited profile (curved or stacked)");
                if (w.SketchId == ElementId.InvalidElementId)
                    using (var t = new Transaction(doc, "FMC profile sketch")) { t.Start(); w.CreateProfileSketch(); t.Commit(); }
                sketch = (Sketch)doc.GetElement(w.SketchId);
                var line = (Line)((LocationCurve)w.Location).Curve;
                double baseZ = (doc.GetElement(w.LevelId) as Level)?.Elevation ?? 0;
                baseZ += w.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0;
                XYZ s0 = line.GetEndPoint(0), dir = line.Direction;
                map = (u, v) => new XYZ(s0.X + dir.X * Ft(u), s0.Y + dir.Y * Ft(u), baseZ + Ft(v));
            }
            else
            {
                ElementId sid = (e as Floor)?.SketchId ?? (e as Ceiling)?.SketchId ?? ElementId.InvalidElementId;
                if (sid == ElementId.InvalidElementId)
                    sid = new FilteredElementCollector(doc).OfClass(typeof(Sketch)).Cast<Sketch>().FirstOrDefault(s => s.OwnerId == e.Id)?.Id ?? throw new InvalidOperationException($"{e.Id.Value} has no sketch to edit");
                sketch = (Sketch)doc.GetElement(sid);
                double z = sketch.SketchPlane.GetPlane().Origin.Z;
                map = (u, v) => new XYZ(Ft(u), Ft(v), z);
            }
            var raw = op["loops_mm"] as JArray ?? new JArray(op[name == "wall_profile" ? "profile_mm" : "outline_mm"] ?? throw new InvalidOperationException($"{name} needs {(name == "wall_profile" ? "profile_mm" : "outline_mm or loops_mm")}"));
            int curves = 0;
            using (var scope = new SketchEditScope(doc, "FMC " + name))
            {
                scope.Start(sketch.Id);
                using (var t = new Transaction(doc, "FMC " + name + " curves"))
                {
                    t.Start();
                    var fo = t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new Quiet()); t.SetFailureHandlingOptions(fo);
                    foreach (ElementId old in sketch.GetAllElements().Where(id => doc.GetElement(id) is CurveElement).ToList()) doc.Delete(old);
                    foreach (JArray loop in raw.OfType<JArray>())
                    {
                        var p = loop.OfType<JArray>().Select(q => map(q[0].Value<double>(), q[1].Value<double>())).ToList();
                        for (int i = 0; i < p.Count; i++) { doc.Create.NewModelCurve(Line.CreateBound(p[i], p[(i + 1) % p.Count]), sketch.SketchPlane); curves++; }
                    }
                    t.Commit();
                }
                try { scope.Commit(new Quiet()); }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Revit refused the {(name == "wall_profile" ? "profile" : "sketch")} ({ex.Message}): each loop must be closed and not cross " +
                        "itself or another loop; an opening inside a wall profile must not touch the outline (an opening at the base is part of the outline)");
                }
            }
            return new JObject { [name] = e.Id.Value, ["curves"] = curves };
        }
    }
}
