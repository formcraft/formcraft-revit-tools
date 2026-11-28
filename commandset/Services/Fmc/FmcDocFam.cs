using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Lighting;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Family editor tool ops (FE-02 to FE-05): swept blends, filled and masking regions, detail lines, text notes and a
    /// lighting family's light source, all inside the background family document of an fmc_doc session. Each op answers
    /// create, update or skip and names what it makes (FmcDocGeometry.Label), like every other fmc_doc op, so a second run
    /// changes nothing; the dry run is the real run rolled back (FmcDocOps.Apply).
    /// </summary>
    public static class FmcDocFam
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double ToMm(double ft) => UnitUtils.ConvertFromInternalUnits(ft, UnitTypeId.Millimeters);

        private static List<Element> Named(Document doc, string name) => FmcDocLod.AllNamed(doc, name);

        private static double[] Arr(JToken t) => ((JArray)t).Select(v => v.Value<double>()).ToArray();

        // ---- FE-02: swept blend ---------------------------------------------------------------------------------------

        public static (string, string) SweptBlend(Document doc, JObject op, bool isVoid)
        {
            string name = op.Value<string>("name");
            if (FmcDocGeometry.Solid(doc, name) != null) return ("skip", "exists");
            var path = ((JArray)op["path"]).Select(Arr).ToList();
            XYZ a = new XYZ(Mm(path[0][0]), Mm(path[0][1]), Mm(path[0][2]));
            XYZ b = new XYZ(Mm(path[1][0]), Mm(path[1][1]), Mm(path[1][2]));
            XYZ along = (b - a).Normalize();
            bool vertical = Math.Abs(along.DotProduct(XYZ.BasisZ)) > 0.999;
            bool horizontal = Math.Abs(along.Z) < 1e-9;
            XYZ across = vertical ? XYZ.BasisX : along.CrossProduct(XYZ.BasisZ).Normalize();
            XYZ up = vertical ? XYZ.BasisY : across.CrossProduct(along).Normalize();
            SketchPlane sketch = SketchPlane.Create(doc, horizontal
                ? Plane.CreateByNormalAndOrigin(XYZ.BasisZ, a)
                : Plane.CreateByNormalAndOrigin(across, a));
            SweepProfile Prof(JToken t, XYZ at, bool splines)
            {
                var arr = new CurveArrArray();
                arr.Append(FmcCurves.Loop(doc, t, p => at + across * Mm(p[0]) + up * Mm(p[1]), true, splines));
                return doc.Application.Create.NewCurveLoopsProfile(arr);
            }
            bool hasSplines = FmcCurves.HasSplines(op["bottom"]) || FmcCurves.HasSplines(op["top"]);
            SweptBlend made = FmcCurves.WithFallback(splines =>
                doc.FamilyCreate.NewSweptBlend(!isVoid, Line.CreateBound(a, b), sketch, Prof(op["bottom"], a, splines), Prof(op["top"], b, splines)), hasSplines);
            FmcDocGeometry.Label(made, name);
            if (!isVoid) FmcDocLod.ApplySubcategory(doc, made, op);
            return ("create", (isVoid ? "void " : "") + "swept blend " + FmcCurves.Count(op["bottom"]) + " → " + FmcCurves.Count(op["top"]) + " nodes, " + Math.Round(ToMm(a.DistanceTo(b))) + " mm");
        }

        // ---- FE-03 / FE-05: 2D in a view ------------------------------------------------------------------------------

        /// <summary>plan, front, right as fmc_doc draws them; annotation: the one drawing view of an annotation, tag or title block family.</summary>
        internal static View View2D(Document doc, string kind)
        {
            if (kind != "annotation") return FmcDocLod.ViewFor(doc, kind);
            var skip = new HashSet<ViewType> { ViewType.ThreeD, ViewType.Schedule, ViewType.ProjectBrowser, ViewType.SystemBrowser, ViewType.Internal, ViewType.Undefined, ViewType.Walkthrough, ViewType.Rendering };
            return new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(v => !v.IsTemplate && !skip.Contains(v.ViewType))
                ?? throw new InvalidOperationException("No drawing view in this family");
        }

        private static string PlaneKind(string kind) => kind == "annotation" ? "plan" : kind;

        /// <summary>A point drawn in the view's own plane: the op's 2D point placed, then dropped square onto the view plane.</summary>
        private static XYZ OnView(View v, string kind, double[] p)
        {
            XYZ pt = FmcDocLod.To3D(PlaneKind(kind), p, 0);
            XYZ n = v.ViewDirection.Normalize();
            return pt - n * (pt - v.Origin).DotProduct(n);
        }

        public static (string, string) Region(Document doc, JObject op, bool masking)
        {
            string name = op.Value<string>("name");
            string kind = op.Value<string>("view") ?? "plan";
            if (Named(doc, name).OfType<FilledRegion>().Any()) return ("skip", "exists");
            View view = View2D(doc, kind);
            CurveArray arr = FmcCurves.Loop(doc, op["points"], p => OnView(view, kind, p), true, false);
            var loop = new CurveLoop();
            foreach (Curve c in arr) loop.Append(c);
            var loops = new List<CurveLoop> { loop };
            FilledRegion made;
            if (masking)
            {
#if REVIT2024_OR_GREATER
                made = FilledRegion.CreateMaskingRegion(doc, view.Id, loops);
#else
                throw new InvalidOperationException("masking_region needs Revit 2024 or later");
#endif
            }
            else
            {
                string want = op.Value<string>("region_type");
                var types = new FilteredElementCollector(doc).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().ToList();
                FilledRegionType type = string.IsNullOrEmpty(want) ? types.FirstOrDefault() : types.FirstOrDefault(t => string.Equals(t.Name, want, StringComparison.OrdinalIgnoreCase));
                if (type == null) throw new InvalidOperationException(string.IsNullOrEmpty(want) ? "No filled region type in this family" : "No filled region type " + want);
                made = FilledRegion.Create(doc, type.Id, view.Id, loops);
            }
            FmcDocGeometry.Label(made, name);
            return ("create", (masking ? "masking" : "filled") + " region in " + view.Name + ", " + FmcCurves.Count(op["points"]) + " nodes");
        }

        public static (string, string) DetailLines(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            string kind = op.Value<string>("view") ?? "plan";
            if (Named(doc, name).OfType<DetailCurve>().Any()) return ("skip", "exists");
            View view = View2D(doc, kind);
            var pts = ((JArray)op["points"]).Select(Arr).Select(p => OnView(view, kind, p)).ToList();
            bool closed = op.Value<bool?>("closed") ?? false;
            var arr = new CurveArray();
            double shortest = doc.Application.ShortCurveTolerance;
            int n = closed ? pts.Count : pts.Count - 1;
            for (int k = 0; k < n; k++)
            {
                XYZ p0 = pts[k], p1 = pts[(k + 1) % pts.Count];
                if (p0.DistanceTo(p1) >= shortest) arr.Append(Line.CreateBound(p0, p1));
            }
            if (arr.Size == 0) throw new InvalidOperationException("detail_lines: every segment is too short");
            DetailCurveArray made = doc.FamilyCreate.NewDetailCurveArray(view, arr);
            GraphicsStyle style = null;
            string want = op.Value<string>("line_style");
            if (!string.IsNullOrEmpty(want))
            {
                Category lines = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
                Category sub = lines?.SubCategories.Cast<Category>().FirstOrDefault(c => string.Equals(c.Name, want, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException("No line style " + want);
                style = sub.GetGraphicsStyle(GraphicsStyleType.Projection);
            }
            foreach (DetailCurve c in made)
            {
                if (style != null) c.LineStyle = style;
                FmcDocGeometry.Label(c, name);
            }
            return ("create", made.Size + " detail lines in " + view.Name);
        }

        public static (string, string) TextNoteOp(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            string kind = op.Value<string>("view") ?? "annotation";
            string text = op.Value<string>("text") ?? throw new InvalidOperationException("text_note needs text");
            TextNote existing = Named(doc, name).OfType<TextNote>().FirstOrDefault();
            if (existing != null)
            {
                if (existing.Text.TrimEnd('\r', '\n') == text) return ("skip", "same text");
                existing.Text = text;
                return ("update", "text");
            }
            View view = View2D(doc, kind);
            string want = op.Value<string>("text_type");
            ElementId typeId = ElementId.InvalidElementId;
            if (!string.IsNullOrEmpty(want))
                typeId = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>()
                    .FirstOrDefault(t => string.Equals(t.Name, want, StringComparison.OrdinalIgnoreCase))?.Id ?? throw new InvalidOperationException("No text type " + want);
            if (typeId == ElementId.InvalidElementId) typeId = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType);
            if (typeId == ElementId.InvalidElementId)
                typeId = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).FirstElementId();
            if (typeId == ElementId.InvalidElementId) throw new InvalidOperationException("No text type in this family");
            TextNote made = TextNote.Create(doc, view.Id, OnView(view, kind, Arr(op["at"])), text, typeId);
            FmcDocGeometry.Label(made, name);
            return ("create", "text in " + view.Name);
        }

        // ---- FE-04: light source (from docs/handoff/kisic_gap_scripts/revit/16_family_light_source.cs) --------------

        public static (string, string) LightSource(Document doc, JObject op)
        {
            Category cat = doc.OwnerFamily.FamilyCategory;
            if (cat == null || cat.Id != new ElementId(BuiltInCategory.OST_LightingFixtures))
                throw new InvalidOperationException("A light source needs the Lighting Fixtures category (set_category first)");
            var changed = new List<string>();
            Parameter on = doc.OwnerFamily.LookupParameter("Light Source");
            if (on != null && !on.IsReadOnly && on.AsInteger() != 1) { on.Set(1); changed.Add("Light Source on"); doc.Regenerate(); }
            FamilyManager fm = doc.FamilyManager;
            LightFamily lf = LightFamily.GetLightFamily(doc);
            // the script's lesson: switching Light Source on makes no light types until family types are made after it,
            // so each family type is made again under its own name, values kept
            if (lf.GetNumberOfLightTypes() < fm.Types.Size)
            {
                var names = fm.Types.Cast<FamilyType>().Select(t => t.Name).ToList();
                foreach (string n in names)
                {
                    FamilyType ft = fm.Types.Cast<FamilyType>().First(t => t.Name == n);
                    fm.CurrentType = ft;
                    FamilyType nt = fm.NewType(n + "__lt");
                    fm.CurrentType = ft;
                    fm.DeleteCurrentType();
                    fm.CurrentType = nt;
                    fm.RenameCurrentType(n);
                }
                doc.Regenerate();
                lf = LightFamily.GetLightFamily(doc);
                changed.Add("types made again for " + lf.GetNumberOfLightTypes() + " light types");
            }
            string shape = op.Value<string>("shape") ?? "point", dist = op.Value<string>("distribution") ?? "hemispherical";
            LightShapeStyle wantShape = shape == "line" ? LightShapeStyle.Line : shape == "rectangle" ? LightShapeStyle.Rectangle : shape == "circle" ? LightShapeStyle.Circle : LightShapeStyle.Point;
            LightDistributionStyle wantDist = dist == "spot" ? LightDistributionStyle.Spot : dist == "spherical" ? LightDistributionStyle.Spherical : LightDistributionStyle.Hemispherical;
            if (lf.GetLightShapeStyle() != wantShape) { lf.SetLightShapeStyle(wantShape); changed.Add("shape " + shape); }
            if (lf.GetLightDistributionStyle() != wantDist) { lf.SetLightDistributionStyle(wantDist); changed.Add("distribution " + dist); }
            double kelvin = op.Value<double?>("kelvin") ?? 3000;
            var byType = op["lumens_by_type"] as JObject;
            double? all = op.Value<double?>("lumens");
            double LmFor(string type)
            {
                if (byType != null)
                {
                    var exact = byType.Properties().FirstOrDefault(p => p.Name == type) ?? byType.Properties().FirstOrDefault(p => type.StartsWith(p.Name, StringComparison.Ordinal));
                    if (exact != null) return exact.Value.Value<double>();
                }
                return all ?? throw new InvalidOperationException("No lumens for type " + type);
            }
            for (int i = 0; i < lf.GetNumberOfLightTypes(); i++)
            {
                string tn = lf.GetLightTypeName(i);
                LightType lt = lf.GetLightType(i);
                double lm = LmFor(tn);
                if (!(lt.GetInitialIntensity() is InitialFluxIntensity fi) || Math.Abs(fi.Flux - lm) > 0.5) { lt.SetInitialIntensity(new InitialFluxIntensity(lm)); changed.Add(tn + " " + lm + " lm"); }
                if (!(lt.GetInitialColor() is CustomInitialColor ci) || Math.Abs(ci.TemperatureValue - kelvin) > 0.5) { lt.SetInitialColor(new CustomInitialColor(kelvin)); changed.Add(tn + " " + kelvin + " K"); }
                if (wantDist == LightDistributionStyle.Spot && lt.GetLightDistribution() is SpotLightDistribution sd)
                {
                    double beam = (op.Value<double?>("beam_deg") ?? 60) * Math.PI / 180, field = (op.Value<double?>("field_deg") ?? 90) * Math.PI / 180;
                    if (Math.Abs(sd.SpotBeamAngle - beam) > 1e-6 || Math.Abs(sd.SpotFieldAngle - field) > 1e-6)
                    {
                        sd.SpotBeamAngle = beam; sd.SpotFieldAngle = field; lt.SetLightDistribution(sd);
                        changed.Add(tn + " beam " + Math.Round(beam * 180 / Math.PI) + "°/" + Math.Round(field * 180 / Math.PI) + "°");
                    }
                }
            }
            double? z = op.Value<double?>("source_z_mm");
            if (z.HasValue)
            {
                Element src = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_LightingFixtureSource).WhereElementIsNotElementType().FirstElement();
                BoundingBoxXYZ bb = src?.get_BoundingBox(null);
                if (src == null) throw new InvalidOperationException("No light source element to move");
                double cz = bb == null ? 0 : (bb.Min.Z + bb.Max.Z) / 2;
                if (Math.Abs(ToMm(cz) - z.Value) > 0.5) { ElementTransformUtils.MoveElement(doc, src.Id, new XYZ(0, 0, Mm(z.Value) - cz)); changed.Add("source at " + z.Value + " mm"); }
            }
            return changed.Count == 0 ? ("skip", "as asked") : ("update", string.Join("; ", changed));
        }
    }
}
