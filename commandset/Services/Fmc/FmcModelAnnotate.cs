using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's annotation ops (owner 26 Oct, tools group 3): detail_line, model_line, filled_region,
    /// masking_region, text, replace_text, tag (any category, rooms, spaces and areas, keynote and material tags by their
    /// tag type), spot_elevation, spot_coordinate, revision_cloud, place_annotation (detail items, symbols, generic
    /// annotations) and color_fill_legend. Points in mm in model coordinates; on a sheet or drafting view, in its own.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject AnnotationOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "detail_line":
                case "model_line":
                {
                    var pts = Points(op["points_mm"], $"{name} needs points_mm, a polyline [[x, y], ...]");
                    bool closed = op.Value<bool?>("closed") ?? false;
                    GraphicsStyle style = op["line_style"] != null ? LineStyle(doc, op.Value<string>("line_style")) : null;
                    View v = name == "detail_line" ? ViewOf(doc, op["view"], made) : null;
                    SketchPlane sp = null;
                    if (name == "model_line")
                    {
                        Level l = op["level"] != null ? LevelOf(doc, op["level"]) : null;
                        double z = l?.Elevation ?? 0;
                        pts = pts.Select(p => new XYZ(p.X, p.Y, z + p.Z)).ToList();
                        sp = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, z + pts[0].Z)));
                    }
                    int n = closed ? pts.Count : pts.Count - 1;
                    for (int i = 0; i < n; i++)
                    {
                        Line ln = Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]);
                        CurveElement c = name == "detail_line" ? (CurveElement)doc.Create.NewDetailCurve(v, ln) : doc.Create.NewModelCurve(ln, sp);
                        if (style != null) c.LineStyle = style;
                        if (name == "model_line" && op.Value<bool?>("reference_line") == true && c is ModelCurve mc) mc.ChangeToReferenceLine();
                        created.Add(c.Id);
                    }
                    return new JObject { ["lines"] = n };
                }
                case "filled_region":
                case "masking_region":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var loops = Loops(op);
                    FilledRegion fr;
                    if (name == "masking_region") fr = FilledRegion.Create(doc, MaskingType(doc), v.Id, loops);
                    else
                    {
                        var types = new FilteredElementCollector(doc).OfClass(typeof(FilledRegionType)).ToElementIds();
                        fr = FilledRegion.Create(doc, TypeFor(doc, op, types, types.First()), v.Id, loops);
                    }
                    created.Add(fr.Id);
                    return new JObject { ["region"] = fr.Id.Value, ["loops"] = loops.Count };
                }
                case "text":
                {
                    View v = ViewOf(doc, op["view"], made);
                    XYZ at = Vec(op["point_mm"], "text needs point_mm");
                    var types = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).ToElementIds();
                    var opts = new TextNoteOptions(TypeFor(doc, op, types, doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)));
                    if (op["align"] != null) opts.HorizontalAlignment = (HorizontalTextAlignment)Enum.Parse(typeof(HorizontalTextAlignment), op.Value<string>("align"), true);
                    string text = op.Value<string>("text") ?? throw new InvalidOperationException("text needs text");
                    TextNote tn = op["width_mm"] != null ? TextNote.Create(doc, v.Id, at, Ft(op.Value<double>("width_mm")) / v.Scale, text, opts) : TextNote.Create(doc, v.Id, at, text, opts);
                    created.Add(tn.Id);
                    return new JObject { ["text"] = tn.Id.Value };
                }
                case "replace_text":
                {
                    // Find and replace in text notes (all views, or the views given)
                    string find = op.Value<string>("find") ?? throw new InvalidOperationException("replace_text needs find");
                    string with = op.Value<string>("replace") ?? "";
                    var viewIds = (op["views"] as JArray)?.Select(x => ViewOf(doc, x, made).Id).ToHashSet();
                    int n = 0;
                    foreach (TextNote tn in new FilteredElementCollector(doc).OfClass(typeof(TextNote)).Cast<TextNote>())
                        if ((viewIds == null || viewIds.Contains(tn.OwnerViewId)) && tn.Text.IndexOf(find, StringComparison.Ordinal) >= 0) { tn.Text = tn.Text.Replace(find, with); n++; }
                    return new JObject { ["replaced_in"] = n };
                }
                case "tag":
                {
                    // ids tagged in view; rooms, spaces and areas get their own tags; tag_type picks a keynote, material or any tag family
                    View v = ViewOf(doc, op["view"], made);
                    bool leader = op.Value<bool?>("leader") ?? false;
                    var orient = (op.Value<string>("orientation") ?? "horizontal") == "vertical" ? TagOrientation.Vertical : TagOrientation.Horizontal;
                    XYZ offset = op["offset_mm"] != null ? Vec(op["offset_mm"], "offset_mm is [x, y]") : XYZ.Zero;
                    ElementId tagType = op["tag_type"] != null ? TagTypeId(doc, op.Value<string>("tag_type")) : null;
                    var mode = (op.Value<string>("mode") ?? "category") switch { "multi" => TagMode.TM_ADDBY_MULTICATEGORY, "material" => TagMode.TM_ADDBY_MATERIAL, _ => TagMode.TM_ADDBY_CATEGORY };
                    int n = 0;
                    foreach (ElementId id in (op["ids"] as JArray ?? throw new InvalidOperationException("tag needs ids")).Select(t => Ref(doc, t, made)))
                    {
                        Element e = doc.GetElement(id);
                        XYZ at = Where(e) + offset;
                        Element tag;
                        if (e is Room room) tag = doc.Create.NewRoomTag(new LinkElementId(room.Id), new UV(at.X, at.Y), v.Id);
                        else if (e is Space space) tag = doc.Create.NewSpaceTag(space, new UV(at.X, at.Y), (ViewPlan)v);
                        else if (e is Area area) tag = doc.Create.NewAreaTag((ViewPlan)v, area, new UV(at.X, at.Y));
                        else if (tagType != null) tag = IndependentTag.Create(doc, tagType, v.Id, new Reference(e), leader, orient, at);
                        else tag = IndependentTag.Create(doc, v.Id, new Reference(e), leader, mode, orient, at);
                        if (tagType != null && !(tag is IndependentTag)) tag.ChangeTypeId(tagType);
                        created.Add(tag.Id); n++;
                    }
                    return new JObject { ["tagged"] = n };
                }
                case "spot_elevation":
                case "spot_coordinate":
                {
                    // on the top face of the element (a floor, roof, toposolid, stair...), at point_mm in plan
                    View v = ViewOf(doc, op["view"], made);
                    Element e = doc.GetElement(Ref(doc, op["id"], made) ?? throw new InvalidOperationException($"{name} needs id (the element to spot)"));
                    var (face, hit) = TopFace(e, Vec(op["point_mm"], $"{name} needs point_mm [x, y]"));
                    XYZ bend = hit + new XYZ(Ft(800), Ft(800), 0), end = bend + new XYZ(Ft(600), 0, 0);
                    bool leader = op.Value<bool?>("leader") ?? true;
                    SpotDimension sd = name == "spot_elevation"
                        ? doc.Create.NewSpotElevation(v, face, hit, bend, end, hit, leader)
                        : doc.Create.NewSpotCoordinate(v, face, hit, bend, end, hit, leader);
                    created.Add(sd.Id);
                    return new JObject { ["spot"] = sd.Id.Value };
                }
                case "revision_cloud":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var loops = Loops(op);
                    var revs = Revision.GetAllRevisionIds(doc);
                    ElementId rev = op["revision"] != null
                        ? revs.FirstOrDefault(r => string.Equals(((Revision)doc.GetElement(r)).Description, op.Value<string>("revision"), StringComparison.OrdinalIgnoreCase)
                            || ((Revision)doc.GetElement(r)).SequenceNumber.ToString() == op.Value<string>("revision")) ?? throw new InvalidOperationException($"no revision {op.Value<string>("revision")}")
                        : revs.LastOrDefault() ?? Revision.Create(doc).Id;
                    var curves = loops.SelectMany(l => l.Cast<Curve>()).ToList();
                    RevisionCloud rc = RevisionCloud.Create(doc, v, rev, curves);
                    created.Add(rc.Id);
                    return new JObject { ["cloud"] = rc.Id.Value, ["revision"] = ((Revision)doc.GetElement(rev)).SequenceNumber };
                }
                case "place_annotation":
                {
                    // a detail item, symbol or generic annotation family type, in a view
                    View v = ViewOf(doc, op["view"], made);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                        .Where(f => f.Category != null && (f.Category.CategoryType == CategoryType.Annotation || f.Category.Id.Value == (long)BuiltInCategory.OST_DetailComponents)).Select(f => f.Id).ToList();
                    var sym = (FamilySymbol)doc.GetElement(TypeFor(doc, op, types));
                    if (!sym.IsActive) sym.Activate();
                    FamilyInstance fi = doc.Create.NewFamilyInstance(Vec(op["point_mm"], "place_annotation needs point_mm"), sym, v);
                    if (op["rotation_deg"] != null)
                        ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(Where(fi), Where(fi) + v.ViewDirection), op.Value<double>("rotation_deg") * Math.PI / 180);
                    created.Add(fi.Id);
                    return new JObject { ["placed"] = fi.Id.Value };
                }
                case "color_fill_legend":
                {
                    // the view's colour scheme for the category (scheme by name, optional), and its legend at point_mm
                    View v = ViewOf(doc, op["view"], made);
                    ElementId cat = Categories(doc, new JArray(op.Value<string>("category") ?? "Rooms"))[0];
                    if (op["scheme"] != null)
                    {
                        ElementId scheme = new FilteredElementCollector(doc).OfClass(typeof(ColorFillScheme)).Cast<ColorFillScheme>()
                            .FirstOrDefault(c => c.CategoryId == cat && string.Equals(c.Name, op.Value<string>("scheme"), StringComparison.OrdinalIgnoreCase))?.Id
                            ?? throw new InvalidOperationException($"no colour scheme {op.Value<string>("scheme")} for that category");
                        v.SetColorFillSchemeId(cat, scheme);
                    }
                    ColorFillLegend lg = ColorFillLegend.Create(doc, v.Id, cat, Vec(op["point_mm"], "color_fill_legend needs point_mm"));
                    created.Add(lg.Id);
                    return new JObject { ["legend"] = lg.Id.Value };
                }
                default: return FamilyOp(doc, name, op, made, created);
            }
        }

        private static List<CurveLoop> Loops(JObject op)
        {
            // outline_mm: one loop; loops_mm: several (the first the outside, the rest holes)
            var raw = op["loops_mm"] as JArray ?? new JArray(op["outline_mm"] ?? throw new InvalidOperationException("the op needs outline_mm (a closed loop) or loops_mm"));
            return raw.OfType<JArray>().Select(a =>
            {
                var p = Points(a, "a loop is [[x, y], ...]");
                var loop = new CurveLoop();
                for (int i = 0; i < p.Count; i++) loop.Append(Line.CreateBound(p[i], p[(i + 1) % p.Count]));
                return loop;
            }).ToList();
        }

        private static ElementId MaskingType(Document doc) =>
            new FilteredElementCollector(doc).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().FirstOrDefault(t => t.IsMasking)?.Id
            ?? throw new InvalidOperationException("the model has no masking region type");

        private static GraphicsStyle LineStyle(Document doc, string name)
        {
            Category lines = Category.GetCategory(doc, BuiltInCategory.OST_Lines);
            Category sub = lines.SubCategories.Cast<Category>().FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"no line style {name} (styles: {string.Join(", ", lines.SubCategories.Cast<Category>().Select(c => c.Name).Take(30))})");
            return sub.GetGraphicsStyle(GraphicsStyleType.Projection);
        }

        private static ElementId TagTypeId(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(f => f.Category?.CategoryType == CategoryType.Annotation && (string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase) || string.Equals(f.FamilyName + ": " + f.Name, name, StringComparison.OrdinalIgnoreCase)))?.Id
            ?? throw new InvalidOperationException($"no tag type {name} (load the tag family first)");

        private static XYZ Where(Element e)
        {
            if (e.Location is LocationPoint lp) return lp.Point;
            if (e.Location is LocationCurve lc) return lc.Curve.Evaluate(0.5, true);
            BoundingBoxXYZ bb = e.get_BoundingBox(null) ?? throw new InvalidOperationException($"{e.Id.Value} has no location to tag");
            return (bb.Min + bb.Max) / 2;
        }

        /// <summary>The element's upward face under a plan point, as a reference for spots.</summary>
        private static (Reference, XYZ) TopFace(Element e, XYZ plan)
        {
            var opt = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            Reference best = null; XYZ hit = null; double top = double.MinValue;
            foreach (Solid s in Solids(e.get_Geometry(opt)))
                foreach (Face f in s.Faces)
                {
                    if (f.Reference == null) continue;
                    IntersectionResult r = f.Project(new XYZ(plan.X, plan.Y, f.Evaluate(new UV(0.5, 0.5)).Z));
                    if (r == null) continue;
                    XYZ n = f.ComputeNormal(r.UVPoint);
                    if (n.Z <= 0.1) continue;
                    if (Math.Abs(r.XYZPoint.X - plan.X) > 0.05 || Math.Abs(r.XYZPoint.Y - plan.Y) > 0.05) continue;
                    if (r.XYZPoint.Z > top) { top = r.XYZPoint.Z; best = f.Reference; hit = r.XYZPoint; }
                }
            return best != null ? (best, hit) : throw new InvalidOperationException($"no upward face of {e.Id.Value} under that point");
        }

        private static IEnumerable<Solid> Solids(GeometryElement g)
        {
            if (g == null) yield break;
            foreach (GeometryObject o in g)
            {
                if (o is Solid s && s.Faces.Size > 0) yield return s;
                else if (o is GeometryInstance gi) foreach (Solid x in Solids(gi.GetInstanceGeometry())) yield return x;
            }
        }
    }
}
