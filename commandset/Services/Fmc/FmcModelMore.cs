using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Analysis;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's group 6 ops (owner 26 Oct): wall_sweep, curtain_grid, mullions, wall_opening, area_plan, area,
    /// area_boundary, create_schedule, revision; and the remaining Modify tools: radial_array, offset, split, extend,
    /// wall_join, create_group, place_group, ungroup, assembly, parts, displace, paint, remove_paint, demolish,
    /// path_of_travel, energy_model.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject MoreOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "wall_sweep":
                {
                    bool reveal = op.Value<bool?>("reveal") ?? false;
                    var types = new FilteredElementCollector(doc).OfCategory(reveal ? BuiltInCategory.OST_Reveals : BuiltInCategory.OST_Cornices).WhereElementIsElementType().ToElementIds();
                    ElementId t = TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException($"the model has no wall {(reveal ? "reveal" : "sweep")} type"));
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        var info = new WallSweepInfo(reveal ? WallSweepType.Reveal : WallSweepType.Sweep, false)
                        {
                            Distance = Ft(op.Value<double?>("height_mm") ?? 0),
                            WallSide = (op.Value<string>("side") ?? "exterior") == "interior" ? WallSide.Interior : WallSide.Exterior,
                        };
                        created.Add(WallSweep.Create((Wall)doc.GetElement(id), t, info).Id);
                    }
                    return new JObject { [reveal ? "reveals" : "sweeps"] = created.Count };
                }
                case "curtain_grid":
                {
                    // vertical_mm: distances along the wall from its start; horizontal_mm: heights above its base
                    var w = doc.GetElement(Ref(doc, op["wall"], made)) as Wall ?? throw new InvalidOperationException("curtain_grid needs wall (a curtain wall)");
                    CurtainGrid g = w.CurtainGrid ?? throw new InvalidOperationException($"{w.Id.Value} isn't a curtain wall");
                    var line = (Line)((LocationCurve)w.Location).Curve;
                    double baseZ = line.GetEndPoint(0).Z + (w.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0);
                    double height = w.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble() ?? 10;
                    int n = 0;
                    foreach (double d in (op["vertical_mm"] as JArray ?? new JArray()).Select(x => x.Value<double>()))
                    { XYZ p = line.GetEndPoint(0) + line.Direction * Ft(d); g.AddGridLine(false, new XYZ(p.X, p.Y, baseZ + height / 2), false); n++; }
                    foreach (double h in (op["horizontal_mm"] as JArray ?? new JArray()).Select(x => x.Value<double>()))
                    { XYZ p = line.Evaluate(0.5, true); g.AddGridLine(true, new XYZ(p.X, p.Y, baseZ + Ft(h)), false); n++; }
                    return new JObject { ["grid_lines"] = n };
                }
                case "mullions":
                {
                    var w = doc.GetElement(Ref(doc, op["wall"], made)) as Wall ?? throw new InvalidOperationException("mullions needs wall (a curtain wall)");
                    CurtainGrid g = w.CurtainGrid ?? throw new InvalidOperationException($"{w.Id.Value} isn't a curtain wall");
                    var types = new FilteredElementCollector(doc).OfClass(typeof(MullionType)).ToElementIds();
                    var mt = (MullionType)doc.GetElement(TypeFor(doc, op, types, types.First()));
                    int n = 0;
                    foreach (ElementId id in g.GetUGridLineIds().Concat(g.GetVGridLineIds()))
                    {
                        var gl = (CurtainGridLine)doc.GetElement(id);
                        foreach (Curve seg in gl.AllSegmentCurves) { try { gl.AddMullions(seg, mt, true); n++; } catch (Exception) { /* already has one */ } }
                    }
                    return new JObject { ["mullions"] = n };
                }
                case "wall_opening":
                {
                    var w = doc.GetElement(Ref(doc, op["wall"], made)) as Wall ?? throw new InvalidOperationException("wall_opening needs wall");
                    Opening o = doc.Create.NewOpening(w, Vec(op["start_mm"], "wall_opening needs start_mm [x, y, z]"), Vec(op["end_mm"], "wall_opening needs end_mm [x, y, z] (the opposite corner)"));
                    created.Add(o.Id);
                    return new JObject { ["opening"] = o.Id.Value };
                }
                case "area_plan":
                {
                    var schemes = new FilteredElementCollector(doc).OfClass(typeof(AreaScheme)).Cast<AreaScheme>().ToList();
                    AreaScheme sc = op["scheme"] != null ? schemes.FirstOrDefault(x => string.Equals(x.Name, op.Value<string>("scheme"), StringComparison.OrdinalIgnoreCase)) : schemes.FirstOrDefault();
                    ViewPlan v = ViewPlan.CreateAreaPlan(doc, (sc ?? throw new InvalidOperationException("no area scheme")).Id, LevelOf(doc, op["level"]).Id);
                    if (op["name"] != null) v.Name = op.Value<string>("name");
                    created.Add(v.Id);
                    return new JObject { ["area_plan"] = v.Id.Value, ["name"] = v.Name };
                }
                case "area":
                {
                    var v = ViewOf(doc, op["view"], made) as ViewPlan ?? throw new InvalidOperationException("area needs view (an area plan)");
                    var ids = new JArray();
                    foreach (JArray p in PointList(op)) { XYZ at = Vec(p, "points_mm are [x, y]"); var a = doc.Create.NewArea(v, new UV(at.X, at.Y)); created.Add(a.Id); ids.Add(a.Id.Value); }
                    return new JObject { ["areas"] = ids };
                }
                case "area_boundary":
                {
                    var v = ViewOf(doc, op["view"], made) as ViewPlan ?? throw new InvalidOperationException("area_boundary needs view (an area plan)");
                    var sp = SketchPlane.Create(doc, v.GenLevel.Id);
                    foreach (JArray seg in (op["lines_mm"] as JArray ?? throw new InvalidOperationException("area_boundary needs lines_mm")).OfType<JArray>())
                    {
                        var p = Points(seg, "each line is [[x, y], [x, y]]");
                        created.Add(doc.Create.NewAreaBoundaryLine(sp, Line.CreateBound(new XYZ(p[0].X, p[0].Y, v.GenLevel.Elevation), new XYZ(p[1].X, p[1].Y, v.GenLevel.Elevation)), v).Id);
                    }
                    return new JObject { ["lines"] = created.Count };
                }
                case "create_schedule":
                {
                    string kind = op.Value<string>("kind") ?? "schedule";
                    ElementId cat = op["category"] != null ? Categories(doc, new JArray(op.Value<string>("category")))[0] : ElementId.InvalidElementId;
                    ViewSchedule vs = kind switch
                    {
                        "material_takeoff" => ViewSchedule.CreateMaterialTakeoff(doc, cat),
                        "sheet_list" => ViewSchedule.CreateSheetList(doc),
                        "revision" => ViewSchedule.CreateRevisionSchedule(doc),
                        "keynote_legend" => ViewSchedule.CreateKeynoteLegend(doc),
                        "key" => ViewSchedule.CreateKeySchedule(doc, cat),
                        "note_block" => ViewSchedule.CreateNoteBlock(doc, new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                            .FirstOrDefault(f => string.Equals(f.Name, op.Value<string>("family"), StringComparison.OrdinalIgnoreCase))?.Id ?? throw new InvalidOperationException("note_block needs family (a generic annotation family)")),
                        _ => ViewSchedule.CreateSchedule(doc, cat),
                    };
                    if (op["name"] != null) vs.Name = op.Value<string>("name");
                    ScheduleDefinition def = vs.Definition;
                    var fields = new Dictionary<string, ScheduleFieldId>(StringComparer.OrdinalIgnoreCase);
                    foreach (string f in (op["fields"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    {
                        SchedulableField sf = def.GetSchedulableFields().FirstOrDefault(x => string.Equals(x.GetName(doc), f, StringComparison.OrdinalIgnoreCase))
                            ?? throw new InvalidOperationException($"{f} isn't a field of this schedule");
                        fields[f] = def.AddField(sf).FieldId;
                    }
                    foreach (string f in (op["sort"] as JArray ?? new JArray()).Select(x => x.ToString()))
                        if (fields.TryGetValue(f, out var fid)) def.AddSortGroupField(new ScheduleSortGroupField(fid));
                    if (op["itemize"] != null) def.IsItemized = op.Value<bool>("itemize");
                    created.Add(vs.Id);
                    return new JObject { ["schedule"] = vs.Id.Value, ["name"] = vs.Name, ["fields"] = fields.Count };
                }
                case "revision":
                {
                    Revision r = Revision.Create(doc);
                    if (op["description"] != null) r.Description = op.Value<string>("description");
                    if (op["date"] != null) r.RevisionDate = op.Value<string>("date");
                    if (op["issued_by"] != null) r.IssuedBy = op.Value<string>("issued_by");
                    if (op["issued_to"] != null) r.IssuedTo = op.Value<string>("issued_to");
                    created.Add(r.Id);
                    return new JObject { ["revision"] = r.SequenceNumber };
                }
                case "radial_array":
                {
                    var ids = Targets(doc, op, made);
                    XYZ c = op["center_mm"] != null ? Vec(op["center_mm"], "center_mm is [x, y]") : Centre(doc, ids);
                    int count = Math.Max(2, op.Value<int?>("count") ?? 4);
                    double total = (op.Value<double?>("angle_deg") ?? 360) * Math.PI / 180, step = total / (Math.Abs(total - 2 * Math.PI) < 1e-6 ? count : count - 1);
                    var axis = Line.CreateBound(c, c + XYZ.BasisZ);
                    for (int i = 1; i < count; i++)
                    {
                        var copies = ElementTransformUtils.CopyElements(doc, ids, XYZ.Zero);
                        ElementTransformUtils.RotateElements(doc, copies, axis, step * i);
                        created.AddRange(copies);
                    }
                    return new JObject { ["copies"] = count - 1 };
                }
                case "offset":
                {
                    // line-based elements moved (or copied, copy true) sideways by distance_mm, to the left of their direction
                    bool copy = op.Value<bool?>("copy") ?? true;
                    double dist = Ft(op.Value<double?>("distance_mm") ?? throw new InvalidOperationException("offset needs distance_mm"));
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        var lc = doc.GetElement(id).Location as LocationCurve ?? throw new InvalidOperationException($"{id.Value} isn't line-based");
                        XYZ dir = (lc.Curve.GetEndPoint(1) - lc.Curve.GetEndPoint(0)).Normalize();
                        XYZ v = XYZ.BasisZ.CrossProduct(dir) * dist;
                        if (copy) created.AddRange(ElementTransformUtils.CopyElement(doc, id, v)); else ElementTransformUtils.MoveElement(doc, id, v);
                    }
                    return new JObject { ["offset"] = op["ids"].Count(), ["copied"] = copy };
                }
                case "split":
                {
                    // a wall, beam, pipe... split at point_mm (with gap_mm between the parts, optional)
                    Element e = doc.GetElement(Ref(doc, op["id"], made) ?? throw new InvalidOperationException("split needs id"));
                    var lc = e.Location as LocationCurve ?? throw new InvalidOperationException($"{e.Id.Value} isn't line-based");
                    var line = lc.Curve as Line ?? throw new InvalidOperationException("only straight elements are split");
                    XYZ at = line.Project(Vec(op["point_mm"], "split needs point_mm")).XYZPoint;
                    double gap = Ft(op.Value<double?>("gap_mm") ?? 0) / 2;
                    XYZ a = line.GetEndPoint(0), b = line.GetEndPoint(1), d = line.Direction;
                    ElementId copy = ElementTransformUtils.CopyElement(doc, e.Id, XYZ.Zero).First();
                    lc.Curve = Line.CreateBound(a, at - d * gap);
                    ((LocationCurve)doc.GetElement(copy).Location).Curve = Line.CreateBound(at + d * gap, b);
                    created.Add(copy);
                    return new JObject { ["parts"] = new JArray(e.Id.Value, copy.Value) };
                }
                case "extend":
                {
                    // ids: elements whose nearer end moves to where their line meets target's (Trim/Extend to a boundary)
                    Element target = doc.GetElement(Ref(doc, op["target"], made) ?? throw new InvalidOperationException("extend needs target"));
                    var tl = ((target.Location as LocationCurve)?.Curve as Line) ?? throw new InvalidOperationException("target must be straight and line-based");
                    Line tUnbound = Line.CreateUnbound(Flat(tl.GetEndPoint(0)), Flat(tl.Direction));
                    int n = 0;
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        var lc = doc.GetElement(id).Location as LocationCurve; var l = lc?.Curve as Line ?? throw new InvalidOperationException($"{id.Value} must be straight and line-based");
                        Line u = Line.CreateUnbound(Flat(l.GetEndPoint(0)), Flat(l.Direction));
                        if (u.Intersect(tUnbound, out IntersectionResultArray r) != SetComparisonResult.Overlap || r == null || r.Size == 0) throw new InvalidOperationException($"{id.Value} is parallel to the target");
                        XYZ hit = r.get_Item(0).XYZPoint;
                        XYZ s = l.GetEndPoint(0), e = l.GetEndPoint(1);
                        bool moveEnd = Flat(e).DistanceTo(hit) < Flat(s).DistanceTo(hit);
                        lc.Curve = moveEnd ? Line.CreateBound(s, new XYZ(hit.X, hit.Y, e.Z)) : Line.CreateBound(new XYZ(hit.X, hit.Y, s.Z), e);
                        n++;
                    }
                    return new JObject { ["extended"] = n };
                }
                case "wall_join":
                {
                    // allow false stops walls joining at end 0, 1 or both
                    bool allow = op.Value<bool?>("allow") ?? true;
                    string end = op.Value<string>("end") ?? "both";
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        var w = (Wall)doc.GetElement(id);
                        foreach (int i in end == "both" ? new[] { 0, 1 } : new[] { int.Parse(end) })
                            if (allow) WallUtils.AllowWallJoinAtEnd(w, i); else WallUtils.DisallowWallJoinAtEnd(w, i);
                    }
                    return new JObject { ["walls"] = op["ids"].Count(), ["allow"] = allow };
                }
                case "create_group":
                {
                    Group g = doc.Create.NewGroup(Targets(doc, op, made));
                    if (op["name"] != null) g.GroupType.Name = op.Value<string>("name");
                    created.Add(g.Id);
                    return new JObject { ["group"] = g.Id.Value, ["type"] = g.GroupType.Name };
                }
                case "place_group":
                {
                    var types = new FilteredElementCollector(doc).OfClass(typeof(GroupType)).ToElementIds();
                    var gt = (GroupType)doc.GetElement(TypeFor(doc, op, types));
                    var ids = new JArray();
                    foreach (JArray p in PointList(op)) { Group g = doc.Create.PlaceGroup(Vec(p, "points_mm are [x, y, z]"), gt); created.Add(g.Id); ids.Add(g.Id.Value); }
                    return new JObject { ["groups"] = ids };
                }
                case "ungroup":
                {
                    int n = 0;
                    foreach (ElementId id in Targets(doc, op, made)) { created.AddRange(((Group)doc.GetElement(id)).UngroupMembers()); n++; }
                    return new JObject { ["ungrouped"] = n };
                }
                case "assembly":
                {
                    var ids = Targets(doc, op, made);
                    var a = AssemblyInstance.Create(doc, ids, doc.GetElement(ids.First()).Category.Id);
                    created.Add(a.Id);
                    if (op["name"] != null) { string an = op.Value<string>("name"); _after.Add(() => { using (var t = new Transaction(doc, "FMC name assembly")) { t.Start(); a.AssemblyTypeName = an; t.Commit(); } return new JObject { ["assembly"] = an }; }); }
                    return new JObject { ["assembly"] = a.Id.Value };
                }
                case "parts":
                {
                    var ids = Targets(doc, op, made);
                    PartUtils.CreateParts(doc, ids);
                    return new JObject { ["parts_from"] = ids.Count };
                }
                case "displace":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var d = DisplacementElement.Create(doc, Targets(doc, op, made), Vec(op["vector_mm"], "displace needs vector_mm"), v, null);
                    created.Add(d.Id);
                    return new JObject { ["displaced"] = d.Id.Value };
                }
                case "paint":
                case "remove_paint":
                {
                    Element e = doc.GetElement(Ref(doc, op["id"], made) ?? throw new InvalidOperationException($"{name} needs id"));
                    Reference r = FaceNear(e, Vec(op["point_mm"], $"{name} needs point_mm on the face"));
                    var face = e.GetGeometryObjectFromReference(r) as Face ?? throw new InvalidOperationException("no face there");
                    if (name == "paint") doc.Paint(e.Id, face, MaterialId(doc, op.Value<string>("material") ?? throw new InvalidOperationException("paint needs material")));
                    else doc.RemovePaint(e.Id, face);
                    return new JObject { [name] = e.Id.Value };
                }
                case "demolish":
                {
                    var phases = doc.Phases.Cast<Phase>().ToList();
                    Phase ph = op["phase"] != null ? phases.FirstOrDefault(p => string.Equals(p.Name, op.Value<string>("phase"), StringComparison.OrdinalIgnoreCase)) ?? throw new InvalidOperationException($"no phase {op.Value<string>("phase")}") : phases.Last();
                    foreach (ElementId id in Targets(doc, op, made)) doc.GetElement(id).get_Parameter(BuiltInParameter.PHASE_DEMOLISHED)?.Set(ph.Id);
                    return new JObject { ["demolished"] = op["ids"].Count(), ["phase"] = ph.Name };
                }
                case "path_of_travel":
                {
                    var v = ViewOf(doc, op["view"], made) as ViewPlan ?? throw new InvalidOperationException("path_of_travel needs view (a floor plan)");
                    var p = PathOfTravel.Create(v, Vec(op["start_mm"], "path_of_travel needs start_mm"), Vec(op["end_mm"], "path_of_travel needs end_mm"));
                    created.Add(p.Id);
                    return new JObject { ["path"] = p.Id.Value, ["length_mm"] = Math.Round(p.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH)?.AsDouble() * 304.8 ?? 0) };
                }
                case "energy_model":
                {
                    var m = EnergyAnalysisDetailModel.Create(doc, new EnergyAnalysisDetailModelOptions { Tier = EnergyAnalysisDetailModelTier.Final, EnergyModelType = EnergyModelType.SpatialElement });
                    created.Add(m.Id);
                    return new JObject { ["energy_model"] = m.Id.Value, ["spaces"] = m.GetAnalyticalSpaces().Count };
                }
                default: return null;
            }
        }

        private static XYZ Flat(XYZ p) => new XYZ(p.X, p.Y, 0);
    }
}
