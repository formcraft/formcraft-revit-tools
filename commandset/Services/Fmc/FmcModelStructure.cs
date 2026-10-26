using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's structure ops (owner 26 Oct, tools group 5): column (structural or architectural), beam, brace,
    /// isolated_foundation, wall_foundation, foundation_slab, structural_floor, truss, beam_system, rebar, area_reinforcement,
    /// path_reinforcement, fabric_area, coping, point_load, line_load, area_load, load_case, analytical_member.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject StructureOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "column":
                {
                    bool structural = op.Value<bool?>("structural") ?? true;
                    Level bottom = LevelOf(doc, op["level"]);
                    var sym = Symbol(doc, op, structural ? BuiltInCategory.OST_StructuralColumns : BuiltInCategory.OST_Columns);
                    var made2 = new JArray();
                    foreach (JArray p in PointList(op))
                    {
                        XYZ at = Vec(p, "points_mm are [x, y]");
                        FamilyInstance c = doc.Create.NewFamilyInstance(new XYZ(at.X, at.Y, bottom.Elevation), sym, bottom, structural ? StructuralType.Column : StructuralType.NonStructural);
                        if (op["top_level"] != null) c.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM)?.Set(LevelOf(doc, op["top_level"]).Id);
                        if (op["base_offset_mm"] != null) c.get_Parameter(BuiltInParameter.FAMILY_BASE_LEVEL_OFFSET_PARAM)?.Set(Ft(op.Value<double>("base_offset_mm")));
                        if (op["top_offset_mm"] != null) c.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM)?.Set(Ft(op.Value<double>("top_offset_mm")));
                        if (op["rotation_deg"] != null) ElementTransformUtils.RotateElement(doc, c.Id, Line.CreateBound(at, at + XYZ.BasisZ), op.Value<double>("rotation_deg") * Math.PI / 180);
                        created.Add(c.Id); made2.Add(c.Id.Value);
                    }
                    return new JObject { ["columns"] = made2 };
                }
                case "beam":
                case "brace":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var sym = Symbol(doc, op, BuiltInCategory.OST_StructuralFraming);
                    var s = Vec(op["start_mm"], $"{name} needs start_mm [x, y, z]"); var e = Vec(op["end_mm"], $"{name} needs end_mm [x, y, z]");
                    double z = level.Elevation;
                    Line l = Line.CreateBound(new XYZ(s.X, s.Y, z + s.Z), new XYZ(e.X, e.Y, z + e.Z));
                    FamilyInstance b = doc.Create.NewFamilyInstance(l, sym, level, name == "beam" ? StructuralType.Beam : StructuralType.Brace);
                    created.Add(b.Id);
                    return new JObject { [name] = b.Id.Value };
                }
                case "isolated_foundation":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var sym = Symbol(doc, op, BuiltInCategory.OST_StructuralFoundation);
                    var ids = new JArray();
                    foreach (JArray p in PointList(op))
                    {
                        XYZ at = Vec(p, "points_mm are [x, y]");
                        var f = doc.Create.NewFamilyInstance(new XYZ(at.X, at.Y, level.Elevation), sym, level, StructuralType.Footing);
                        created.Add(f.Id); ids.Add(f.Id.Value);
                    }
                    return new JObject { ["foundations"] = ids };
                }
                case "wall_foundation":
                {
                    var types = new FilteredElementCollector(doc).OfClass(typeof(WallFoundationType)).ToElementIds();
                    ElementId t = TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException("the model has no wall foundation type"));
                    foreach (ElementId w in Targets(doc, op, made)) created.Add(WallFoundation.Create(doc, t, w).Id);
                    return new JObject { ["wall_foundations"] = created.Count };
                }
                case "foundation_slab":
                case "structural_floor":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(FloorType)).Cast<FloorType>().Where(f => name == "foundation_slab" ? f.IsFoundationSlab : !f.IsFoundationSlab).Select(f => f.Id).ToList();
                    if (types.Count == 0) throw new InvalidOperationException($"the model has no {(name == "foundation_slab" ? "foundation slab" : "floor")} type");
                    var loops = Loops(op).Select(l => { var t = Transform.CreateTranslation(new XYZ(0, 0, level.Elevation)); return CurveLoop.CreateViaTransform(l, t); }).ToList();
                    Floor f = Floor.Create(doc, loops, TypeFor(doc, op, types, types[0]), level.Id, true, null, 0);
                    if (op["offset_mm"] != null) f.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(Ft(op.Value<double>("offset_mm")));
                    created.Add(f.Id);
                    return new JObject { ["floor"] = f.Id.Value };
                }
                case "truss":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var types = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Truss).WhereElementIsElementType().ToElementIds();
                    var s = Vec(op["start_mm"], "truss needs start_mm"); var e = Vec(op["end_mm"], "truss needs end_mm");
                    var a = new XYZ(s.X, s.Y, level.Elevation + s.Z); var b = new XYZ(e.X, e.Y, level.Elevation + e.Z);
                    SketchPlane sp = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin((b - a).Normalize().CrossProduct(XYZ.BasisZ).Normalize(), a));
                    Truss t = Truss.Create(doc, TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException("the model has no truss type")), sp.Id, Line.CreateBound(a, b));
                    created.Add(t.Id);
                    return new JObject { ["truss"] = t.Id.Value };
                }
                case "beam_system":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var pts = Points(op["outline_mm"], "beam_system needs outline_mm");
                    var curves = new List<Curve>();
                    for (int i = 0; i < pts.Count; i++) curves.Add(Line.CreateBound(new XYZ(pts[i].X, pts[i].Y, level.Elevation), new XYZ(pts[(i + 1) % pts.Count].X, pts[(i + 1) % pts.Count].Y, level.Elevation)));
                    BeamSystem bs = BeamSystem.Create(doc, curves, level, op.Value<int?>("direction_edge") ?? 0, false);
                    if (op["type_name"] != null || op["type_id"] != null)
                    {
                        var fr = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_StructuralFraming).WhereElementIsElementType().ToElementIds();
                        bs.BeamType = (FamilySymbol)doc.GetElement(TypeFor(doc, op, fr));
                    }
                    if (op["spacing_mm"] != null) bs.LayoutRule = new LayoutRuleFixedDistance(Ft(op.Value<double>("spacing_mm")), BeamSystemJustifyType.Center);
                    created.Add(bs.Id);
                    return new JObject { ["beam_system"] = bs.Id.Value };
                }
                case "rebar":
                {
                    // bars from polylines (curves_mm: [[[x, y, z], ...], ...]) in a host, normal_mm the plane they lie in
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("rebar needs host"));
                    var barTypes = new FilteredElementCollector(doc).OfClass(typeof(RebarBarType)).ToElementIds();
                    var bt = (RebarBarType)doc.GetElement(TypeFor(doc, new JObject { ["type_name"] = op["bar_type"] }, barTypes, barTypes.FirstOrDefault() ?? throw new InvalidOperationException("the model has no rebar bar type")));
                    XYZ normal = op["normal_mm"] != null ? Vec(op["normal_mm"], "normal_mm is a direction").Normalize() : XYZ.BasisY;
                    int n = 0;
                    foreach (JArray line in (op["curves_mm"] as JArray ?? throw new InvalidOperationException("rebar needs curves_mm")).OfType<JArray>())
                    {
                        var p = Points(line, "each bar is [[x, y, z], ...]");
                        var curves = new List<Curve>();
                        for (int i = 0; i + 1 < p.Count; i++) curves.Add(Line.CreateBound(p[i], p[i + 1]));
                        Rebar r = Rebar.CreateFromCurves(doc, RebarStyle.Standard, bt, null, null, host, normal, curves, RebarHookOrientation.Left, RebarHookOrientation.Left, true, true);
                        if (op["count"] != null && op["spacing_mm"] != null)
                            r.GetShapeDrivenAccessor().SetLayoutAsNumberWithSpacing(op.Value<int>("count"), Ft(op.Value<double>("spacing_mm")), true, true, true);
                        created.Add(r.Id); n++;
                    }
                    return new JObject { ["rebar"] = n };
                }
                case "area_reinforcement":
                case "path_reinforcement":
                case "fabric_area":
                {
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException($"{name} needs host (a floor, wall or foundation)"));
                    var pts = Points(op[name == "path_reinforcement" ? "path_mm" : "outline_mm"], $"{name} needs {(name == "path_reinforcement" ? "path_mm" : "outline_mm")}");
                    var curves = new List<Curve>();
                    int n = name == "path_reinforcement" ? pts.Count - 1 : pts.Count;
                    for (int i = 0; i < n; i++) curves.Add(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                    var barTypes = new FilteredElementCollector(doc).OfClass(typeof(RebarBarType)).ToElementIds();
                    ElementId bar = TypeFor(doc, new JObject { ["type_name"] = op["bar_type"] }, barTypes, barTypes.FirstOrDefault());
                    Element made2;
                    if (name == "area_reinforcement")
                    {
                        var t = new FilteredElementCollector(doc).OfClass(typeof(AreaReinforcementType)).FirstElementId();
                        made2 = AreaReinforcement.Create(doc, host, curves, (curves[0] as Line).Direction, t, bar, ElementId.InvalidElementId);
                    }
                    else if (name == "path_reinforcement")
                    {
                        var t = new FilteredElementCollector(doc).OfClass(typeof(PathReinforcementType)).FirstElementId();
                        made2 = PathReinforcement.Create(doc, host, curves, op.Value<bool?>("flip") ?? false, t, bar, ElementId.InvalidElementId, ElementId.InvalidElementId);
                    }
                    else
                    {
                        var at = new FilteredElementCollector(doc).OfClass(typeof(FabricAreaType)).FirstElementId();
                        var st = new FilteredElementCollector(doc).OfClass(typeof(FabricSheetType)).FirstElementId();
                        var loop = CurveLoop.Create(curves);
                        made2 = FabricArea.Create(doc, host, new List<CurveLoop> { loop }, (curves[0] as Line).Direction, curves[0].GetEndPoint(0), at, st);
                    }
                    created.Add(made2.Id);
                    return new JObject { [name] = made2.Id.Value };
                }
                case "coping":
                {
                    // ids: [beam or column, the element it's coped to, ...]; remove true takes the coping off
                    var ids = Targets(doc, op, made).ToList();
                    if (ids.Count < 2) throw new InvalidOperationException("coping needs ids [element, cutter, ...]");
                    var fi = doc.GetElement(ids[0]) as FamilyInstance ?? throw new InvalidOperationException("coping works on structural framing and columns");
                    foreach (ElementId id in ids.Skip(1))
                    {
                        var other = (FamilyInstance)doc.GetElement(id);
                        if (op.Value<bool?>("remove") == true) fi.RemoveCoping(other); else fi.AddCoping(other);
                    }
                    return new JObject { ["coped"] = ids.Count - 1 };
                }
                case "point_load":
                case "line_load":
                case "area_load":
                {
                    // force_kn [fx, fy, fz] (down is negative z); moment_knm optional
                    XYZ force = KN(op["force_kn"] ?? throw new InvalidOperationException($"{name} needs force_kn [fx, fy, fz]"));
                    XYZ moment = op["moment_knm"] != null ? KN(op["moment_knm"]) * 3.28084 : XYZ.Zero;
                    Element load;
                    // host: the analytical member or panel it acts on (Revit 2025 hosts loads); none for a free load
                    ElementId host = Ref(doc, op["host"], made) ?? ElementId.InvalidElementId;
                    if (name == "point_load") load = PointLoad.Create(doc, host, Vec(op["point_mm"], "point_load needs point_mm"), force, moment, null);
                    else if (name == "line_load") load = LineLoad.Create(doc, host, Line.CreateBound(Vec(op["start_mm"], "line_load needs start_mm"), Vec(op["end_mm"], "line_load needs end_mm")), force, moment, null);
                    else load = AreaLoad.Create(doc, host, Loops(op), force, null);
                    if (op["load_case"] != null)
                    {
                        ElementId lc = new FilteredElementCollector(doc).OfClass(typeof(LoadCase)).FirstOrDefault(c => string.Equals(c.Name, op.Value<string>("load_case"), StringComparison.OrdinalIgnoreCase))?.Id
                            ?? throw new InvalidOperationException($"no load case {op.Value<string>("load_case")}");
                        load.get_Parameter(BuiltInParameter.LOAD_CASE_ID)?.Set(lc);
                    }
                    created.Add(load.Id);
                    return new JObject { [name] = load.Id.Value };
                }
                case "load_case":
                {
                    string lname = op.Value<string>("name") ?? throw new InvalidOperationException("load_case needs name");
                    var nature = new FilteredElementCollector(doc).OfClass(typeof(LoadNature)).FirstOrDefault(n => string.Equals(n.Name, op.Value<string>("nature") ?? "Dead", StringComparison.OrdinalIgnoreCase))
                        ?? LoadNature.Create(doc, op.Value<string>("nature") ?? "Dead");
                    var cat = (op.Value<string>("category") ?? "dead").ToLowerInvariant() == "live" ? new ElementId(BuiltInCategory.OST_LoadCasesLive) : new ElementId(BuiltInCategory.OST_LoadCasesDead);
                    LoadCase lc = LoadCase.Create(doc, lname, nature.Id, cat);
                    created.Add(lc.Id);
                    return new JObject { ["load_case"] = lc.Id.Value };
                }
                case "analytical_member":
                {
                    var s = Vec(op["start_mm"], "analytical_member needs start_mm [x, y, z]"); var e = Vec(op["end_mm"], "analytical_member needs end_mm");
                    AnalyticalMember m = AnalyticalMember.Create(doc, Line.CreateBound(s, e));
                    created.Add(m.Id);
                    return new JObject { ["analytical_member"] = m.Id.Value };
                }
                default: return null;
            }
        }

        private static XYZ KN(JToken t)
        {
            // kN to Revit's internal force units (kg·ft/s²): 1 kN = 1000 N; 1 N = 3.28084 kg·ft/s²
            var a = (JArray)t;
            double k = 1000 * 3.28084;
            return new XYZ(a[0].Value<double>() * k, a[1].Value<double>() * k, a[2].Value<double>() * k);
        }

        private static JArray PointList(JObject op) =>
            op["points_mm"] as JArray ?? (op["point_mm"] != null ? new JArray(op["point_mm"]) : throw new InvalidOperationException("the op needs point_mm or points_mm"));

        private static FamilySymbol Symbol(Document doc, JObject op, BuiltInCategory cat)
        {
            var types = new FilteredElementCollector(doc).OfCategory(cat).OfClass(typeof(FamilySymbol)).ToElementIds();
            if (types.Count == 0) throw new InvalidOperationException($"the model has no {cat.ToString().Replace("OST_", "")} type: load a family first");
            var sym = (FamilySymbol)doc.GetElement(TypeFor(doc, op, types, types.First()));
            if (!sym.IsActive) sym.Activate();
            return sym;
        }
    }
}
