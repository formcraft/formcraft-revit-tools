using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's MEP and site ops (owner 26 Oct, tools group 5): duct, pipe (or placeholders), flex_duct, flex_pipe,
    /// cable_tray, conduit, connect (elbow, tee or transition between two or three runs), insulation, lining,
    /// convert_placeholders, wire, space, space_separation, toposolid, toposolid_subdivision, mass_floors, wall_by_face,
    /// curtain_system_by_face. Run points are [x, y, z] in mm, z above the level.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject MepOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "duct":
                case "pipe":
                case "cable_tray":
                case "conduit":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var pts = Points(op["points_mm"], $"{name} needs points_mm, the run [[x, y, z], ...]").Select(p => p + new XYZ(0, 0, level.Elevation)).ToList();
                    bool placeholder = op.Value<bool?>("placeholder") ?? false;
                    var segs = new List<MEPCurve>();
                    for (int i = 0; i + 1 < pts.Count; i++)
                    {
                        MEPCurve c;
                        switch (name)
                        {
                            case "duct":
                            {
                                ElementId sys = SystemType<MechanicalSystemType>(doc, op), t = CurveType<DuctType>(doc, op);
                                c = placeholder ? Duct.CreatePlaceholder(doc, sys, t, level.Id, pts[i], pts[i + 1]) : Duct.Create(doc, sys, t, level.Id, pts[i], pts[i + 1]);
                                break;
                            }
                            case "pipe":
                            {
                                ElementId sys = SystemType<PipingSystemType>(doc, op), t = CurveType<PipeType>(doc, op);
                                c = placeholder ? Pipe.CreatePlaceholder(doc, sys, t, level.Id, pts[i], pts[i + 1]) : Pipe.Create(doc, sys, t, level.Id, pts[i], pts[i + 1]);
                                break;
                            }
                            case "cable_tray": c = CableTray.Create(doc, CurveType<CableTrayType>(doc, op), pts[i], pts[i + 1], level.Id); break;
                            default: c = Conduit.Create(doc, CurveType<ConduitType>(doc, op), pts[i], pts[i + 1], level.Id); break;
                        }
                        Size(c, op);
                        segs.Add(c); created.Add(c.Id);
                    }
                    // elbows at the corners, unless elbows false
                    if (!placeholder && (op.Value<bool?>("elbows") ?? true))
                        for (int i = 0; i + 1 < segs.Count; i++)
                        {
                            var (a, b) = Nearest(segs[i], segs[i + 1]);
                            try { created.Add(doc.Create.NewElbowFitting(a, b).Id); } catch (Exception) { /* no elbow in the routing preferences: left unjoined */ }
                        }
                    return new JObject { ["segments"] = segs.Count };
                }
                case "flex_duct":
                case "flex_pipe":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var pts = Points(op["points_mm"], $"{name} needs points_mm").Select(p => p + new XYZ(0, 0, level.Elevation)).ToList();
                    Element f = name == "flex_duct"
                        ? (Element)FlexDuct.Create(doc, SystemType<MechanicalSystemType>(doc, op), CurveType<FlexDuctType>(doc, op), level.Id, pts)
                        : FlexPipe.Create(doc, SystemType<PipingSystemType>(doc, op), CurveType<FlexPipeType>(doc, op), level.Id, pts);
                    created.Add(f.Id);
                    return new JObject { [name] = f.Id.Value };
                }
                case "connect":
                {
                    // ids: two runs (elbow, or transition when they're in line) or three (tee: the first two in line)
                    var ids = Targets(doc, op, made).Select(id => doc.GetElement(id) as MEPCurve ?? throw new InvalidOperationException($"{id.Value} isn't a duct, pipe, tray or conduit")).ToList();
                    FamilyInstance fit;
                    if (ids.Count == 3)
                    {
                        var (a, b) = Nearest(ids[0], ids[1]); var c = Nearest(ids[2], ids[0]).Item1;
                        fit = doc.Create.NewTeeFitting(a, b, c);
                    }
                    else if (ids.Count == 2)
                    {
                        var (a, b) = Nearest(ids[0], ids[1]);
                        bool inLine = a.CoordinateSystem.BasisZ.IsAlmostEqualTo(b.CoordinateSystem.BasisZ.Negate());
                        fit = inLine ? doc.Create.NewTransitionFitting(a, b) : doc.Create.NewElbowFitting(a, b);
                    }
                    else throw new InvalidOperationException("connect needs two or three ids");
                    created.Add(fit.Id);
                    return new JObject { ["fitting"] = fit.Id.Value };
                }
                case "insulation":
                case "lining":
                {
                    double t = Ft(op.Value<double?>("thickness_mm") ?? 25);
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        Element e = doc.GetElement(id);
                        Element made2 = name == "lining"
                            ? DuctLining.Create(doc, id, new FilteredElementCollector(doc).OfClass(typeof(DuctLiningType)).FirstElementId(), t)
                            : e is Pipe || e.Category?.Id.Value == (long)BuiltInCategory.OST_PipeFitting || e.Category?.Id.Value == (long)BuiltInCategory.OST_PipeAccessory
                                ? (Element)PipeInsulation.Create(doc, id, new FilteredElementCollector(doc).OfClass(typeof(PipeInsulationType)).FirstElementId(), t)
                                : DuctInsulation.Create(doc, id, new FilteredElementCollector(doc).OfClass(typeof(DuctInsulationType)).FirstElementId(), t);
                        created.Add(made2.Id);
                    }
                    return new JObject { [name] = created.Count };
                }
                case "convert_placeholders":
                {
                    var ids = Targets(doc, op, made);
                    var ducts = ids.Where(i => doc.GetElement(i) is Duct).ToList(); var pipes = ids.Where(i => doc.GetElement(i) is Pipe).ToList();
                    if (ducts.Count > 0) created.AddRange(MechanicalUtils.ConvertDuctPlaceholders(doc, ducts));
                    if (pipes.Count > 0) created.AddRange(PlumbingUtils.ConvertPipePlaceholders(doc, pipes));
                    return new JObject { ["converted"] = ducts.Count + pipes.Count };
                }
                case "wire":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var pts = Points(op["points_mm"], "wire needs points_mm in the plan");
                    var types = new FilteredElementCollector(doc).OfClass(typeof(WireType)).ToElementIds();
                    var kind = (op.Value<string>("style") ?? "arc") switch { "chamfer" => WiringType.Chamfer, _ => WiringType.Arc };
                    Wire w = Wire.Create(doc, TypeFor(doc, op, types, types.First()), v.Id, kind, pts, null, null);
                    created.Add(w.Id);
                    return new JObject { ["wire"] = w.Id.Value };
                }
                case "space":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var ids = new JArray();
                    foreach (JArray p in PointList(op))
                    {
                        XYZ at = Vec(p, "points_mm are [x, y]");
                        Space s = doc.Create.NewSpace(level, new UV(at.X, at.Y));
                        if (op["name"] != null) s.Name = op.Value<string>("name");
                        created.Add(s.Id); ids.Add(s.Id.Value);
                    }
                    return new JObject { ["spaces"] = ids };
                }
                case "space_separation":
                {
                    Level level = LevelOf(doc, op["level"]);
                    View plan = PlanOf(doc, op["level"]);
                    var lines = new CurveArray();
                    foreach (JArray seg in (op["lines_mm"] as JArray ?? throw new InvalidOperationException("space_separation needs lines_mm")).OfType<JArray>())
                    {
                        var p = Points(seg, "each line is [[x, y], [x, y]]");
                        lines.Append(Line.CreateBound(new XYZ(p[0].X, p[0].Y, level.Elevation), new XYZ(p[1].X, p[1].Y, level.Elevation)));
                    }
                    var made2 = doc.Create.NewSpaceBoundaryLines(SketchPlane.Create(doc, level.Id), lines, plan);
                    foreach (ModelCurve c in made2) created.Add(c.Id);
                    return new JObject { ["lines"] = made2.Size };
                }
                case "toposolid":
                {
                    // points_mm: survey points [x, y, z]; or outline_mm (flat) at the level; type_name optional
                    Level level = LevelOf(doc, op["level"]);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(ToposolidType)).ToElementIds();
                    ElementId t = TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException("the model has no toposolid type"));
                    Toposolid ts;
                    if (op["points_mm"] != null)
                    {
                        var pts = Points(op["points_mm"], "points_mm are [x, y, z]");
                        ts = op["outline_mm"] != null ? Toposolid.Create(doc, Loops(op), pts, t, level.Id) : Toposolid.Create(doc, pts, t, level.Id);
                    }
                    else ts = Toposolid.Create(doc, Loops(op), t, level.Id);
                    created.Add(ts.Id);
                    return new JObject { ["toposolid"] = ts.Id.Value };
                }
                case "toposolid_subdivision":
                {
                    var ts = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("toposolid_subdivision needs host (the toposolid)")) as Toposolid ?? throw new InvalidOperationException("host isn't a toposolid");
                    Toposolid sub = ts.CreateSubDivision(doc, Loops(op));
                    if (op["material"] != null) sub.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.Set(MaterialId(doc, op.Value<string>("material")));
                    created.Add(sub.Id);
                    return new JObject { ["subdivision"] = sub.Id.Value };
                }
                case "mass_floors":
                {
                    // ids: masses; levels: the levels to slice them at
                    var levels = (op["levels"] as JArray ?? throw new InvalidOperationException("mass_floors needs levels")).Select(l => LevelOf(doc, l).Id).ToList();
                    int n = 0;
                    foreach (ElementId m in Targets(doc, op, made)) foreach (ElementId l in levels) { MassInstanceUtils.AddMassLevelDataToMassInstance(doc, m, l); n++; }
                    return new JObject { ["mass_floors"] = n };
                }
                case "wall_by_face":
                {
                    // the face of a mass (or generic model) facing point_mm
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("wall_by_face needs host (a mass)"));
                    var types = new FilteredElementCollector(doc).OfClass(typeof(WallType)).ToElementIds();
                    Reference face = FaceNear(host, Vec(op["point_mm"], "wall_by_face needs point_mm on or near the face"));
                    FaceWall fw = FaceWall.Create(doc, TypeFor(doc, op, types, types.First()), WallLocationLine.CoreCenterline, face);
                    created.Add(fw.Id);
                    return new JObject { ["wall"] = fw.Id.Value };
                }
                default: return null;
            }
        }

        private static void Size(MEPCurve c, JObject op)
        {
            if (op["diameter_mm"] != null)
                (c.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM))?.Set(Ft(op.Value<double>("diameter_mm")));
            if (op["width_mm"] != null) (c.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CABLETRAY_WIDTH_PARAM))?.Set(Ft(op.Value<double>("width_mm")));
            if (op["height_mm"] != null) (c.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CABLETRAY_HEIGHT_PARAM))?.Set(Ft(op.Value<double>("height_mm")));
        }

        private static (Connector, Connector) Nearest(MEPCurve a, MEPCurve b)
        {
            Connector best1 = null, best2 = null; double d = double.MaxValue;
            foreach (Connector x in a.ConnectorManager.Connectors)
                foreach (Connector y in b.ConnectorManager.Connectors)
                {
                    double dd = x.Origin.DistanceTo(y.Origin);
                    if (dd < d) { d = dd; best1 = x; best2 = y; }
                }
            return (best1, best2);
        }

        private static ElementId SystemType<T>(Document doc, JObject op) where T : Element
        {
            var all = new FilteredElementCollector(doc).OfClass(typeof(T)).ToElementIds();
            if (all.Count == 0) throw new InvalidOperationException($"the model has no {typeof(T).Name}");
            return TypeFor(doc, new JObject { ["type_name"] = op["system"] }, all, all.First());
        }

        private static ElementId CurveType<T>(Document doc, JObject op) where T : ElementType => TypeOf<T>(doc, op);

        private static Reference FaceNear(Element e, XYZ p)
        {
            var opt = new Options { ComputeReferences = true };
            Reference best = null; double d = double.MaxValue;
            foreach (Solid s in Solids(e.get_Geometry(opt)))
                foreach (Face f in s.Faces)
                {
                    IntersectionResult r = f.Project(p);
                    if (r != null && r.Distance < d && f.Reference != null) { d = r.Distance; best = f.Reference; }
                }
            return best ?? throw new InvalidOperationException($"no face of {e.Id.Value} near that point");
        }
    }
}
