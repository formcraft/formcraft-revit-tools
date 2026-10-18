using System;
using System.Collections.Generic;
using System.Linq;
using Rhino.Geometry;

namespace Formcraft.Rhino
{
    /// <summary>
    /// A polyline back into the curve it was sampled from. Recipes draw an arc or a rounded corner as a run of short
    /// segments (6 per quarter, 12 per circle); Revit keeps them faceted. Here each run of short segments that turn
    /// gently becomes one smooth curve through the same points, tangent to the straight segments it meets, while
    /// long segments stay straight and sharp corners (chamfers, steps) stay sharp. The points themselves never move.
    /// </summary>
    public static class RhinoFit
    {
        /// <summary>A segment shorter than this share of the longest one can be part of an arc.</summary>
        const double ShortShare = 0.3;
        /// <summary>A vertex that turns more than this is a corner, never smoothed.</summary>
        const double CornerDeg = 50;

        public static Curve Fit(IList<Point3d> input, bool closed)
        {
            var pts = Dedupe(input, closed);
            int n = pts.Count;
            if (n < 2) throw new ArgumentException("a curve needs two points or more");
            if (n == 2) return new LineCurve(pts[0], pts[1]);
            int m = closed ? n : n - 1;                       // segments: i runs from pts[i] to pts[(i + 1) % n]
            var len = Enumerable.Range(0, m).Select(i => pts[i].DistanceTo(pts[(i + 1) % n])).ToArray();
            double maxLen = len.Max();
            bool Short(int i) => len[i] < ShortShare * maxLen;
            // the turn at vertex v, between segment v-1 and segment v
            double Turn(int v)
            {
                if (!closed && (v <= 0 || v >= n - 1)) return 180;
                Vector3d a = pts[v] - pts[(v - 1 + n) % n], b = pts[(v + 1) % n] - pts[v];
                return Vector3d.VectorAngle(a, b) * 180 / Math.PI;
            }
            bool Smooth(int v) => Turn(v) < CornerDeg;

            // no corner and no long straight (segments within 3× of each other): a closed loop is one periodic curve
            // (a circle, an oval); a rounded rectangle has long sides, so it keeps them straight below
            if (closed && Enumerable.Range(0, n).All(Smooth) && maxLen < 3 * len.Min())
                return Curve.CreateInterpolatedCurve(pts.Concat(new[] { pts[0] }), 3, CurveKnotStyle.ChordPeriodic);

            // a closed loop starts at a corner, or at the start of a long segment, so no run wraps around the start
            int start = 0;
            if (closed)
            {
                start = Enumerable.Range(0, n).FirstOrDefault(v => !Smooth(v) || !Short((v - 1 + m) % m) || !Short(v));
                pts = pts.Skip(start).Concat(pts.Take(start)).ToList();
                len = len.Skip(start).Concat(len.Take(start)).ToArray();
            }

            var pieces = new List<Curve>();
            int s = 0;
            while (s < m)
            {
                // a run: two or more short segments in a row, with smooth vertices between them
                int e = s;
                if (Short(s))
                    while (e + 1 < m && Short(e + 1) && SmoothAt(e + 1)) e++;
                if (e > s)
                {
                    var runPts = Enumerable.Range(s, e - s + 2).Select(k => pts[k % n]).ToList();
                    Vector3d t0 = Vector3d.Unset, t1 = Vector3d.Unset;
                    if ((closed || s > 0) && !Short((s - 1 + m) % m) && SmoothAt(s)) { t0 = pts[s] - pts[(s - 1 + n) % n]; t0.Unitize(); }
                    if ((closed || e + 1 < m) && !Short((e + 1) % m) && SmoothAt((e + 1) % n)) { t1 = pts[(e + 2) % n] - pts[(e + 1) % n]; t1.Unitize(); }
                    pieces.Add(Curve.CreateInterpolatedCurve(runPts, 3, CurveKnotStyle.Chord, t0, t1));
                    s = e + 1;
                }
                else
                {
                    pieces.Add(new LineCurve(pts[s], pts[(s + 1) % n]));
                    s++;
                }
            }
            Curve[] joined = Curve.JoinCurves(pieces, RhinoParts.Tol);
            if (joined == null || joined.Length != 1) return closed ? (Curve)new PolylineCurve(pts.Concat(new[] { pts[0] })) : new PolylineCurve(pts);
            return joined[0];

            // smoothness at a vertex of the rotated list
            bool SmoothAt(int v)
            {
                if (!closed && (v <= 0 || v >= n - 1)) return false;
                Vector3d a = pts[v % n] - pts[(v - 1 + n) % n], b = pts[(v + 1) % n] - pts[v % n];
                return Vector3d.VectorAngle(a, b) * 180 / Math.PI < CornerDeg;
            }
        }

        /// <summary>A closed outline of points is round when every point is the same distance from their centre (±2%).</summary>
        public static bool IsRound(IList<Point3d> pts, out Point3d centre, out double radius)
        {
            centre = new Point3d(pts.Average(p => p.X), pts.Average(p => p.Y), pts.Average(p => p.Z));
            Point3d c = centre;
            var r = pts.Select(p => p.DistanceTo(c)).ToList();
            radius = r.Max();
            return pts.Count >= 8 && r.Max() - r.Min() < 0.02 * r.Max();
        }

        static List<Point3d> Dedupe(IList<Point3d> input, bool closed)
        {
            var pts = new List<Point3d>();
            foreach (Point3d p in input) if (pts.Count == 0 || pts[pts.Count - 1].DistanceTo(p) > RhinoParts.Tol) pts.Add(p);
            if (closed && pts.Count > 2 && pts[0].DistanceTo(pts[pts.Count - 1]) <= RhinoParts.Tol) pts.RemoveAt(pts.Count - 1);
            return pts;
        }
    }
}
