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
    /// fmc_model_edit (owner 26 Oct, "the AI does what a human modeller does"): a list of edits run as one batch, one
    /// approval and one Undo. Ops: delete, move, set_param, change_type, attach, duplicate_type, create_roof,
    /// create_railing, create_stair, room_separation, opening, shaft. Each op runs in its own transaction inside one
    /// group: if any op fails the whole batch is rolled back and the answer says which op and why. dry_run runs it all
    /// and rolls back, listing what would change (deletes list every element Revit would remove with them).
    /// Lengths in mm, angles in degrees. Ids are element ids or unique ids; "$n" is the first element made by op n (1-based)
    /// of this batch, so a roof and the walls attached to it go in one batch. Pinned elements and elements another user
    /// owns are refused. Warnings are dismissed; errors fail the op.
    /// </summary>
    public partial class FmcModelEditHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft model edit";

        private static double Ft(double mm) => mm / 304.8;
        private static double Mm(double ft) => Math.Round(ft * 304.8, 1);

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            _uidoc = app.ActiveUIDocument; _openView = null;
            try { Result = Run(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open")); if (_openView != null && !(Result.Value<bool?>("dry_run") ?? false)) _uidoc.RequestViewChange(_openView); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Run(Document doc)
        {
            // Owner 26 Oct: the Family Editor too (family ops); project ops in a family fail with Revit's own reason
            _after.Clear();
            var ops = (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (ops.Count == 0) throw new InvalidOperationException("No ops to run");
            bool dry = Parameters.Value<bool?>("dry_run") ?? false;
            var made = new List<List<ElementId>>();
            var results = new JArray();
            using (var g = new TransactionGroup(doc, "FMC AI edit"))
            {
                g.Start();
                for (int i = 0; i < ops.Count; i++)
                {
                    JObject op = ops[i];
                    string name = op.Value<string>("op") ?? "";
                    var created = new List<ElementId>();
                    try
                    {
                        JObject r = name == "create_stair" ? Stair(doc, op, made, created)
                            : name == "edit_sketch" || name == "wall_profile" ? SketchOp(doc, name, op, made, created)
                            : InTransaction(doc, name, () => Op(doc, name, op, made, created));
                        r["op"] = i + 1; r["kind"] = name;
                        if (created.Count > 0) r["created_ids"] = new JArray(created.Select(x => x.Value));
                        results.Add(r);
                        made.Add(created);
                    }
                    catch (Exception ex)
                    {
                        g.RollBack();
                        return new JObject { ["applied"] = false, ["failed_op"] = i + 1, ["kind"] = name, ["reason"] = ex.Message, ["note"] = "Nothing was changed: the whole batch is one step, or none" };
                    }
                }
                if (dry) { g.RollBack(); return new JObject { ["applied"] = false, ["dry_run"] = true, ["ops"] = results, ["note"] = "Dry run: rolled back, nothing changed" }; }
                g.Assimilate();
            }
            // Saving and loading families can't run inside a transaction: they run once the batch is in
            var after = new JArray();
            foreach (var a in _after)
            {
                try { after.Add(a()); }
                catch (Exception ex) { after.Add(new JObject { ["failed"] = ex.Message }); }
            }
            var done = new JObject { ["applied"] = true, ["ops"] = results, ["undo"] = "One Undo in Revit takes the whole batch back: FMC AI edit" };
            if (after.Count > 0) done["after"] = after;
            return done;
        }

        private static JObject InTransaction(Document doc, string name, Func<JObject> body)
        {
            using (var t = new Transaction(doc, "FMC " + name))
            {
                t.Start();
                var fo = t.GetFailureHandlingOptions();
                fo.SetFailuresPreprocessor(new Quiet()); fo.SetClearAfterRollback(true);
                t.SetFailureHandlingOptions(fo);
                JObject r = body();
                doc.Regenerate();
                if (t.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit refused the change (an error, not a warning)");
                return r;
            }
        }

        private JObject Op(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "copy":
                {
                    // count copies, each one vector_mm further on (count 1 = Copy, more = an array without a group)
                    var v = Vec(op["vector_mm"], "copy needs vector_mm [x, y, z]");
                    var ids = Targets(doc, op, made, allowPinned: true);
                    int count = Math.Max(1, op.Value<int?>("count") ?? 1);
                    for (int i = 1; i <= count; i++) created.AddRange(ElementTransformUtils.CopyElements(doc, ids, v * i));
                    return new JObject { ["copies"] = count, ["made"] = created.Count };
                }
                case "rotate":
                {
                    var ids = Targets(doc, op, made);
                    double deg = op.Value<double?>("angle_deg") ?? throw new InvalidOperationException("rotate needs angle_deg (anticlockwise in plan)");
                    XYZ c = op["center_mm"] != null ? Vec(op["center_mm"], "center_mm is [x, y]") : Centre(doc, ids);
                    var axis = Line.CreateBound(c, c + XYZ.BasisZ);
                    if (op.Value<bool?>("copy") == true) { created.AddRange(ElementTransformUtils.CopyElements(doc, ids, XYZ.Zero)); ElementTransformUtils.RotateElements(doc, created, axis, deg * Math.PI / 180); }
                    else ElementTransformUtils.RotateElements(doc, ids, axis, deg * Math.PI / 180);
                    return new JObject { ["rotated"] = ids.Count, ["angle_deg"] = deg };
                }
                case "mirror":
                {
                    // the mirror line in plan, [[x, y], [x, y]]; copy true (default) keeps the originals, like Mirror in Revit
                    var ids = Targets(doc, op, made);
                    var l = Points(op["line_mm"], "mirror needs line_mm: [[x, y], [x, y]], the mirror axis in plan");
                    XYZ dir = (l[1] - l[0]).Normalize();
                    Plane plane = Plane.CreateByNormalAndOrigin(dir.CrossProduct(XYZ.BasisZ).Normalize(), l[0]);
                    bool keep = op.Value<bool?>("copy") ?? true;
                    var copies = ElementTransformUtils.MirrorElements(doc, ids, plane, keep);
                    if (copies != null) created.AddRange(copies);
                    return new JObject { ["mirrored"] = ids.Count, ["kept_originals"] = keep };
                }
                case "join":
                case "unjoin":
                case "switch_join":
                {
                    // ids: [a, b, ...]: the first is joined with each of the others
                    var ids = Targets(doc, op, made).ToList();
                    if (ids.Count < 2) throw new InvalidOperationException($"{name} needs at least two ids");
                    Element a = doc.GetElement(ids[0]);
                    int n = 0;
                    foreach (ElementId id in ids.Skip(1))
                    {
                        Element b2 = doc.GetElement(id);
                        bool joined = JoinGeometryUtils.AreElementsJoined(doc, a, b2);
                        if (name == "join" && !joined) { JoinGeometryUtils.JoinGeometry(doc, a, b2); n++; }
                        else if (name == "unjoin" && joined) { JoinGeometryUtils.UnjoinGeometry(doc, a, b2); n++; }
                        else if (name == "switch_join" && joined) { JoinGeometryUtils.SwitchJoinOrder(doc, a, b2); n++; }
                    }
                    return new JObject { [name] = n };
                }
                case "cut":
                case "uncut":
                {
                    // ids: [cutting, cut, ...]: the first element cuts each of the others (a void or solid cutting a solid)
                    var ids = Targets(doc, op, made).ToList();
                    if (ids.Count < 2) throw new InvalidOperationException($"{name} needs ids [cutting, cut, ...]");
                    Element cutting = doc.GetElement(ids[0]);
                    foreach (ElementId id in ids.Skip(1))
                    {
                        if (name == "cut") SolidSolidCutUtils.AddCutBetweenSolids(doc, doc.GetElement(id), cutting);
                        else SolidSolidCutUtils.RemoveCutBetweenSolids(doc, doc.GetElement(id), cutting);
                    }
                    return new JObject { [name] = ids.Count - 1 };
                }
                case "pin":
                case "unpin":
                {
                    var ids = Targets(doc, op, made, allowPinned: true);
                    foreach (ElementId id in ids) doc.GetElement(id).Pinned = name == "pin";
                    return new JObject { [name] = ids.Count };
                }
                case "delete":
                {
                    var ids = Targets(doc, op, made);
                    var deleted = doc.Delete(ids);
                    return new JObject { ["asked"] = ids.Count, ["removed"] = deleted.Count, ["removed_ids"] = new JArray(deleted.Select(x => x.Value)) };
                }
                case "move":
                {
                    var v = Vec(op["vector_mm"], "move needs vector_mm [x, y, z]");
                    var ids = Targets(doc, op, made);
                    var z0 = ids.ToDictionary(id => id, id => doc.GetElement(id).get_BoundingBox(null)?.Min.Z);
                    ElementTransformUtils.MoveElements(doc, ids, v);
                    doc.Regenerate();
                    // Ogala report: level-hosted walls and stairs keep their height; say which, so rehost can follow
                    var stuck = Math.Abs(v.Z) < 1e-6 ? new List<ElementId>() : ids.Where(id => z0[id].HasValue && Math.Abs((doc.GetElement(id).get_BoundingBox(null)?.Min.Z ?? 0) - z0[id].Value - v.Z) > Ft(1)).ToList();
                    var mv = new JObject { ["moved"] = ids.Count };
                    if (stuck.Count > 0) { mv["not_moved_in_z"] = new JArray(stuck.Select(x => x.Value)); mv["hint"] = "these are hosted on their level: use rehost {ids, level} or set their base offsets"; }
                    return mv;
                }
                case "set_param":
                {
                    var ids = Targets(doc, op, made);
                    string pname = op.Value<string>("param") ?? throw new InvalidOperationException("set_param needs param");
                    foreach (ElementId id in ids) SetParam(doc, doc.GetElement(id), pname, op, op.Value<bool?>("on_type") ?? false);
                    return new JObject { ["set"] = ids.Count, ["param"] = pname };
                }
                case "change_type":
                {
                    var ids = Targets(doc, op, made);
                    foreach (ElementId id in ids)
                    {
                        Element e = doc.GetElement(id);
                        ElementId t = TypeFor(doc, op, e.GetValidTypes());
                        e.ChangeTypeId(t);
                    }
                    return new JObject { ["changed"] = ids.Count };
                }
                case "attach":
                {
                    // Wall Attach Top/Base to a roof, floor or ceiling
                    ElementId target = Ref(doc, op["target"], made) ?? throw new InvalidOperationException("attach needs target (a roof, floor or ceiling)");
                    var where = (op.Value<string>("side") ?? "top") == "base" ? AttachmentLocation.Base : AttachmentLocation.Top;
                    int n = 0;
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        if (!(doc.GetElement(id) is Wall w)) throw new InvalidOperationException($"{id.Value} isn't a wall");
                        w.AddAttachment(target, where); n++;
                    }
                    return new JObject { ["attached"] = n, ["side"] = where.ToString() };
                }
                case "duplicate_type":
                {
                    ElementId src = Ref(doc, op["type"], made) ?? throw new InvalidOperationException("duplicate_type needs type (the source type's id)");
                    ElementType source = doc.GetElement(src) as ElementType ?? throw new InvalidOperationException($"{src.Value} isn't a type");
                    string newName = op.Value<string>("new_name") ?? throw new InvalidOperationException("duplicate_type needs new_name");
                    ElementType t = source.Duplicate(newName);
                    created.Add(t.Id);
                    if (op["layers"] is JArray layers && t is HostObjAttributes host)
                    {
                        var list = layers.OfType<JObject>().Select(l => new CompoundStructureLayer(Ft(l.Value<double>("width_mm")),
                            (MaterialFunctionAssignment)Enum.Parse(typeof(MaterialFunctionAssignment), l.Value<string>("function") ?? "Structure", true),
                            MaterialId(doc, l.Value<string>("material")))).ToList();
                        // Ogala report: a fresh structure has the wrong end caps for floors; edit the duplicate's own
                        CompoundStructure cs = host.GetCompoundStructure() ?? CompoundStructure.CreateSimpleCompoundStructure(list);
                        cs.SetLayers(list);
                        int structural = list.FindIndex(l => l.Function == MaterialFunctionAssignment.Structure);
                        if (structural >= 0) { try { cs.StructuralMaterialIndex = structural; } catch (Exception) { } }
                        host.SetCompoundStructure(cs);
                    }
                    if (op["params"] is JObject ps)
                        foreach (var kv in ps) SetParam(doc, t, kv.Key, ValueOp(kv.Value), true);
                    return new JObject { ["type"] = newName };
                }
                case "create_roof":
                {
                    var pts = Points(op["outline_mm"], "create_roof needs outline_mm, a closed loop of [x, y]");
                    Level level = LevelOf(doc, op["level"]);
                    RoofType rt = (RoofType)doc.GetElement(TypeOf<RoofType>(doc, op));
                    var slopes = op["slopes_deg"] as JArray;
                    double? all = op.Value<double?>("slope_deg");
                    double over = op.Value<double?>("overhang_mm") ?? 0;
                    // Ogala report: overhang works only on pick-walls roofs; offset the outline instead, and drop the base
                    // so the roof still meets the walls at the level (eave lower by overhang × tan slope)
                    var drawn = over > 0 ? Outward(pts, Ft(over)) : pts;
                    var loop = new CurveArray();
                    for (int i = 0; i < drawn.Count; i++) loop.Append(Line.CreateBound(drawn[i], drawn[(i + 1) % drawn.Count]));
                    var curves = new ModelCurveArray();
                    FootPrintRoof roof = doc.Create.NewFootPrintRoof(loop, level, rt, out curves);
                    double maxSlope = Math.Max(all ?? 0, slopes?.Select(x => x.Value<double?>() ?? 0).DefaultIfEmpty(0).Max() ?? 0);
                    foreach (ModelCurve mc in curves)
                    {
                        int edge = NearestEdge(drawn, mc.GeometryCurve);
                        double? deg = slopes != null && edge < slopes.Count ? slopes[edge].Value<double?>() : all;
                        roof.set_DefinesSlope(mc, deg.HasValue);
                        if (deg.HasValue) roof.set_SlopeAngle(mc, Math.Tan(deg.Value * Math.PI / 180));
                    }
                    double baseOffset = Ft(op.Value<double?>("offset_mm") ?? 0) - Ft(over) * Math.Tan(maxSlope * Math.PI / 180);
                    if (op["offset_mm"] != null || over > 0) roof.get_Parameter(BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM)?.Set(baseOffset);
                    created.Add(roof.Id);
                    return new JObject { ["roof"] = roof.Id.Value, ["edges"] = pts.Count };
                }
                case "create_railing":
                {
                    Level level = LevelOf(doc, op["level"]);
                    ElementId rt = TypeOf<RailingType>(doc, op);
                    Railing r;
                    ElementId host = Ref(doc, op["host"], made);
                    if (host != null && doc.GetElement(host) is Stairs)
                        r = (Railing)doc.GetElement(Railing.Create(doc, host, rt, RailingPlacementPosition.Treads).First());
                    else
                    {
                        var pts = Points(op["path_mm"], "create_railing needs path_mm, [x, y] points along the rail");
                        var path = new CurveLoop();
                        for (int i = 0; i + 1 < pts.Count; i++) path.Append(Line.CreateBound(pts[i], pts[i + 1]));
                        r = Railing.Create(doc, path, rt, level.Id);
                        if (host != null) r.HostId = host;
                    }
                    if (op["offset_mm"] != null) r.get_Parameter(BuiltInParameter.STAIRS_RAILING_HEIGHT_OFFSET)?.Set(Ft(op.Value<double>("offset_mm")));
                    created.Add(r.Id);
                    return new JObject { ["railing"] = r.Id.Value };
                }
                case "room_separation":
                {
                    Level level = LevelOf(doc, op["level"]);
                    ViewPlan plan = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                        .FirstOrDefault(v => !v.IsTemplate && v.GenLevel?.Id == level.Id && v.ViewType == ViewType.FloorPlan)
                        ?? throw new InvalidOperationException($"{level.Name} has no floor plan to draw room separation lines in");
                    var lines = new CurveArray();
                    foreach (JArray seg in (op["lines_mm"] as JArray ?? throw new InvalidOperationException("room_separation needs lines_mm: [[[x, y], [x, y]], ...]")).OfType<JArray>())
                    {
                        var p = Points(seg, "each line is [[x, y], [x, y]]");
                        lines.Append(Line.CreateBound(new XYZ(p[0].X, p[0].Y, level.Elevation), new XYZ(p[1].X, p[1].Y, level.Elevation)));
                    }
                    SketchPlane sp = SketchPlane.Create(doc, level.Id);
                    ModelCurveArray made2 = doc.Create.NewRoomBoundaryLines(sp, lines, plan);
                    foreach (ModelCurve c in made2) created.Add(c.Id);
                    return new JObject { ["lines"] = made2.Size };
                }
                case "opening":
                {
                    // a hole cut in a floor, ceiling or roof by an outline
                    ElementId host = Ref(doc, op["host"], made) ?? throw new InvalidOperationException("opening needs host (a floor, ceiling or roof id)");
                    var pts = Points(op["outline_mm"], "opening needs outline_mm, a closed loop of [x, y]");
                    var loop = new CurveArray();
                    for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                    Opening o = doc.Create.NewOpening(doc.GetElement(host), loop, !(op.Value<bool?>("vertical") ?? false));
                    created.Add(o.Id);
                    return new JObject { ["opening"] = o.Id.Value };
                }
                case "shaft":
                {
                    Level bottom = LevelOf(doc, op["base_level"]), top = LevelOf(doc, op["top_level"]);
                    var pts = Points(op["outline_mm"], "shaft needs outline_mm, a closed loop of [x, y]");
                    var loop = new CurveArray();
                    for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                    Opening o = doc.Create.NewOpening(bottom, top, loop);
                    created.Add(o.Id);
                    return new JObject { ["shaft"] = o.Id.Value };
                }
                default: return ViewOp(doc, name, op, made, created) ?? throw new InvalidOperationException($"{name} isn't an op (extrusion, blend, revolve, sweep, family_param, family_type, family_category, reference_plane, dimension, save_family, load_into_project, detail_line, model_line, filled_region, masking_region, text, replace_text, tag, spot_elevation, spot_coordinate, revision_cloud, place_annotation, color_fill_legend, create_view, duplicate_view, set_view, override, hide, unhide, create_filter, create_template, apply_template, create_sheet, place_view, open_view, copy, rotate, mirror, join, unjoin, switch_join, cut, uncut, pin, unpin, delete, move, set_param, change_type, attach, duplicate_type, create_roof, create_railing, create_stair, room_separation, opening, shaft)");
            }
        }

        /// <summary>Stairs by component: straight runs one after another, landings between them, optional railings.</summary>
        private JObject Stair(Document doc, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            Level bottom = LevelOf(doc, op["base_level"]), top = LevelOf(doc, op["top_level"]);
            var runs = (op["runs"] as JArray ?? throw new InvalidOperationException("create_stair needs runs: [{start_mm: [x, y], end_mm: [x, y], width_mm}]")).OfType<JObject>().ToList();
            ElementId stairsId;
            using (var scope = new StairsEditScope(doc, "FMC stair"))
            {
                stairsId = scope.Start(bottom.Id, top.Id);
                using (var t = new Transaction(doc, "FMC stair runs"))
                {
                    t.Start();
                    var fo = t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new Quiet()); t.SetFailureHandlingOptions(fo);
                    Stairs st = (Stairs)doc.GetElement(stairsId);
                    // Ogala report: the stair works its runs out itself. Total risers: given, or the height at 175 mm max;
                    // each run's path is (risers - 1) × the type's tread long, at the base level's real height
                    double height = top.Elevation - bottom.Elevation;
                    int total = op.Value<int?>("risers") ?? (int)Math.Ceiling(height / Ft(op.Value<double?>("riser_max_mm") ?? 175));
                    st.DesiredRisersNumber = total;
                    doc.Regenerate();
                    double tread = st.ActualTreadDepth;
                    var given = runs.Select(x => x.Value<int?>("risers")).ToList();
                    int left = total - given.Where(x => x.HasValue).Sum(x => x.Value), open = given.Count(x => !x.HasValue);
                    double z = bottom.Elevation;
                    var runIds = new List<ElementId>();
                    for (int i = 0; i < runs.Count; i++)
                    {
                        int n = given[i] ?? (open > 0 ? (int)Math.Ceiling(left / (double)open) : 0);
                        if (!given[i].HasValue) { left -= n; open--; }
                        if (n < 2) throw new InvalidOperationException($"run {i + 1} would have {n} risers");
                        XYZ start = Vec(runs[i]["start_mm"], "each run needs start_mm");
                        XYZ dir = runs[i]["end_mm"] != null ? Flat(Vec(runs[i]["end_mm"], "end_mm is [x, y]") - start).Normalize()
                            : runs[i]["direction_deg"] != null ? new XYZ(Math.Cos(runs[i].Value<double>("direction_deg") * Math.PI / 180), Math.Sin(runs[i].Value<double>("direction_deg") * Math.PI / 180), 0)
                            : throw new InvalidOperationException("each run needs end_mm (its direction) or direction_deg");
                        var a = new XYZ(start.X, start.Y, z);
                        Line path = Line.CreateBound(a, a + dir * (tread * (n - 1)));
                        StairsRun run = StairsRun.CreateStraightRun(doc, stairsId, path, StairsRunJustification.Center);
                        if (runs[i]["width_mm"] != null) run.ActualRunWidth = Ft(runs[i].Value<double>("width_mm"));
                        doc.Regenerate();
                        z = bottom.Elevation + run.TopElevation;
                        runIds.Add(run.Id);
                    }
                    for (int i = 0; i + 1 < runIds.Count; i++) StairsLanding.CreateAutomaticLanding(doc, runIds[i], runIds[i + 1]);
                    t.Commit();
                }
                scope.Commit(new Quiet());
            }
            created.Add(stairsId);
            var stairs = (Stairs)doc.GetElement(stairsId);
            var r = new JObject { ["stairs"] = stairsId.Value, ["runs"] = runs.Count, ["risers"] = stairs.ActualRisersNumber, ["riser_mm"] = Math.Round(stairs.ActualRiserHeight * 304.8, 1) };
            // the stair type may already make its railings: then none are added (Ogala report 13)
            if (stairs.GetAssociatedRailings().Count > 0) r["railings"] = "made by the stair type";
            else if (op.Value<bool?>("railings") ?? true)
                InTransaction(doc, "stair railings", () =>
                {
                    ElementId rt = TypeOf<RailingType>(doc, new JObject { ["type_name"] = op["railing_type"] });
                    foreach (ElementId x in Railing.Create(doc, stairsId, rt, RailingPlacementPosition.Treads)) created.Add(x);
                    return new JObject();
                });
            return r;
        }

        // ---- inputs ----

        /// <summary>A closed outline pushed outwards by d (whichever way grows it).</summary>
        private static List<XYZ> Outward(List<XYZ> pts, double d)
        {
            var loop = new CurveLoop();
            for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
            double Area(IEnumerable<XYZ> p) { var a = p.ToList(); double s = 0; for (int i = 0; i < a.Count; i++) s += a[i].X * a[(i + 1) % a.Count].Y - a[(i + 1) % a.Count].X * a[i].Y; return Math.Abs(s) / 2; }
            List<XYZ> Pts(CurveLoop l) => l.Select(c => c.GetEndPoint(0)).ToList();
            var plus = Pts(CurveLoop.CreateViaOffset(loop, d, XYZ.BasisZ));
            return Area(plus) > Area(pts) ? plus : Pts(CurveLoop.CreateViaOffset(loop, -d, XYZ.BasisZ));
        }

        private static XYZ Centre(Document doc, ICollection<ElementId> ids)
        {
            var boxes = ids.Select(id => doc.GetElement(id).get_BoundingBox(null)).Where(b => b != null).ToList();
            if (boxes.Count == 0) throw new InvalidOperationException("rotate needs center_mm: these elements have no extent");
            var min = new XYZ(boxes.Min(b => b.Min.X), boxes.Min(b => b.Min.Y), 0);
            var max = new XYZ(boxes.Max(b => b.Max.X), boxes.Max(b => b.Max.Y), 0);
            return (min + max) / 2;
        }

        private static ICollection<ElementId> Targets(Document doc, JObject op, List<List<ElementId>> made, bool allowPinned = false)
        {
            var ids = (op["ids"] as JArray ?? throw new InvalidOperationException("the op needs ids")).Select(x => Ref(doc, x, made)).ToList();
            if (ids.Count == 0) throw new InvalidOperationException("the op needs ids");
            foreach (ElementId id in ids)
            {
                Element e = doc.GetElement(id) ?? throw new InvalidOperationException($"{id?.Value} isn't in this model");
                if (e.Pinned && !allowPinned) throw new InvalidOperationException($"{id.Value} ({e.Category?.Name}) is pinned: a person unpins it first");
                if (doc.IsWorkshared && WorksharingUtils.GetCheckoutStatus(doc, id) == CheckoutStatus.OwnedByOtherUser)
                    throw new InvalidOperationException($"{id.Value} is owned by another user (worksharing)");
            }
            return ids;
        }

        /// <summary>An element id, a unique id, or "$n" (the first element made by op n of this batch).</summary>
        private static ElementId Ref(Document doc, JToken t, List<List<ElementId>> made)
        {
            if (t == null || t.Type == JTokenType.Null) return null;
            string s = t.ToString().Trim();
            if (s.StartsWith("$"))
            {
                int n = int.Parse(s.Substring(1));
                if (n < 1 || n > made.Count || made[n - 1].Count == 0) throw new InvalidOperationException($"{s}: op {n} made nothing before this op");
                return made[n - 1][0];
            }
            if (long.TryParse(s, out long v)) return new ElementId(v);
            return doc.GetElement(s)?.Id ?? throw new InvalidOperationException($"{s} isn't in this model");
        }

        private static Level LevelOf(Document doc, JToken t)
        {
            if (t == null) throw new InvalidOperationException("the op needs a level (name or id)");
            string s = t.ToString();
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
            return levels.FirstOrDefault(l => string.Equals(l.Name, s, StringComparison.OrdinalIgnoreCase))
                ?? (long.TryParse(s, out long v) ? levels.FirstOrDefault(l => l.Id.Value == v) : null)
                ?? throw new InvalidOperationException($"no level {s} (levels: {string.Join(", ", levels.Select(l => l.Name))})");
        }

        private static ElementId TypeOf<T>(Document doc, JObject op) where T : ElementType
        {
            var all = new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>().ToList();
            if (all.Count == 0) throw new InvalidOperationException($"the model has no {typeof(T).Name}");
            return TypeFor(doc, op, all.Select(x => x.Id).ToList(), all[0].Id);
        }

        private static ElementId TypeFor(Document doc, JObject op, ICollection<ElementId> valid, ElementId fallback = null)
        {
            if (op["type_id"] != null) { var id = new ElementId(op.Value<long>("type_id")); if (valid.Contains(id)) return id; throw new InvalidOperationException($"type {id.Value} doesn't fit here"); }
            string name = op.Value<string>("type_name");
            if (string.IsNullOrEmpty(name)) return fallback ?? throw new InvalidOperationException("the op needs type_name or type_id");
            return valid.FirstOrDefault(x => string.Equals(doc.GetElement(x)?.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"{name} isn't a type that fits here (types: {string.Join(", ", valid.Take(25).Select(x => doc.GetElement(x)?.Name))})");
        }

        private static ElementId MaterialId(Document doc, string name)
        {
            if (string.IsNullOrEmpty(name)) return ElementId.InvalidElementId;
            return new FilteredElementCollector(doc).OfClass(typeof(Material)).FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase))?.Id
                ?? throw new InvalidOperationException($"the material {name} isn't in this model (load it from the kit)");
        }

        private static JObject ValueOp(JToken v) =>
            v.Type == JTokenType.Integer || v.Type == JTokenType.Float ? new JObject { ["value_mm"] = v } : new JObject { ["value_text"] = v };

        /// <summary>value_mm (lengths), by_mm (add to a length), value_text (text, yes/no, numbers, or an element's name: a level, type or material), value (raw number).</summary>
        private static void SetParam(Document doc, Element e, string name, JObject s, bool onType)
        {
            Element target = onType && !(e is ElementType) ? doc.GetElement(e.GetTypeId()) : e;
            Parameter p = target.LookupParameter(name);
            if (p == null && !onType && doc.GetElement(e.GetTypeId())?.LookupParameter(name) != null)
                throw new InvalidOperationException($"{name} belongs to the type: set on_type true (changes every element of that type), or change the type");
            if (p == null) throw new InvalidOperationException($"{e.Id.Value} has no parameter {name}");
            if (p.IsReadOnly) throw new InvalidOperationException($"{name} is read-only (Revit works it out)");
            bool ok;
            if (s["value_mm"] != null || s["by_mm"] != null)
            {
                double mm = s["value_mm"] != null ? s.Value<double>("value_mm") : Mm(p.AsDouble()) + s.Value<double>("by_mm");
                ok = p.Set(Ft(mm));
            }
            else if (s["value"] != null && p.StorageType == StorageType.Double) ok = p.Set(s.Value<double>("value"));
            else
            {
                string text = s.Value<string>("value_text") ?? s.Value<string>("value") ?? "";
                switch (p.StorageType)
                {
                    case StorageType.String: ok = p.Set(text); break;
                    case StorageType.Integer:
                        string t = text.Trim().ToLowerInvariant();
                        ok = p.Set(t == "yes" || t == "on" || t == "true" ? 1 : t == "no" || t == "off" || t == "false" ? 0 : int.Parse(t)); break;
                    case StorageType.ElementId:
                        ElementId id = long.TryParse(text, out long v) ? new ElementId(v)
                            : new FilteredElementCollector(doc).WhereElementIsNotElementType().OfClass(typeof(Level)).FirstOrDefault(x => string.Equals(x.Name, text, StringComparison.OrdinalIgnoreCase))?.Id
                              ?? new FilteredElementCollector(doc).OfClass(typeof(Material)).FirstOrDefault(x => string.Equals(x.Name, text, StringComparison.OrdinalIgnoreCase))?.Id
                              ?? (text.Equals("none", StringComparison.OrdinalIgnoreCase) || text.Equals("unconnected", StringComparison.OrdinalIgnoreCase) ? ElementId.InvalidElementId : null)
                              ?? throw new InvalidOperationException($"no level or material named {text} for {name}");
                        ok = p.Set(id); break;
                    default: ok = p.SetValueString(text); break;
                }
            }
            if (!ok) throw new InvalidOperationException($"Revit refused the value for {name} on {e.Id.Value}");
        }

        private static XYZ Vec(JToken t, string why)
        {
            var a = t as JArray ?? throw new InvalidOperationException(why);
            return new XYZ(Ft(a[0].Value<double>()), Ft(a[1].Value<double>()), a.Count > 2 ? Ft(a[2].Value<double>()) : 0);
        }

        private static List<XYZ> Points(JToken t, string why)
        {
            var a = t as JArray ?? throw new InvalidOperationException(why);
            var pts = a.OfType<JArray>().Select(p => Vec(p, why)).ToList();
            if (pts.Count < 2) throw new InvalidOperationException(why);
            return pts;
        }

        private static int NearestEdge(List<XYZ> pts, Curve c)
        {
            XYZ mid = c.Evaluate(0.5, true);
            int best = 0; double d = double.MaxValue;
            for (int i = 0; i < pts.Count; i++)
            {
                XYZ m = (pts[i] + pts[(i + 1) % pts.Count]) / 2;
                double x = new XYZ(m.X - mid.X, m.Y - mid.Y, 0).GetLength();
                if (x < d) { d = x; best = i; }
            }
            return best;
        }

        /// <summary>Warnings are dismissed so no dialog stops the batch; errors still fail it.</summary>
        private sealed class Quiet : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                    if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                return FailureProcessingResult.Continue;
            }
        }
    }

    /// <summary>
    /// fmc_element_geometry (owner 26 Oct): where elements are, exactly, read-only: location line or point, level, bounding
    /// box, and the sketch outline of floors, roofs and ceilings or a room's boundary, all in mm.
    /// </summary>
    public class FmcElementGeometryHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft element geometry";

        private static JArray P(XYZ p) => new JArray(Math.Round(p.X * 304.8, 1), Math.Round(p.Y * 304.8, 1), Math.Round(p.Z * 304.8, 1));

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open");
                var list = new JArray(); var missing = new JArray();
                foreach (JToken t in Parameters["ids"] as JArray ?? new JArray())
                {
                    string s = t.ToString();
                    Element e = long.TryParse(s, out long v) ? doc.GetElement(new ElementId(v)) : doc.GetElement(s);
                    if (e == null) { missing.Add(s); continue; }
                    list.Add(Geometry(doc, e));
                }
                Result = new JObject { ["model"] = doc.Title, ["elements"] = list, ["missing"] = missing };
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private static JObject Geometry(Document doc, Element e)
        {
            var o = new JObject
            {
                ["id"] = e.Id.Value, ["category"] = e.Category?.Name ?? "", ["type"] = doc.GetElement(e.GetTypeId())?.Name ?? "",
                ["name"] = e is Room rm ? (rm.Number + " " + (rm.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "")).Trim() : "",
                ["level"] = doc.GetElement(e.LevelId)?.Name ?? "", ["pinned"] = e.Pinned,
            };
            if (e.Location is LocationPoint lp) o["point_mm"] = P(lp.Point);
            else if (e.Location is LocationCurve lc) { o["start_mm"] = P(lc.Curve.GetEndPoint(0)); o["end_mm"] = P(lc.Curve.GetEndPoint(1)); }
            BoundingBoxXYZ bb = e.get_BoundingBox(null);
            if (bb != null) { o["bbox_min_mm"] = P(bb.Min); o["bbox_max_mm"] = P(bb.Max); }
            if (e is Wall w)
            {
                o["width_mm"] = Math.Round(w.Width * 304.8, 1);
                o["height_mm"] = Math.Round((w.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble() ?? 0) * 304.8, 1);
                o["top"] = doc.GetElement(w.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.AsElementId() ?? ElementId.InvalidElementId)?.Name ?? "unconnected";
            }
            if (e is FamilyInstance fi && fi.Host != null) o["host"] = fi.Host.Id.Value;
            if (doc.IsWorkshared)
            {
                // Show History: who made it, who changed it last, who owns it now
                WorksharingTooltipInfo wt = WorksharingUtils.GetWorksharingTooltipInfo(doc, e.Id);
                o["created_by"] = wt.Creator; o["last_changed_by"] = wt.LastChangedBy; o["owner"] = wt.Owner;
            }
            var loops = new JArray();
            try
            {
                ElementId sketchId = (e as Floor)?.SketchId ?? (e as Ceiling)?.SketchId ?? ElementId.InvalidElementId;
                if (sketchId == ElementId.InvalidElementId && e is FootPrintRoof)
                    sketchId = new FilteredElementCollector(doc).OfClass(typeof(Sketch)).Cast<Sketch>().FirstOrDefault(s => s.OwnerId == e.Id)?.Id ?? ElementId.InvalidElementId;
                if (doc.GetElement(sketchId) is Sketch sk)
                    foreach (CurveArray ca in sk.Profile) loops.Add(new JArray(ca.Cast<Curve>().Select(c => P(c.GetEndPoint(0)))));
                if (e is Room room)
                    foreach (var seg in room.GetBoundarySegments(new SpatialElementBoundaryOptions()))
                        loops.Add(new JArray(seg.Select(s => P(s.GetCurve().GetEndPoint(0)))));
            }
            catch (Exception) { /* no outline for this element */ }
            if (loops.Count > 0) o["outline_loops_mm"] = loops;
            return o;
        }
    }
}

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_post_command (owner 26 Oct, "every tool reachable"): starts any of Revit's built-in commands (PostableCommand)
    /// by name, optionally with elements selected first, the way a person clicks the ribbon. Revit runs it after this
    /// call returns; a command that asks for picks or a dialog waits for the person. list: every command and whether
    /// Revit can start it now.
    /// </summary>
    public class FmcPostCommandHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft run a Revit command";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                if (Parameters.Value<bool?>("list") == true)
                {
                    var all = new JArray();
                    foreach (PostableCommand pc in Enum.GetValues(typeof(PostableCommand)))
                    {
                        RevitCommandId id = RevitCommandId.LookupPostableCommandId(pc);
                        bool can = false; try { can = id != null && app.CanPostCommand(id); } catch (Exception) { }
                        all.Add(new JObject { ["command"] = pc.ToString(), ["can_start_now"] = can });
                    }
                    Result = new JObject { ["commands"] = all, ["count"] = all.Count };
                    return;
                }
                string name = Parameters.Value<string>("command") ?? throw new InvalidOperationException("command is needed (a Revit command name, e.g. MirrorPickAxis; list gives them all)");
                if (!Enum.TryParse(name.Replace(" ", ""), true, out PostableCommand cmd))
                    throw new InvalidOperationException($"{name} isn't one of Revit's built-in commands (run_revit_command list gives them all)");
                RevitCommandId cid = RevitCommandId.LookupPostableCommandId(cmd);
                if (cid == null || !app.CanPostCommand(cid)) throw new InvalidOperationException($"Revit can't start {cmd} now (wrong view or document for it, or another command is running)");
                var sel = new JArray();
                if (Parameters["select_ids"] is JArray ids && ids.Count > 0 && app.ActiveUIDocument != null)
                {
                    Document doc = app.ActiveUIDocument.Document;
                    var list = ids.Select(t => long.TryParse(t.ToString(), out long v) ? new ElementId(v) : doc.GetElement(t.ToString())?.Id).Where(x => x != null && doc.GetElement(x) != null).ToList();
                    app.ActiveUIDocument.Selection.SetElementIds(list);
                    foreach (var x in list) sel.Add(x.Value);
                }
                app.PostCommand(cid);
                Result = new JObject { ["started"] = cmd.ToString(), ["selected"] = sel, ["note"] = "Revit runs it next; if it asks for picks or a dialog, the person finishes it in Revit" };
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }
}
