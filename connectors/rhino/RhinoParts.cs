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

        public static readonly string[] Ops = { "box_rounded", "extrude", "revolve", "pipe", "loft", "torus", "sphere", "shell", "boolean", "fillet",
            "extrude_points", "revolve_loop", "sweep_path", "subd" };

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
                case "extrude_points": b = ExtrudePoints(s); break;
                case "revolve_loop": b = RevolveLoop(s); break;
                case "sweep_path": b = SweepPath(s); break;
                case "subd": b = SubDPart(s); break;
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

        // ---- the smooth twins of recipe solids (world millimetres, the recipe's own points) -----------------------------
        // A detailed family's Fine level (LOD 400) is the same solid as its Medium one (LOD 300), drawn smooth: the recipe's
        // points are kept, and the runs that sample an arc become the arc (RhinoFit). "fit": false keeps the polyline.

        static List<Point3d> Points3d(JObject s, string key)
        {
            var a = s[key] as JArray ?? throw new ArgumentException($"{s["name"]}: {key} is required: [[x, y, z], …] in mm");
            return a.Select(p => Pt(p, Point3d.Unset)).ToList();
        }

        static Curve FitOrPoly(JObject s, List<Point3d> pts, bool closed)
        {
            if (s.Value<bool?>("fit") == false) return closed ? new PolylineCurve(pts.Concat(new[] { pts[0] })) : new PolylineCurve(pts);
            return RhinoFit.Fit(pts, closed);
        }

        /// <summary>A closed outline (world points on one plane) pushed along a vector: a recipe's point extrusion.</summary>
        static Brep ExtrudePoints(JObject s)
        {
            var pts = Points3d(s, "points");
            if (pts.Count < 3) throw new ArgumentException($"{s["name"]}: an outline needs three points or more");
            Vector3d v = Vec(s["vector"], Vector3d.Unset);
            double len = s["vector"] is JArray va ? new Vector3d((double)va[0], (double)va[1], va.Count > 2 ? (double)va[2] : 0).Length : 0;
            if (!(len > Tol)) throw new ArgumentException($"{s["name"]}: vector is the extrusion [dx, dy, dz] in mm");
            Curve c = FitOrPoly(s, pts, true);
            Brep b = Surface.CreateExtrusion(c, v * len)?.ToBrep()?.CapPlanarHoles(Tol);
            if (b == null) throw new InvalidOperationException($"{s["name"]}: the outline isn't flat or closed");
            return b;
        }

        /// <summary>
        /// A closed loop (world points) turned a full circle about an axis: a recipe's revolution. Edges of the loop that lie
        /// on the axis are left out (they would make a surface of no area); the rest turns into a closed solid.
        /// </summary>
        static Brep RevolveLoop(JObject s)
        {
            var pts = Points3d(s, "loop");
            Point3d o = Pt(s["origin"], Point3d.Origin);
            Vector3d dir = Vec(s["axis"], Vector3d.ZAxis);
            var axis = new Line(o, o + dir);
            bool On(Point3d p) => axis.DistanceTo(p, false) < Tol * 10;
            if (pts.Count > 2 && pts[0].DistanceTo(pts[pts.Count - 1]) < Tol) pts.RemoveAt(pts.Count - 1);
            int n = pts.Count;
            int cut = Enumerable.Range(0, n).FirstOrDefault(i => On(pts[i]) && On(pts[(i + 1) % n]) && pts[i].DistanceTo(pts[(i + 1) % n]) > Tol);
            bool hasAxisEdge = On(pts[cut]) && On(pts[(cut + 1) % n]);
            Curve prof;
            if (hasAxisEdge)
            {
                // start just after the axis edge and end just before it: an open profile with both ends on the axis
                var open = Enumerable.Range(0, n).Select(k => pts[(cut + 1 + k) % n]).ToList();
                // more than one axis edge (e.g. a stepped spindle) stays as one profile: the inner axis points are kept
                prof = FitOrPoly(s, open, false);
            }
            else prof = FitOrPoly(s, pts, true);
            var rev = RevSurface.Create(prof, axis, 0, 2 * Math.PI);
            Brep b = rev == null ? null : Brep.CreateFromRevSurface(rev, false, false);
            if (b != null && !b.IsSolid) b = b.CapPlanarHoles(Tol) ?? b;
            return b;
        }

        /// <summary>
        /// A profile swept along a path (world points): a recipe's sweep. A round profile becomes a true pipe; another
        /// keeps its shape, placed across the path at its start (x across the path, y up; on a path that starts vertical,
        /// x and y are world X and Y), as the command set draws it.
        /// </summary>
        static Brep SweepPath(JObject s)
        {
            var path = Points3d(s, "path");
            if (path.Count < 2) throw new ArgumentException($"{s["name"]}: a path needs two points or more");
            Curve rail = FitOrPoly(s, path, false);
            var prof2 = (s["profile"] as JArray ?? throw new ArgumentException($"{s["name"]}: profile is [[x, y], …] in mm")).Select(p => new Point3d((double)p[0], (double)p[1], 0)).ToList();
            if (RhinoFit.IsRound(prof2, out Point3d c, out double r) && c.DistanceTo(Point3d.Origin) < r * 0.05)
                return Single(Brep.CreatePipe(rail, r, false, PipeCapMode.Flat, false, Tol, AngTol), (string)s["name"], "pipe");
            Vector3d dir = rail.TangentAtStart;
            bool vertical = Math.Abs(dir * Vector3d.ZAxis) > 0.7;
            Plane frame;
            if (vertical) frame = new Plane(path[0], Vector3d.XAxis, Vector3d.YAxis);
            else
            {
                Vector3d across = Vector3d.CrossProduct(dir, Vector3d.ZAxis); across.Unitize();
                Vector3d up = Vector3d.CrossProduct(across, dir); up.Unitize();
                frame = new Plane(path[0], across, up);
            }
            var shapePts = prof2.Select(p => frame.PointAt(p.X, p.Y)).ToList();
            Curve shape = FitOrPoly(s, shapePts, true);
            Brep[] made = Brep.CreateFromSweep(rail, shape, false, Tol);
            Brep b = Single(made, (string)s["name"], "sweep");
            return b.IsSolid ? b : b.CapPlanarHoles(Tol) ?? throw new InvalidOperationException($"{s["name"]}: the sweep's ends couldn't be capped");
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

        /// <summary>
        /// SubD (owner 20 Oct: shapes a photo shows but flat outlines can't make: puffed cushions, a bent-wood shell that
        /// wraps a corner, a hull-like panel). A control cage, smoothed by Rhino's SubD and returned as an exact closed
        /// solid (NURBS), so it goes to Revit like any other part. Either
        ///   box: { center, size [x, y, z], divisions [nx, ny, nz] }: a smoothed box (a cushion; more divisions = flatter faces), or
        ///   vertices [[x, y, z], …] + faces [[a, b, c, d] or [a, b, c], …]: any closed cage (indices into vertices).
        /// creases: true keeps edges where the cage's vertices are not shared (give a seam its own vertices) sharp.
        /// </summary>
        static Brep SubDPart(JObject s)
        {
            string name = (string)s["name"];
            Mesh cage;
            if (s["box"] is JObject bx)
            {
                double[] size = Arr(bx, "size", 3);
                Point3d c = Pt(bx["center"], Point3d.Origin);
                var div = bx["divisions"] is JArray dv && dv.Count == 3 ? dv.Select(d => Math.Max(1, (int)d)).ToArray() : new[] { 2, 2, 2 };
                var box = new Box(new Plane(c, Vector3d.XAxis, Vector3d.YAxis), new Interval(-size[0] / 2, size[0] / 2), new Interval(-size[1] / 2, size[1] / 2), new Interval(-size[2] / 2, size[2] / 2));
                cage = Mesh.CreateFromBox(box, div[0], div[1], div[2]) ?? throw new InvalidOperationException($"{name}: the box cage wasn't made");
            }
            else
            {
                var verts = s["vertices"] as JArray ?? throw new ArgumentException($"{name}: subd needs a box or vertices and faces");
                var faces = s["faces"] as JArray ?? throw new ArgumentException($"{name}: subd needs faces [[a, b, c, d], …]");
                cage = new Mesh();
                foreach (JToken v in verts) cage.Vertices.Add(Pt(v, Point3d.Unset));
                foreach (JToken f in faces)
                {
                    var ix = f.Select(i => (int)i).ToArray();
                    if (ix.Any(i => i < 0 || i >= cage.Vertices.Count)) throw new ArgumentException($"{name}: a face uses a vertex that doesn't exist");
                    if (ix.Length == 4) cage.Faces.AddFace(ix[0], ix[1], ix[2], ix[3]);
                    else if (ix.Length == 3) cage.Faces.AddFace(ix[0], ix[1], ix[2]);
                    else throw new ArgumentException($"{name}: a face has 3 or 4 vertices");
                }
                cage.Normals.ComputeNormals();
                if (!cage.IsClosed) throw new ArgumentException($"{name}: the cage isn't closed (every edge must be shared by two faces), so it can't make a solid");
            }
            var options = s.Value<bool?>("creases") == true ? SubDCreationOptions.InteriorCreases : SubDCreationOptions.Smooth;
            SubD subd = SubD.CreateFromMesh(cage, options) ?? throw new InvalidOperationException($"{name}: Rhino couldn't make a SubD from the cage");
            Brep b = subd.ToBrep(SubDToBrepOptions.Default) ?? throw new InvalidOperationException($"{name}: the SubD didn't convert to a solid");
            if (!b.IsSolid) b = b.CapPlanarHoles(Tol) ?? b;
            if (!b.IsSolid) throw new InvalidOperationException($"{name}: the SubD isn't a closed solid: check the cage's faces face outward and close");
            return b;
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
