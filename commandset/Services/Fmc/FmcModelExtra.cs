using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's group 9 ops (owner 26 Oct): roof_extrusion, fascia, gutter, slab_edge, curtain_system_by_face,
    /// building_pad, swept_blend, model_text (families), copy_to_views, copy_to_levels (Paste Aligned), starting_view,
    /// work_plane, zone, panel_schedule, view_list.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject ExtraOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "roof_extrusion":
                {
                    // profile_mm [[u, z], ...] (an open line, u along the reference plane), extruded from start_mm to end_mm
                    ReferencePlane rp = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>()
                        .FirstOrDefault(r => string.Equals(r.Name, op.Value<string>("plane"), StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException("roof_extrusion needs plane (a named vertical reference plane: make one with reference_plane)");
                    Plane p = rp.GetPlane();
                    XYZ along = p.XVec.Z == 0 ? p.XVec : p.YVec;
                    var pts = (op["profile_mm"] as JArray ?? throw new InvalidOperationException("roof_extrusion needs profile_mm [[u, z], ...]")).OfType<JArray>()
                        .Select(q => p.Origin + along * Ft(q[0].Value<double>()) + XYZ.BasisZ * (Ft(q[1].Value<double>()) - p.Origin.Z)).ToList();
                    var prof = new CurveArray();
                    for (int i = 0; i + 1 < pts.Count; i++) prof.Append(Line.CreateBound(pts[i], pts[i + 1]));
                    RoofType rt = (RoofType)doc.GetElement(TypeOf<RoofType>(doc, op));
                    ExtrusionRoof r = doc.Create.NewExtrusionRoof(prof, rp, LevelOf(doc, op["level"]), rt, Ft(op.Value<double?>("start_mm") ?? 0), Ft(op.Value<double?>("end_mm") ?? 5000));
                    created.Add(r.Id);
                    return new JObject { ["roof"] = r.Id.Value };
                }
                case "fascia":
                case "gutter":
                case "slab_edge":
                {
                    // along the host's outer edges: a roof's eaves (lowest level edges) or a floor's top edges
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException($"{name} needs host"));
                    var edges = Edges(host, name == "slab_edge");
                    Element e;
                    if (name == "fascia") e = doc.Create.NewFascia((FasciaType)doc.GetElement(TypeOf<FasciaType>(doc, op)), edges);
                    else if (name == "gutter") e = doc.Create.NewGutter((GutterType)doc.GetElement(TypeOf<GutterType>(doc, op)), edges);
                    else e = doc.Create.NewSlabEdge((SlabEdgeType)doc.GetElement(TypeOf<SlabEdgeType>(doc, op)), edges);
                    created.Add(e.Id);
                    return new JObject { [name] = e.Id.Value, ["edges"] = edges.Size };
                }
                case "curtain_system_by_face":
                {
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("curtain_system_by_face needs host (a mass)"));
                    var faces = new ReferenceArray();
                    foreach (JArray p in PointList(op)) faces.Append(FaceNear(host, Vec(p, "points_mm: a point on each face")));
                    var types = new FilteredElementCollector(doc).OfClass(typeof(CurtainSystemType)).Cast<CurtainSystemType>().ToList();
                    ElementId t = TypeFor(doc, op, types.Select(x => x.Id).ToList(), types.First().Id);
                    var ids = doc.Create.NewCurtainSystem2(faces, (CurtainSystemType)doc.GetElement(t));
                    created.AddRange(ids);
                    return new JObject { ["curtain_systems"] = ids.Count };
                }
                case "building_pad":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(BuildingPadType)).ToElementIds();
                    // night test 26 Oct: a model with no pad type gets Revit's default one
                    if (types.Count == 0) types = new List<ElementId> { BuildingPadType.CreateDefault(doc).Id };
                    var bp = BuildingPad.Create(doc, TypeFor(doc, op, types, types.First()), level.Id,
                        Loops(op).Select(l => CurveLoop.CreateViaTransform(l, Transform.CreateTranslation(new XYZ(0, 0, level.Elevation)))).ToList());
                    created.Add(bp.Id);
                    return new JObject { ["pad"] = bp.Id.Value };
                }
                case "swept_blend":
                {
                    // path_mm (two points, a line in plan); bottom_mm and top_mm profiles [u, v] (u across, v up) at each end
                    Fam(doc, name);
                    var path = Points(op["path_mm"], "swept_blend needs path_mm [[x, y], [x, y]]");
                    XYZ along = (path[1] - path[0]).Normalize(), across = along.CrossProduct(XYZ.BasisZ).Normalize();
                    SweepProfile Prof(JToken t, XYZ at) => doc.Application.Create.NewCurveLoopsProfile(Profile(t, (u, v) => at + across * Ft(u) + XYZ.BasisZ * Ft(v), false));
                    var sp = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, path[0].Z)));
                    SweptBlend sb = doc.FamilyCreate.NewSweptBlend(op.Value<bool?>("solid") ?? true, Line.CreateBound(path[0], path[1]), sp, Prof(op["bottom_mm"], path[0]), Prof(op["top_mm"], path[1]));
                    return Formed(doc, sb, op, created);
                }
                case "model_text":
                {
                    Fam(doc, name);
                    var (sp, map) = PlaneOf(doc, op);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(ModelTextType)).Cast<ModelTextType>().ToList();
                    var at = op["point_mm"] as JArray ?? new JArray(0, 0);
                    ModelText t = doc.FamilyCreate.NewModelText(op.Value<string>("text") ?? throw new InvalidOperationException("model_text needs text"),
                        types.FirstOrDefault(x => x.Name == op.Value<string>("type_name")) ?? types.First(), sp, map(at[0].Value<double>(), at[1].Value<double>()), HorizontalAlign.Left, Ft(op.Value<double?>("depth_mm") ?? 10));
                    created.Add(t.Id);
                    return new JObject { ["model_text"] = t.Id.Value };
                }
                case "copy_to_views":
                {
                    // Paste Aligned to selected views: view-specific elements (detail lines, text, tags...) from one view to others
                    View from = ViewOf(doc, op["from_view"], made);
                    var ids = Targets(doc, op, made, allowPinned: true);
                    foreach (JToken t in op["views"] as JArray ?? throw new InvalidOperationException("copy_to_views needs views"))
                        created.AddRange(ElementTransformUtils.CopyElements(from, ids, ViewOf(doc, t, made), Transform.Identity, new CopyPasteOptions()));
                    return new JObject { ["copied"] = created.Count };
                }
                case "copy_to_levels":
                {
                    // Paste Aligned to selected levels: model elements copied up or down by each level's height difference
                    var ids = Targets(doc, op, made, allowPinned: true);
                    Level from = op["from_level"] != null ? LevelOf(doc, op["from_level"]) : (Level)doc.GetElement(doc.GetElement(ids.First()).LevelId);
                    foreach (JToken t in op["levels"] as JArray ?? throw new InvalidOperationException("copy_to_levels needs levels"))
                    {
                        Level to = LevelOf(doc, t);
                        var copies = ElementTransformUtils.CopyElements(doc, ids, new XYZ(0, 0, to.Elevation - from.Elevation));
                        foreach (ElementId c in copies)
                        {
                            Element e = doc.GetElement(c);
                            Parameter lv = e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT) ?? e.get_Parameter(BuiltInParameter.LEVEL_PARAM) ?? e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM);
                            if (lv != null && !lv.IsReadOnly) { try { lv.Set(to.Id); } catch (Exception) { /* Revit keeps its own */ } }
                        }
                        created.AddRange(copies);
                    }
                    return new JObject { ["copied"] = created.Count };
                }
                case "starting_view":
                    StartingViewSettings.GetStartingViewSettings(doc).ViewId = ViewOf(doc, op["view"], made).Id;
                    return new JObject { ["starting_view"] = op["view"] };
                case "work_plane":
                {
                    View v = ViewOf(doc, op["view"], made);
                    v.SketchPlane = op["level"] != null ? SketchPlane.Create(doc, LevelOf(doc, op["level"]).Id) : PlaneOf(doc, op).Item1;
                    if (op.Value<bool?>("show") == true) v.ShowActiveWorkPlane();
                    return new JObject { ["work_plane"] = v.SketchPlane.Name };
                }
                case "zone":
                {
                    Level level = LevelOf(doc, op["level"]);
                    Phase ph = doc.Phases.Cast<Phase>().Last();
                    Zone z = doc.Create.NewZone(level, ph);
                    if (op["name"] != null) z.Name = op.Value<string>("name");
                    var spaces = new SpaceSet();
                    foreach (ElementId id in (op["spaces"] as JArray ?? new JArray()).Select(t => Ref(doc, t, made))) spaces.Insert((Space)doc.GetElement(id));
                    if (!spaces.IsEmpty) z.AddSpaces(spaces);
                    created.Add(z.Id);
                    return new JObject { ["zone"] = z.Id.Value };
                }
                case "panel_schedule":
                {
                    var ids = new JArray();
                    foreach (ElementId id in Targets(doc, op, made)) { var ps = PanelScheduleView.CreateInstanceView(doc, id); created.Add(ps.Id); ids.Add(ps.Id.Value); }
                    return new JObject { ["panel_schedules"] = ids };
                }
                case "view_list":
                {
                    ViewSchedule vs = ViewSchedule.CreateViewList(doc);
                    if (op["name"] != null) vs.Name = op.Value<string>("name");
                    created.Add(vs.Id);
                    return new JObject { ["view_list"] = vs.Id.Value };
                }
                case "reveal_hidden":
                {
                    View v = ViewOf(doc, op["view"], made);
                    if (op.Value<bool?>("on") ?? true) v.EnableRevealHiddenMode(); else v.DisableTemporaryViewMode(TemporaryViewMode.RevealHiddenElements);
                    return new JObject { ["reveal_hidden"] = v.Name };
                }
                default: return null;
            }
        }

        /// <summary>Edge references along a roof's eaves (its lowest horizontal edges) or a floor's top outline.</summary>
        private static ReferenceArray Edges(Element host, bool top)
        {
            var opt = new Options { ComputeReferences = true };
            var all = new List<Edge>();
            foreach (Solid s in Solids(host.get_Geometry(opt))) foreach (Edge e in s.Edges) all.Add(e);
            var flat = all.Where(e => { var c = e.AsCurve(); return Math.Abs(c.GetEndPoint(0).Z - c.GetEndPoint(1).Z) < 1e-6 && e.Reference != null; }).ToList();
            if (flat.Count == 0) throw new InvalidOperationException($"{host.Id.Value} has no level edges");
            double z = top ? flat.Max(e => e.AsCurve().GetEndPoint(0).Z) : flat.Min(e => e.AsCurve().GetEndPoint(0).Z);
            var refs = new ReferenceArray();
            foreach (Edge e in flat.Where(e => Math.Abs(e.AsCurve().GetEndPoint(0).Z - z) < 1e-4)) refs.Append(e.Reference);
            return refs;
        }
    }
}
