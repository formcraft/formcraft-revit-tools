using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using Rhino.Geometry;

namespace Formcraft.Rhino
{
    /// <summary>One family part: a named closed solid with what Revit needs to place it (subcategory, material, visibility).</summary>
    public class Part
    {
        public string Name;
        public string Op;
        public Brep Brep;
        public string Subcategory = "";
        public string Material = "";
        /// <summary>fine (LOD 400 detail, the default), medium_fine, or all.</summary>
        public string Visibility = "fine";
        public JObject Spec;
    }

    /// <summary>
    /// The parts vocabulary (docs/handoff/DETAILED_FAMILIES_RHINO.md, step 1). Millimetres, a part's own origin is where
    /// Revit places it. Named operations only: box_rounded, extrude, revolve, pipe, loft, torus, sphere, shell, boolean,
    /// fillet. Each answer is one closed, outward-facing solid or an error that says why.
    /// </summary>
    public static class RhinoParts
    {
        public const double Tol = 0.01;   // mm
        public const double AngTol = Math.PI / 180;

        public static readonly string[] Ops = { "box_rounded", "extrude", "revolve", "pipe", "loft", "torus", "sphere", "shell", "boolean", "fillet" };

        public static Part Build(JObject s, IDictionary<string, Part> parts, List<string> consumed)
        {
            string name = Req<string>(s, "name");
            string op = Req<string>(s, "op");
            Brep b;
            switch (op)
            {
                case "box_rounded": b = BoxRounded(s); break;
                case "extrude": b = Extrude(s); break;
                case "revolve": b = Revolve(s); break;
                case "pipe": b = Pipe(s); break;
                case "loft": b = Loft(s); break;
                case "torus": b = Brep.CreateFromTorus(new Torus(PlaneOf(s, "center"), Num(s, "major"), Num(s, "minor"))); break;
                case "sphere": b = Brep.CreateFromSphere(new Sphere(Pt(s["center"], Point3d.Origin), Num(s, "radius"))); break;
                case "shell": b = Shell(s, parts, consumed); break;
                case "boolean": b = Boolean(s, parts, consumed); break;
                case "fillet": b = FilletOp(s, parts, consumed); break;
                default: throw new ArgumentException($"{name}: no operation \"{op}\" (one of {string.Join(", ", Ops)})");
            }
            if (b == null) throw new InvalidOperationException($"{name}: {op} made nothing: check its values");
            if (s["fillet"] != null && op != "fillet" && op != "box_rounded") b = FilletAll(b, Num(s, "fillet"), name, "all");
            Place(b, s);
            b.Faces.SplitKinkyFaces(AngTol, true);
            if (b.IsSolid && b.SolidOrientation == BrepSolidOrientation.Inward) b.Flip();
            return new Part
            {
                Name = name, Op = op, Brep = b, Spec = s,
                Subcategory = s.Value<string>("subcategory") ?? "",
                Material = s.Value<string>("material") ?? "",
                Visibility = s.Value<string>("visibility") ?? "fine",
            };
        }

        // ---- the operations -------------------------------------------------------------------------------------------

        static Brep BoxRounded(JObject s)
        {
            double[] size = Arr(s, "size", 3);
            Point3d c = Pt(s["center"], new Point3d(0, 0, size[2] / 2));
            var box = new BoundingBox(c.X - size[0] / 2, c.Y - size[1] / 2, c.Z - size[2] / 2, c.X + size[0] / 2, c.Y + size[1] / 2, c.Z + size[2] / 2);
            Brep b = Brep.CreateFromBox(box);
            double r = s["radius"] != null ? Num(s, "radius") : 0;
            if (r <= 0) return b;
            if (r >= size.Min() / 2) throw new ArgumentException($"{s["name"]}: radius {r} must be under half the smallest side ({size.Min() / 2})");
            return FilletAll(b, r, (string)s["name"], "all");
        }

        static Brep Extrude(JObject s)
        {
            Plane pl = PlaneOf(s, "origin");
            Curve prof = Profile(s["profile"] as JObject ?? throw new ArgumentException($"{s["name"]}: extrude needs a profile"), pl, (string)s["name"]);
            double h = Num(s, "height");
            Surface srf = Surface.CreateExtrusion(prof, pl.Normal * h);
            Brep b = srf?.ToBrep()?.CapPlanarHoles(Tol);
            if (b == null) throw new InvalidOperationException($"{s["name"]}: the profile must be closed and flat to extrude to a solid");
            return b;
        }

        /// <summary>A lathe profile [[r, z], …] about an axis (origin, direction; default the Z axis). Ends off the axis are closed to it.</summary>
        static Brep Revolve(JObject s)
        {
            Point3d o = Pt(s["origin"], Point3d.Origin);
            Vector3d dir = Vec(s["axis"], Vector3d.ZAxis);
            var frame = new Plane(o, dir);
            var rz = (s["profile"] as JArray ?? throw new ArgumentException($"{s["name"]}: revolve needs a profile [[r, z], …]")).Select(p => new[] { (double)p[0], (double)p[1] }).ToList();
            if (rz.Count < 2) throw new ArgumentException($"{s["name"]}: a profile needs two points or more");
            if (rz.Any(p => p[0] < -Tol)) throw new ArgumentException($"{s["name"]}: a radius can't be negative");
            Func<double[], Point3d> at = p => o + frame.XAxis * p[0] + dir * p[1] / dir.Length;
            // the profile meets the axis at both ends; points given on the axis stay joined by straight lines (a flat base or
            // top), and smooth runs a curve through the points between them
            if (rz[0][0] > Tol) rz.Insert(0, new[] { 0, rz[0][1] });
            if (rz[rz.Count - 1][0] > Tol) rz.Add(new[] { 0, rz[rz.Count - 1][1] });
            var pts = rz.Select(at).ToList();
            Curve prof;
            if (s.Value<bool?>("smooth") == true && pts.Count >= 5)
            {
                var inner = pts.GetRange(1, pts.Count - 2);
                prof = Curve.JoinCurves(new Curve[] { new LineCurve(pts[0], inner[0]), Curve.CreateInterpolatedCurve(inner, 3), new LineCurve(inner[inner.Count - 1], pts[pts.Count - 1]) }, Tol).FirstOrDefault()
                    ?? throw new InvalidOperationException($"{s["name"]}: the smooth profile didn't join");
            }
            else
            {
                prof = new PolylineCurve(pts);
                if (s["corner_radius"] != null) prof = Curve.CreateFilletCornersCurve(prof, Num(s, "corner_radius"), Tol, AngTol) ?? prof;
            }
            double deg = s["angle"] != null ? Num(s, "angle") : 360;
            var rev = RevSurface.Create(prof, new Line(o, o + dir), 0, deg * Math.PI / 180);
            bool partial = deg < 360 - 1e-6;
            Brep b = rev == null ? null : Brep.CreateFromRevSurface(rev, partial, partial);
            if (b != null && partial && !b.IsSolid) b = b.CapPlanarHoles(Tol) ?? b;
            // one face per smooth piece: a flat base is its own face (shell can open it) and Revit reads clean faces
            b?.Faces.SplitKinkyFaces(AngTol, true);
            return b;
        }

        /// <summary>A tube along a path: points with optional corner_radius, or an arc { start, mid, end }; caps flat or round.</summary>
        static Brep Pipe(JObject s)
        {
            Curve rail;
            if (s["arc"] is JObject a) rail = new ArcCurve(new Arc(Pt(a["start"], Point3d.Unset), Pt(a["mid"], Point3d.Unset), Pt(a["end"], Point3d.Unset)));
            else
            {
                var pts = (s["path"] as JArray ?? throw new ArgumentException($"{s["name"]}: pipe needs a path or an arc")).Select(p => Pt(p, Point3d.Unset)).ToList();
                if (pts.Count < 2) throw new ArgumentException($"{s["name"]}: a path needs two points or more");
                rail = new PolylineCurve(pts);
                if (s["corner_radius"] != null && pts.Count > 2)
                    rail = Curve.CreateFilletCornersCurve(rail, Num(s, "corner_radius"), Tol, AngTol)
                        ?? throw new ArgumentException($"{s["name"]}: corner_radius {s["corner_radius"]} doesn't fit the path's segments");
            }
            double r = Num(s, "radius");
            var cap = rail.IsClosed ? PipeCapMode.None : (s.Value<string>("caps") == "round" ? PipeCapMode.Round : PipeCapMode.Flat);
            Brep[] made = Brep.CreatePipe(rail, r, false, cap, true, Tol, AngTol);
            return Single(made, (string)s["name"], "pipe");
        }

        /// <summary>Sections, each { origin, normal?, profile }, lofted in order and capped.</summary>
        static Brep Loft(JObject s)
        {
            var secs = s["sections"] as JArray ?? throw new ArgumentException($"{s["name"]}: loft needs sections");
            if (secs.Count < 2) throw new ArgumentException($"{s["name"]}: a loft needs two sections or more");
            var curves = secs.Select((t, i) =>
            {
                var o = (JObject)t;
                var pl = new Plane(Pt(o["origin"], Point3d.Origin), Vec(o["normal"], Vector3d.ZAxis));
                return Profile(o["profile"] as JObject ?? throw new ArgumentException($"{s["name"]}: section {i + 1} needs a profile"), pl, (string)s["name"]);
            }).ToList();
            var type = s.Value<bool?>("straight") == true ? LoftType.Straight : LoftType.Normal;
            Brep[] made = Brep.CreateFromLoft(curves, Point3d.Unset, Point3d.Unset, type, false);
            Brep b = Single(made, (string)s["name"], "loft");
            return b.IsSolid ? b : b.CapPlanarHoles(Tol) ?? throw new InvalidOperationException($"{s["name"]}: the loft's ends aren't flat, so it can't be capped");
        }

        static Brep Shell(JObject s, IDictionary<string, Part> parts, List<string> consumed)
        {
            Part of = Use(s, "of", parts, consumed);
            double t = Num(s, "thickness");
            var open = (s["open"] as JArray ?? new JArray()).Select(d => Dir((string)d)).ToList();
            if (open.Count == 0) throw new ArgumentException($"{s["name"]}: shell needs open faces (e.g. [\"+z\"]): a closed hollow can't go to Revit as one form");
            var faces = new List<int>();
            for (int i = 0; i < of.Brep.Faces.Count; i++)
            {
                BrepFace f = of.Brep.Faces[i];
                Vector3d n = f.NormalAt(f.Domain(0).Mid, f.Domain(1).Mid);
                if (f.OrientationIsReversed) n.Reverse();
                if (open.Any(d => n * d > 0.99)) faces.Add(i);
            }
            if (faces.Count == 0) throw new ArgumentException($"{s["name"]}: no face of {of.Name} faces {string.Join(", ", s["open"])}");
            return Single(Brep.CreateShell(of.Brep, faces, t, Tol), (string)s["name"], "shell");
        }

        static Brep Boolean(JObject s, IDictionary<string, Part> parts, List<string> consumed)
        {
            string kind = s.Value<string>("kind") ?? "union";
            var names = (s["parts"] as JArray ?? throw new ArgumentException($"{s["name"]}: boolean needs parts")).Select(t => (string)t).ToList();
            if (names.Count < 2) throw new ArgumentException($"{s["name"]}: a boolean needs two parts or more");
            bool keep = s.Value<bool?>("keep") == true;
            var breps = names.Select(n => parts.TryGetValue(n, out Part p) ? p.Brep : throw new ArgumentException($"{s["name"]}: no part named {n}")).ToList();
            Brep[] made;
            switch (kind)
            {
                case "union": made = Brep.CreateBooleanUnion(breps, Tol); break;
                case "difference": made = Brep.CreateBooleanDifference(new[] { breps[0] }, breps.Skip(1), Tol); break;
                case "intersection":
                    if (breps.Count != 2) throw new ArgumentException($"{s["name"]}: intersection takes two parts");
                    made = Brep.CreateBooleanIntersection(breps[0], breps[1], Tol); break;
                default: throw new ArgumentException($"{s["name"]}: kind is union, difference or intersection");
            }
            Brep b = Single(made, (string)s["name"], kind);
            if (!keep) consumed.AddRange(names);
            return b;
        }

        static Brep FilletOp(JObject s, IDictionary<string, Part> parts, List<string> consumed)
        {
            Part of = Use(s, "of", parts, consumed);
            return FilletAll(of.Brep, Num(s, "radius"), (string)s["name"], s.Value<string>("edges") ?? "all");
        }

        // ---- helpers ---------------------------------------------------------------------------------------------------

        /// <summary>Fillets every edge (or only the vertical or horizontal ones) at one radius, as a person would in Rhino.</summary>
        public static Brep FilletAll(Brep b, double r, string name, string which)
        {
            var idx = new List<int>();
            for (int i = 0; i < b.Edges.Count; i++)
            {
                BrepEdge e = b.Edges[i];
                if (e.Valence != EdgeAdjacency.Interior) continue;
                Vector3d d = e.PointAtEnd - e.PointAtStart;
                bool straight = e.IsLinear(Tol);
                if (which == "vertical" && !(straight && d.Length > Tol && Math.Abs(d.Unitize() ? d.Z : 0) > 0.99)) continue;
                if (which == "horizontal" && !(straight && d.Length > Tol && Math.Abs(d.Unitize() ? d.Z : 1) < 0.01)) continue;
                idx.Add(i);
            }
            if (idx.Count == 0) throw new ArgumentException($"{name}: no {which} edges to fillet");
            var radii = idx.Select(_ => r).ToList();
            Brep[] made = Brep.CreateFilletEdges(b, idx, radii, radii, BlendType.Fillet, RailType.RollingBall, Tol);
            if (made == null || made.Length == 0) throw new InvalidOperationException($"{name}: a fillet of {r} mm doesn't fit: try a smaller radius");
            return Single(made, name, "fillet");
        }

        /// <summary>A closed flat profile on a plane: rect [w, h], rounded_rect [w, h, r], circle r, ellipse [a, b], or points [[x, y], …] (corner_radius, smooth).</summary>
        static Curve Profile(JObject p, Plane pl, string name)
        {
            if (p["rect"] is JArray r) return new Rectangle3d(pl, new Interval(-(double)r[0] / 2, (double)r[0] / 2), new Interval(-(double)r[1] / 2, (double)r[1] / 2)).ToNurbsCurve();
            if (p["rounded_rect"] is JArray rr)
            {
                Curve c = new Rectangle3d(pl, new Interval(-(double)rr[0] / 2, (double)rr[0] / 2), new Interval(-(double)rr[1] / 2, (double)rr[1] / 2)).ToNurbsCurve();
                return Curve.CreateFilletCornersCurve(c, (double)rr[2], Tol, AngTol) ?? throw new ArgumentException($"{name}: corner radius {rr[2]} is too big for {rr[0]} × {rr[1]}");
            }
            if (p["circle"] != null) return new Circle(pl, (double)p["circle"]).ToNurbsCurve();
            if (p["ellipse"] is JArray el) return new Ellipse(pl, (double)el[0], (double)el[1]).ToNurbsCurve();
            if (p["points"] is JArray pts)
            {
                var list = pts.Select(t => pl.PointAt((double)t[0], (double)t[1])).ToList();
                if (list.Count < 3) throw new ArgumentException($"{name}: a points profile needs three points or more");
                if (p.Value<bool?>("smooth") == true) return Curve.CreateInterpolatedCurve(list, 3, CurveKnotStyle.ChordPeriodic);
                if (list[0].DistanceTo(list[list.Count - 1]) > Tol) list.Add(list[0]);
                Curve c = new PolylineCurve(list);
                if (p["corner_radius"] != null) c = Curve.CreateFilletCornersCurve(c, (double)p["corner_radius"], Tol, AngTol) ?? c;
                return c;
            }
            throw new ArgumentException($"{name}: a profile is rect, rounded_rect, circle, ellipse or points");
        }

        /// <summary>rotate { axis, deg, center? } then move [x, y, z].</summary>
        static void Place(Brep b, JObject s)
        {
            if (s["rotate"] is JObject rot)
                b.Transform(Transform.Rotation(Num(rot, "deg") * Math.PI / 180, Vec(rot["axis"], Vector3d.ZAxis), Pt(rot["center"], Point3d.Origin)));
            if (s["move"] != null) b.Transform(Transform.Translation(new Vector3d(Pt(s["move"], Point3d.Origin))));
        }

        static Part Use(JObject s, string key, IDictionary<string, Part> parts, List<string> consumed)
        {
            string n = Req<string>(s, key);
            if (!parts.TryGetValue(n, out Part p)) throw new ArgumentException($"{s["name"]}: no part named {n}");
            if (s.Value<bool?>("keep") != true) consumed.Add(n);
            return p;
        }

        static Brep Single(Brep[] made, string name, string what)
        {
            if (made == null || made.Length == 0) throw new InvalidOperationException($"{name}: the {what} failed: check its values");
            if (made.Length == 1) return made[0];
            Brep[] joined = Brep.JoinBreps(made, Tol);
            if (joined != null && joined.Length == 1) return joined[0];
            throw new InvalidOperationException($"{name}: the {what} made {made.Length} separate pieces: a part is one solid");
        }

        static Plane PlaneOf(JObject s, string originKey) => new Plane(Pt(s[originKey], Point3d.Origin), Vec(s["normal"], Vector3d.ZAxis));

        static Vector3d Dir(string d)
        {
            switch ((d ?? "").ToLowerInvariant())
            {
                case "+x": return Vector3d.XAxis; case "-x": return -Vector3d.XAxis;
                case "+y": return Vector3d.YAxis; case "-y": return -Vector3d.YAxis;
                case "+z": return Vector3d.ZAxis; case "-z": return -Vector3d.ZAxis;
                default: throw new ArgumentException($"a direction is +x, -x, +y, -y, +z or -z, not \"{d}\"");
            }
        }

        static Point3d Pt(JToken t, Point3d dflt)
        {
            if (t == null || t.Type == JTokenType.Null)
            {
                if (dflt == Point3d.Unset) throw new ArgumentException("a point is missing");
                return dflt;
            }
            var a = (JArray)t;
            return new Point3d((double)a[0], (double)a[1], a.Count > 2 ? (double)a[2] : 0);
        }

        static Vector3d Vec(JToken t, Vector3d dflt)
        {
            if (t == null || t.Type == JTokenType.Null) return dflt;
            var a = (JArray)t;
            var v = new Vector3d((double)a[0], (double)a[1], a.Count > 2 ? (double)a[2] : 0);
            if (!v.Unitize()) throw new ArgumentException("a direction can't be zero");
            return v;
        }

        static double Num(JObject s, string key)
        {
            JToken t = s[key];
            if (t == null || (t.Type != JTokenType.Float && t.Type != JTokenType.Integer)) throw new ArgumentException($"{s["name"]}: {key} must be a number (mm)");
            double v = (double)t;
            if (!(v > 0) && key != "deg") throw new ArgumentException($"{s["name"]}: {key} must be more than 0");
            return v;
        }

        static double[] Arr(JObject s, string key, int n)
        {
            var a = s[key] as JArray;
            if (a == null || a.Count != n) throw new ArgumentException($"{s["name"]}: {key} is [{string.Join(", ", Enumerable.Repeat("mm", n))}]");
            var v = a.Select(t => (double)t).ToArray();
            if (v.Any(x => !(x > 0))) throw new ArgumentException($"{s["name"]}: every {key} value must be more than 0");
            return v;
        }

        static T Req<T>(JObject s, string key)
        {
            JToken t = s[key];
            if (t == null || t.Type == JTokenType.Null || (t.Type == JTokenType.String && ((string)t).Length == 0))
                throw new ArgumentException($"{s["name"] ?? "a part"}: {key} is required");
            return t.Value<T>();
        }
    }
}
