using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// G011 (L001 build plan; L003-F368 / F413, L001-F20): plane-locked outlines and revolutions, so curved and notched
    /// parts follow the type instead of staying at the first type's size.
    /// <para>extrusion / void_extrusion outline_planes: a closed loop of plane crossings drawn in the sketch plane; after
    /// the solid is made, every face that lies on one of the loop's planes is locked to it (the same face lock rect uses),
    /// so an L, U or T outline follows its planes. A plane with no face to lock fails the op.</para>
    /// <para>revolution profile_planes / axis_planes: the profile as a loop of plane crossings in the revolution's sketch
    /// plane, each profile line aligned and locked to the plane it runs along; the axis on the crossing of axis_planes, the
    /// sketch hosted on the second plane and the axis line locked to the first. A radius plane labelled with a parameter
    /// then drives the curved part (L001-F20 "curved detail fixed per type").</para>
    /// <para>To be confirmed in Revit (no live build was run): Revolution.Sketch / Revolution.Axis to reach the profile and
    /// axis model lines after NewRevolution, and NewAlignment between them and a reference plane outside sketch mode
    /// (the same pattern FmcDocSweep uses for path_planes).</para>
    /// </summary>
    public static class FmcDocPlaneLoop
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double Rad(double deg) => deg * Math.PI / 180.0;

        internal sealed class Datum
        {
            public string Name;
            public Reference Ref;
            public XYZ Normal;
            public XYZ Point;
            public ReferencePlane Plane;
        }

        internal static Datum Find(Document doc, string name)
        {
            ReferencePlane rp = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name);
            if (rp != null) return new Datum { Name = name, Ref = rp.GetReference(), Normal = rp.Normal.Normalize(), Point = rp.BubbleEnd, Plane = rp };
            Level lv = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(l => l.Name == name);
            if (lv != null) return new Datum { Name = name, Ref = new Reference(lv), Normal = XYZ.BasisZ, Point = new XYZ(0, 0, lv.Elevation) };
            throw new InvalidOperationException("No reference plane or level " + name);
        }

        internal static List<string[]> Corners(JToken t) =>
            (t as JArray)?.Select(c => ((JArray)c).Select(x => x.ToString()).ToArray()).ToList();

        private static double[] V(XYZ p) => new[] { p.X, p.Y, p.Z };

        private static XYZ Crossing(Datum a, Datum b, Plane s, string what)
        {
            double[] r = FmcPlaneLoopMath.Cross3(V(a.Normal), a.Normal.DotProduct(a.Point), V(b.Normal), b.Normal.DotProduct(b.Point), V(s.Normal), s.Normal.DotProduct(s.Origin));
            if (r == null) throw new InvalidOperationException(what + " don't cross in the sketch plane");
            return new XYZ(r[0], r[1], r[2]);
        }

        internal sealed class Loop
        {
            public List<XYZ> Vertices = new List<XYZ>();
            public List<Line> Lines = new List<Line>();
            public Datum[] Along;
            public CurveArray Curves = new CurveArray();
        }

        /// <summary>The loop's corners where their planes cross the sketch plane, and its edges, each along one plane.</summary>
        internal static Loop Build(Document doc, List<string[]> raw, Plane s, string what)
        {
            var (along, problems) = FmcPlaneLoopMath.Along(raw);
            if (problems.Count > 0) throw new InvalidOperationException(what + ": " + string.Join("; ", problems));
            var c = FmcPlaneLoopMath.Normalize(raw);
            var cache = new Dictionary<string, Datum>();
            Datum D(string n) { if (!cache.TryGetValue(n, out Datum d)) cache[n] = d = Find(doc, n); return d; }
            var loop = new Loop { Along = along.Select(D).ToArray() };
            foreach (Datum d in loop.Along.Distinct())
                if (Math.Abs(d.Normal.DotProduct(s.Normal)) > 1e-6) throw new InvalidOperationException(what + ": " + d.Name + " isn't square to the sketch plane, so an edge can't run along it");
            for (int k = 0; k < c.Count; k++) loop.Vertices.Add(Crossing(D(c[k][0]), D(c[k][1]), s, what + ": corner " + (k + 1) + " [" + string.Join(", ", c[k]) + "]"));
            // some area in the sketch plane: two in-plane axes
            XYZ u = (Math.Abs(s.Normal.Z) > 0.9 ? XYZ.BasisX : XYZ.BasisZ).CrossProduct(s.Normal).Normalize(), w = s.Normal.CrossProduct(u).Normalize();
            if (Math.Abs(FmcPlaneLoopMath.Area2(loop.Vertices.Select(p => new[] { p.DotProduct(u), p.DotProduct(w) }).ToList())) < Mm(1) * Mm(1))
                throw new InvalidOperationException(what + ": the loop encloses no area at the current type's size");
            for (int k = 0; k < c.Count; k++)
            {
                XYZ a = loop.Vertices[k], b = loop.Vertices[(k + 1) % c.Count];
                if (a.DistanceTo(b) < Mm(0.5)) throw new InvalidOperationException(what + ": edge " + (k + 1) + " along " + loop.Along[k].Name + " has no length at the current type's size");
                Line l = Line.CreateBound(a, b);
                loop.Lines.Add(l);
                loop.Curves.Append(l);
            }
            return loop;
        }

        /// <summary>Locks every planar face of the form that lies on the datum (an L or U outline can have two); how many.</summary>
        internal static int LockFaces(Document doc, View view, GenericForm form, Datum d)
        {
            int locked = 0;
            var options = new Options { ComputeReferences = true, View = view, IncludeNonVisibleObjects = true };
            foreach (GeometryObject g in form.get_Geometry(options))
            {
                if (!(g is Autodesk.Revit.DB.Solid solid)) continue;
                foreach (Face f in solid.Faces)
                {
                    if (!(f is PlanarFace pf) || f.Reference == null) continue;
                    if (!pf.FaceNormal.IsAlmostEqualTo(d.Normal) && !pf.FaceNormal.IsAlmostEqualTo(d.Normal.Negate())) continue;
                    if (Math.Abs((pf.Origin - d.Point).DotProduct(d.Normal)) > 1e-6) continue;
                    try
                    {
                        Dimension a = doc.FamilyCreate.NewAlignment(view, d.Ref, f.Reference);
                        a.IsLocked = true;
                        locked++;
                    }
                    catch (Exception) { /* counted as not locked */ }
                }
            }
            return locked;
        }

        /// <summary>outline_planes: after the extrusion exists, its faces on the loop's planes are locked to them.</summary>
        internal static List<string> LockOutline(Document doc, View view, GenericForm made, Loop loop, string name)
        {
            var out_ = new List<string>();
            foreach (Datum d in loop.Along.GroupBy(x => x.Name).Select(g => g.First()))
            {
                int got = LockFaces(doc, view, made, d);
                if (got == 0) throw new InvalidOperationException(name + ": no face lies on " + d.Name + " in " + view.Name + ", so the outline can't follow it (Revit refused the lock)");
                out_.Add(d.Name + (got > 1 ? " ×" + got : ""));
            }
            return out_;
        }

        private static void Align(Document doc, View view, Reference planeRef, Reference curveRef, string what)
        {
            try
            {
                Dimension d = doc.FamilyCreate.NewAlignment(view, planeRef, curveRef);
                d.IsLocked = true;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException(what + " isn't locked: Revit refused the alignment in " + view.Name + " (" + e.Message + ")");
            }
        }

        private static bool Same(Curve c, Line want)
        {
            if (!(c is Line l)) return false;
            XYZ a = l.GetEndPoint(0), b = l.GetEndPoint(1);
            double t = 1e-4;
            return (a.DistanceTo(want.GetEndPoint(0)) < t && b.DistanceTo(want.GetEndPoint(1)) < t)
                || (a.DistanceTo(want.GetEndPoint(1)) < t && b.DistanceTo(want.GetEndPoint(0)) < t);
        }

        /// <summary>revolution with profile_planes and/or axis_planes (G011).</summary>
        public static (string, string) Revolution(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            if (FmcDocGeometry.Solid(doc, name) != null) return ("skip", "exists");
            string ax = (op.Value<string>("axis") ?? "z").ToLowerInvariant();
            var axisAt = (op["axis_at"] as JArray)?.Select(v => v.Value<double>()).ToArray() ?? new[] { 0.0, 0.0 };
            string[] ap = (op["axis_planes"] as JArray)?.Select(x => x.ToString()).ToArray();
            // axis z: the sketch is a front plane (normal y), profile [r, z]; axis y and x: a level plane (normal z)
            XYZ sketchNormal = ax == "z" ? XYZ.BasisY : XYZ.BasisZ;
            XYZ dir = ax == "y" ? XYZ.BasisY.Negate() : ax == "x" ? XYZ.BasisX : XYZ.BasisZ;
            XYZ origin;
            Plane s;
            SketchPlane sketch;
            Datum axisDatum = null, host = null;
            if (ap != null)
            {
                if (ap.Length != 2 || ap[0] == ap[1]) throw new InvalidOperationException(name + ": axis_planes needs two different planes");
                axisDatum = Find(doc, ap[0]);
                host = Find(doc, ap[1]);
                if (host.Normal.CrossProduct(sketchNormal).GetLength() > 1e-6)
                    throw new InvalidOperationException(name + ": " + host.Name + " isn't parallel to the sketch plane of a revolution about the " + ax + " axis (" + (ax == "z" ? "a front/back plane" : "a level plane") + ")");
                if (Math.Abs(axisDatum.Normal.DotProduct(dir)) > 1e-6 || Math.Abs(axisDatum.Normal.DotProduct(sketchNormal)) > 1e-6)
                    throw new InvalidOperationException(name + ": the " + ax + " axis can't run along " + axisDatum.Name + " in " + host.Name);
                s = Plane.CreateByNormalAndOrigin(sketchNormal, host.Point);
                // a point on the axis: where the axis plane, the sketch plane and the plane square to the axis through 0 meet
                double[] r = FmcPlaneLoopMath.Cross3(V(axisDatum.Normal), axisDatum.Normal.DotProduct(axisDatum.Point), V(sketchNormal), sketchNormal.DotProduct(host.Point), V(dir), 0);
                if (r == null) throw new InvalidOperationException(name + ": " + axisDatum.Name + " and " + host.Name + " don't cross");
                origin = new XYZ(r[0], r[1], r[2]);
                sketch = host.Plane != null ? SketchPlane.Create(doc, host.Plane.Id) : SketchPlane.Create(doc, s);
            }
            else
            {
                if (ax == "y") origin = new XYZ(Mm(axisAt[0]), 0, Mm(axisAt[1]));
                else if (ax == "x") origin = new XYZ(0, Mm(axisAt[0]), Mm(axisAt[1]));
                else origin = new XYZ(Mm(axisAt[0]), Mm(axisAt[1]), 0);
                s = Plane.CreateByNormalAndOrigin(sketchNormal, origin);
                sketch = SketchPlane.Create(doc, s);
            }
            Func<double[], XYZ> at;
            if (ax == "y") at = p => origin + new XYZ(Mm(p[0]), -Mm(p[1]), 0);
            else if (ax == "x") at = p => origin + new XYZ(Mm(p[1]), Mm(p[0]), 0);
            else at = p => origin + new XYZ(Mm(p[0]), 0, Mm(p[1]));
            Line axis = Line.CreateBound(origin, origin + dir);
            double a0 = Rad(op.Value<double?>("start_deg") ?? 0), a1 = Rad(op.Value<double?>("end_deg") ?? 360);

            List<string[]> corners = Corners(op["profile_planes"]);
            Loop loop = corners != null ? Build(doc, corners, s, name + " profile_planes") : null;
            if (loop == null && FmcCurves.Count(op["profile"]) < 2) throw new InvalidOperationException(name + ": give profile or profile_planes");
            Autodesk.Revit.DB.Revolution made = FmcCurves.WithFallback(splines =>
            {
                var arr = new CurveArrArray();
                arr.Append(loop != null ? loop.Curves : FmcCurves.Loop(doc, op["profile"], at, true, splines));
                return doc.FamilyCreate.NewRevolution(true, arr, sketch, axis, a0, a1);
            }, loop == null && FmcCurves.HasSplines(op["profile"]));
            FmcDocGeometry.Label(made, name);
            FmcDocLod.ApplySubcategory(doc, made, op);

            // Locks, once the sketch's model lines exist: in the view that looks at the sketch plane.
            doc.Regenerate();
            View view = FmcDocLod.ViewFor(doc, ax == "z" ? "front" : "plan");
            int locks = 0;
            var sketchCurves = made.Sketch == null ? new List<ModelCurve>()
                : made.Sketch.GetAllElements().Select(id => doc.GetElement(id)).OfType<ModelCurve>().ToList();
            if (loop != null)
            {
                if (sketchCurves.Count == 0) throw new InvalidOperationException(name + ": Revit gives no profile lines for the revolution, so the profile can't be locked to its planes");
                for (int k = 0; k < loop.Lines.Count; k++)
                {
                    ModelCurve mc = sketchCurves.FirstOrDefault(c => Same(c.GeometryCurve, loop.Lines[k]))
                        ?? throw new InvalidOperationException(name + ": profile edge " + (k + 1) + " along " + loop.Along[k].Name + " isn't among the revolution's sketch lines, so it can't be locked");
                    Align(doc, view, loop.Along[k].Ref, mc.GeometryCurve.Reference ?? new Reference(mc), name + ": profile edge " + (k + 1) + " along " + loop.Along[k].Name);
                    locks++;
                }
            }
            if (axisDatum != null)
            {
                ModelLine axisLine = made.Axis;
                if (axisLine == null) throw new InvalidOperationException(name + ": Revit gives no axis line for the revolution, so it can't be locked to " + axisDatum.Name);
                Align(doc, view, axisDatum.Ref, axisLine.GeometryCurve.Reference ?? new Reference(axisLine), name + ": the axis on " + axisDatum.Name);
                locks++;
            }
            return ("create", "revolution about the " + ax + " axis" + (ap != null ? " on " + ap[0] + " × " + ap[1] : " at " + axisAt[0] + ", " + axisAt[1])
                + (loop != null ? ", profile on " + string.Join("/", loop.Along.Select(d => d.Name).Distinct()) : "") + ", " + locks + " lock(s)");
        }
    }
}
