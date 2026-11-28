using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// G011 (L001 build plan): closed loops of plane crossings for extrusion outline_planes and revolution profile_planes.
    /// Pure (no Revit types), so the console tests in tests/planeloop run without Revit. The server checks the same rules
    /// first (server/src/fmc/ops.ts planeLoopProblems); these are the add-in's own guard for a caller that skips it.
    /// </summary>
    public static class FmcPlaneLoopMath
    {
        /// <summary>The corners with a closing repeat of the first corner dropped (the loop closes by itself).</summary>
        public static List<string[]> Normalize(IList<string[]> corners)
        {
            var c = corners.Select(x => x.ToArray()).ToList();
            if (c.Count > 1 && SamePair(c[0], c[c.Count - 1])) c.RemoveAt(c.Count - 1);
            return c;
        }

        private static bool SamePair(string[] a, string[] b) =>
            a.Length == 2 && b.Length == 2 && a[0] != a[1] && a.All(b.Contains) && b.All(a.Contains);

        /// <summary>
        /// The plane each edge runs along (edge k from corner k to corner k + 1, the last back to the first), and what is
        /// wrong: a corner naming one plane twice, neighbours that don't share exactly one plane, two edges in a row on one
        /// plane, fewer than three corners.
        /// </summary>
        public static (string[] Along, List<string> Problems) Along(IList<string[]> corners)
        {
            var c = Normalize(corners);
            var problems = new List<string>();
            string Label(int k) => "[" + string.Join(", ", c[k]) + "]";
            for (int k = 0; k < c.Count; k++)
                if (c[k].Length != 2) problems.Add("corner " + (k + 1) + " needs two planes");
                else if (c[k][0] == c[k][1]) problems.Add("corner " + (k + 1) + " " + Label(k) + " names one plane twice");
            if (c.Count < 3) { problems.Add("a closed loop needs three corners or more (found " + c.Count + ")"); return (new string[0], problems); }
            var along = new string[c.Count];
            for (int k = 0; k < c.Count; k++)
            {
                int next = (k + 1) % c.Count;
                var shared = c[k].Intersect(c[next]).Distinct().ToList();
                if (shared.Count == 1) along[k] = shared[0];
                else problems.Add("edge " + (k + 1) + " from " + Label(k) + " to " + Label(next) + " doesn't run along one plane: neighbouring corners share exactly one plane");
            }
            for (int k = 0; k < c.Count; k++)
            {
                int next = (k + 1) % c.Count;
                if (along[k] != null && along[k] == along[next])
                    problems.Add("edges " + (k + 1) + " and " + (next + 1) + " both run along " + along[k] + ": drop corner " + (next + 1) + " " + Label(next) + " (it sits in the middle of one edge)");
            }
            return (along, problems);
        }

        /// <summary>
        /// Where three planes meet, each given as n · p = d (n need not be unit length); null when two of them are
        /// parallel (no single point).
        /// </summary>
        public static double[] Cross3(double[] n1, double d1, double[] n2, double d2, double[] n3, double d3)
        {
            double[] c23 = Cross(n2, n3), c31 = Cross(n3, n1), c12 = Cross(n1, n2);
            double det = Dot(n1, c23);
            if (Math.Abs(det) < 1e-9) return null;
            return new[]
            {
                (c23[0] * d1 + c31[0] * d2 + c12[0] * d3) / det,
                (c23[1] * d1 + c31[1] * d2 + c12[1] * d3) / det,
                (c23[2] * d1 + c31[2] * d2 + c12[2] * d3) / det,
            };
        }

        /// <summary>Twice the signed area of a loop of 2D points (positive: counter-clockwise); 0 for a flat loop.</summary>
        public static double Area2(IList<double[]> pts)
        {
            double a = 0;
            for (int i = 0; i < pts.Count; i++) { var p = pts[i]; var q = pts[(i + 1) % pts.Count]; a += p[0] * q[1] - q[0] * p[1]; }
            return a;
        }

        private static double[] Cross(double[] a, double[] b) => new[] { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
        private static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
}
