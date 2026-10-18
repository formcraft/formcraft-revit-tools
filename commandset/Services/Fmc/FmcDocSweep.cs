using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Parametric sweep paths (sweep and void_sweep with path_planes): the owner's standard is "fully parametric, no
    /// mistakes", so a trim, surround or swept frame follows Width, Height and Fanlight Height instead of staying at the
    /// first type's size.
    /// <para>Each corner is where two named reference planes (or a level, such as Ref. Level) cross the path plane. A
    /// segment runs along the one plane its two corners share and is locked to it: aligned when it lies on the plane, a
    /// locked dimension when path_offsets gives mm, a dimension labelled with the parameter when it names one. Each open
    /// end is aligned to its corner's other plane. path_host hosts the path sketch on a reference plane (the face the trim
    /// sits on), so the sweep follows that plane too. A lock Revit won't make fails the op with the planes named: never a
    /// sweep left at fixed coordinates.</para>
    /// <para>To be confirmed in Revit (the retest): Sweep.PathSketch and Sketch.GetAllElements to reach the path's model
    /// curves after NewSweep; NewAlignment between a path line (and a path end point) and a reference plane or a level
    /// (new Reference(level)) outside sketch mode; NewLinearDimension between a plane and a path line, locked or labelled;
    /// SketchPlane.Create on a reference plane's id. Same pattern as symbolic lines on planes in #142 (FmcDocRecipe);
    /// once that is merged, Crossing and Align here fold into its helpers.</para>
    /// </summary>
    public static class FmcDocSweep
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private const double Tol = 1e-6;

        /// <summary>A named reference plane or level: its reference, its normal and a point on it.</summary>
        private sealed class Datum
        {
            public string Name;
            public Reference Ref;
            public XYZ Normal;
            public XYZ Point;
        }

        private static Datum Find(Document doc, string name)
        {
            ReferencePlane rp = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name);
            if (rp != null) return new Datum { Name = name, Ref = rp.GetReference(), Normal = rp.Normal.Normalize(), Point = rp.BubbleEnd };
            Level lv = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(l => l.Name == name);
            if (lv != null) return new Datum { Name = name, Ref = new Reference(lv), Normal = XYZ.BasisZ, Point = new XYZ(0, 0, lv.Elevation) };
            throw new InvalidOperationException("No reference plane or level " + name);
        }

        /// <summary>The view's two in-plane axes: across and up (front: x, z; right: y, z; plan: x, y).</summary>
        private static (XYZ Across, XYZ Up) Axes(string view)
        {
            switch (view)
            {
                case "front": return (XYZ.BasisX, XYZ.BasisZ);
                case "right": return (XYZ.BasisY, XYZ.BasisZ);
                default: return (XYZ.BasisX, XYZ.BasisY);
            }
        }

        /// <summary>Where three planes meet (two datums and the sketch plane), or an error naming the pair.</summary>
        private static XYZ Crossing(XYZ n1, XYZ p1, XYZ n2, XYZ p2, Plane s, string what)
        {
            XYZ n3 = s.Normal;
            double d1 = n1.DotProduct(p1), d2 = n2.DotProduct(p2), d3 = n3.DotProduct(s.Origin);
            XYZ c23 = n2.CrossProduct(n3), c31 = n3.CrossProduct(n1), c12 = n1.CrossProduct(n2);
            double det = n1.DotProduct(c23);
            if (Math.Abs(det) < 1e-9) throw new InvalidOperationException(what + " don't cross in the path plane");
            return (c23 * d1 + c31 * d2 + c12 * d3) / det;
        }

        /// <summary>One segment's offset: mm, or a Length parameter ("-Name" for the other way) at the current type's value.</summary>
        private sealed class Offset
        {
            public double Feet;
            public FamilyParameter Param;
            public bool IsZero => Param == null && Math.Abs(Feet) < Tol;
            public string Text;
        }

        private static Offset ReadOffset(Document doc, JToken t)
        {
            if (t == null || t.Type == JTokenType.Null) return new Offset { Feet = 0, Text = "0" };
            if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) return new Offset { Feet = Mm(t.Value<double>()), Text = t.Value<double>() + " mm" };
            string s = t.ToString().Trim();
            double sign = s.StartsWith("-") ? -1 : 1;
            string name = s.TrimStart('-').Trim();
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter p = fm.get_Parameter(name) ?? throw new InvalidOperationException("No parameter " + name + " (an offset names a Length parameter)");
            if (p.Definition.GetDataType() != SpecTypeId.Length) throw new InvalidOperationException(name + " isn't a Length parameter");
            double v = fm.CurrentType?.AsDouble(p) ?? 0;
            return new Offset { Feet = sign * v, Param = p, Text = s };
        }

        public static (string, string) Make(Document doc, JObject op, bool isVoid)
        {
            string name = op.Value<string>("name");
            string view = op.Value<string>("path_plane") ?? "plan";
            var corners = ((JArray)op["path_planes"]).Select(c => ((JArray)c).Select(x => x.ToString()).ToArray()).ToList();
            if (corners.Count < 2) throw new InvalidOperationException("path_planes needs two corners or more");
            var datums = new Dictionary<string, Datum>();
            Datum D(string n) { if (!datums.TryGetValue(n, out Datum d)) datums[n] = d = Find(doc, n); return d; }
            string Pair(int k) => "[" + string.Join(", ", corners[k]) + "]";

            // The sketch plane: on the host plane (the sweep follows it) or at `at`.
            string hostName = op.Value<string>("path_host");
            Plane free = FmcDocLod.PlaneOf(view, op.Value<double?>("at") ?? 0);
            Plane s;
            SketchPlane sketch;
            if (!string.IsNullOrEmpty(hostName))
            {
                ReferencePlane host = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == hostName)
                    ?? throw new InvalidOperationException("No reference plane " + hostName + " (path_host)");
                if (host.Normal.CrossProduct(free.Normal).GetLength() > 1e-6)
                    throw new InvalidOperationException(hostName + " isn't parallel to the " + view + " path plane");
                s = host.GetPlane();
                sketch = SketchPlane.Create(doc, host.Id);
            }
            else
            {
                s = free;
                sketch = SketchPlane.Create(doc, free);
            }

            // Segments: each runs along the plane its corners share.
            bool closed = corners.Count > 2 && new HashSet<string>(corners[0]).SetEquals(corners[corners.Count - 1]);
            int nSeg = corners.Count - 1;
            var along = new Datum[nSeg];
            for (int k = 0; k < nSeg; k++)
            {
                var shared = corners[k].Intersect(corners[k + 1]).ToList();
                if (shared.Count != 1) throw new InvalidOperationException("segment " + (k + 1) + " from " + Pair(k) + " to " + Pair(k + 1) + " doesn't run along one plane");
                along[k] = D(shared[0]);
                if (Math.Abs(along[k].Normal.DotProduct(s.Normal)) > 1e-6)
                    throw new InvalidOperationException(along[k].Name + " isn't square to the " + view + " path plane, so segment " + (k + 1) + " can't run along it");
            }
            JArray offs = op["path_offsets"] as JArray;
            var offsets = Enumerable.Range(0, nSeg).Select(k => ReadOffset(doc, offs != null && k < offs.Count ? offs[k] : null)).ToArray();

            // Positive offset: +across off a plane that is vertical in the view, +up off one that is horizontal.
            var (acrossAxis, upAxis) = Axes(view);
            XYZ Side(Datum d)
            {
                XYZ n = d.Normal;
                XYZ axis = Math.Abs(n.DotProduct(acrossAxis)) >= Math.Abs(n.DotProduct(upAxis)) ? acrossAxis : upAxis;
                return n.DotProduct(axis) >= 0 ? n : n.Negate();
            }
            // Segment k's line lies on its plane moved by its offset.
            XYZ Shifted(int k) => along[k].Point + Side(along[k]) * offsets[k].Feet;

            // Vertices: where neighbouring segments' (shifted) planes cross; an open end where its segment meets the
            // corner's other plane.
            int nV = closed ? nSeg : nSeg + 1;
            var v = new XYZ[nV];
            for (int i = 0; i < nV; i++)
            {
                int before = i - 1, after = i;
                if (closed && before < 0) before = nSeg - 1;
                if (!closed && after >= nSeg) after = -1;
                if (before >= 0 && after >= 0 && along[before].Name != along[after].Name)
                    v[i] = Crossing(along[before].Normal, Shifted(before), along[after].Normal, Shifted(after), s, along[before].Name + " and " + along[after].Name);
                else
                {
                    int seg = after >= 0 ? after : before;
                    string other = corners[i].First(x => x != along[seg].Name);
                    Datum o = D(other);
                    v[i] = Crossing(along[seg].Normal, Shifted(seg), o.Normal, o.Point, s, Pair(i));
                }
            }

            var curves = new CurveArray();
            var lines = new List<Line>();
            for (int k = 0; k < nSeg; k++)
            {
                XYZ a = v[k], b = v[closed ? (k + 1) % nV : k + 1];
                if (a.DistanceTo(b) < Mm(0.5)) throw new InvalidOperationException("segment " + (k + 1) + " from " + Pair(k) + " to " + Pair(k + 1) + " has no length at the current type's size");
                Line l = Line.CreateBound(a, b);
                lines.Add(l);
                curves.Append(l);
            }

            SweepProfile profile = FmcDocLod.ProfileFor(doc, op, v[0], lines[0].Direction, out string detail);
            Autodesk.Revit.DB.Sweep made = doc.FamilyCreate.NewSweep(!isVoid, curves, sketch, profile, 0, ProfilePlaneLocation.Start);
            FmcDocGeometry.Label(made, name);
            FmcDocLod.ApplySubcategory(doc, made, op);

            // Locks, once the path's model curves exist.
            doc.Regenerate();
            View lockView = FmcDocLod.ViewFor(doc, view);
            var pathCurves = PathCurves(doc, made);
            if (pathCurves.Count == 0) throw new InvalidOperationException(name + ": Revit gives no path curves for the sweep, so the path can't be locked to its planes");
            int locks = 0;
            for (int k = 0; k < nSeg; k++)
            {
                Line want = lines[k];
                ModelCurve mc = pathCurves.FirstOrDefault(c => Same(c.GeometryCurve, want))
                    ?? throw new InvalidOperationException(name + ": segment " + (k + 1) + " (" + Pair(k) + " to " + Pair(k + 1) + ") isn't among the sweep's path curves, so it can't be locked to " + along[k].Name);
                Curve g = mc.GeometryCurve;
                Reference lineRef = g.Reference ?? new Reference(mc);
                string what = name + ": segment " + (k + 1) + " along " + along[k].Name + " (" + Pair(k) + " to " + Pair(k + 1) + ")";
                if (offsets[k].IsZero) Align(doc, lockView, along[k].Ref, lineRef, what);
                else OffsetLock(doc, lockView, along[k], lineRef, g, offsets[k], what);
                locks++;
                if (closed) continue;
                // the open ends: the first segment's start and the last segment's end on their corners' other planes
                for (int end = 0; end < 2; end++)
                {
                    int vi = end == 0 ? k : k + 1;
                    if (!((k == 0 && end == 0) || (k == nSeg - 1 && end == 1))) continue;
                    string otherName = corners[vi].First(x => x != along[k].Name);
                    Datum other = D(otherName);
                    int idx = g.GetEndPoint(0).IsAlmostEqualTo(v[vi]) ? 0 : 1;
                    Align(doc, lockView, other.Ref, g.GetEndPointReference(idx), name + ": the path's " + (vi == 0 ? "start" : "end") + " " + Pair(vi) + " on " + otherName);
                    locks++;
                }
            }
            string hostText = string.IsNullOrEmpty(hostName) ? " at " + (op.Value<double?>("at") ?? 0) + " mm" : " hosted on " + hostName;
            return ("create", (isVoid ? "void sweep, " : "sweep, ") + detail + ", path on " + string.Join("/", corners.SelectMany(c => c).Distinct()) +
                hostText + ", " + locks + " lock(s)" + (offsets.Any(x => !x.IsZero) ? ", offsets " + string.Join(", ", offsets.Select(x => x.Text)) : ""));
        }

        /// <summary>The model curves of a sweep's path sketch.</summary>
        private static List<ModelCurve> PathCurves(Document doc, Autodesk.Revit.DB.Sweep sweep)
        {
            Sketch sk = sweep.PathSketch;
            if (sk == null) return new List<ModelCurve>();
            return sk.GetAllElements().Select(id => doc.GetElement(id)).OfType<ModelCurve>().ToList();
        }

        private static bool Same(Curve c, Line want)
        {
            if (!(c is Line l)) return false;
            XYZ a = l.GetEndPoint(0), b = l.GetEndPoint(1);
            double t = 1e-4;
            return (a.DistanceTo(want.GetEndPoint(0)) < t && b.DistanceTo(want.GetEndPoint(1)) < t)
                || (a.DistanceTo(want.GetEndPoint(1)) < t && b.DistanceTo(want.GetEndPoint(0)) < t);
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

        /// <summary>A dimension from the plane to the path line: locked at the mm offset, or labelled with the parameter.</summary>
        private static void OffsetLock(Document doc, View view, Datum plane, Reference lineRef, Curve line, Offset off, string what)
        {
            try
            {
                XYZ mid = line.Evaluate(0.5, true);
                XYZ n = plane.Normal;
                double dist = (mid - plane.Point).DotProduct(n);
                XYZ foot = mid - n * dist;
                var refs = new ReferenceArray();
                refs.Append(plane.Ref);
                refs.Append(lineRef);
                Dimension dim = doc.FamilyCreate.NewLinearDimension(view, Line.CreateBound(foot, mid), refs);
                if (off.Param != null) dim.FamilyLabel = off.Param;
                else dim.IsLocked = true;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException(what + " isn't held " + off.Text + " off " + plane.Name + ": Revit refused the dimension in " + view.Name + " (" + e.Message + ")");
            }
        }

        // ---- flex follow (Gate A) -----------------------------------------------------------------------------------

        /// <summary>Every named solid's bounding box (null when Revit gives none).</summary>
        internal static Dictionary<string, BoundingBoxXYZ> Boxes(Document doc)
        {
            var out_ = new Dictionary<string, BoundingBoxXYZ>();
            foreach (GenericForm f in new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>())
            {
                string n = FmcDocGeometry.NameOf(f);
                if (n.Length == 0 || out_.ContainsKey(n)) continue;
                BoundingBoxXYZ bb = null;
                try { bb = f.get_BoundingBox(null); } catch (Exception) { /* no box */ }
                out_[n] = bb;
            }
            return out_;
        }

        internal static bool Moved(BoundingBoxXYZ a, BoundingBoxXYZ b) =>
            a.Min.DistanceTo(b.Min) > Mm(0.01) || a.Max.DistanceTo(b.Max) > Mm(0.01);

        internal static string KindOf(Document doc, string name)
        {
            GenericForm f = FmcDocGeometry.Solid(doc, name);
            switch (f)
            {
                case Autodesk.Revit.DB.Sweep _: return f.IsSolid ? "sweep" : "void sweep";
                case Extrusion _: return f.IsSolid ? "extrusion" : "void extrusion";
                case Autodesk.Revit.DB.Revolution _: return "revolution";
                case Autodesk.Revit.DB.Blend _: return "blend";
                default: return f == null ? "" : f.GetType().Name;
            }
        }
    }
}
