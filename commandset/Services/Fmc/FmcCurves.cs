using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Outlines with curves (owner 26 Oct: picture-to-family builds with simple and complex curves kept failing; the same
    /// nodes as server/src/fmc/curves.ts). A node is [x, y] (a straight line to it), { to, through } (a 3-point arc) or
    /// { to, spline: [[x, y], ...] } (a smooth curve through those points). Pieces shorter than Revit's short-curve
    /// tolerance are skipped instead of failing the form; an arc whose points are in line becomes a line. When Revit
    /// refuses a spline in a form, the caller builds again with splines as short straight pieces (Loop splines false).
    /// </summary>
    public static class FmcCurves
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);

        private sealed class Node { public double[] To; public double[] Through; public List<double[]> Spline; }

        private static double[] P(JToken t) => ((JArray)t).Select(v => v.Value<double>()).ToArray();

        private static List<Node> Nodes(JToken t) =>
            (t as JArray ?? new JArray()).Select(x => x is JObject o
                ? new Node { To = P(o["to"]), Through = o["through"] != null ? P(o["through"]) : null, Spline = (o["spline"] as JArray)?.Select(P).ToList() }
                : new Node { To = P(x) }).ToList();

        /// <summary>Whether an outline has splines (so a refused form can be retried without them).</summary>
        public static bool HasSplines(JToken t) => Nodes(t).Any(n => n.Spline != null && n.Spline.Count > 0);

        /// <summary>The number of nodes (the outline's points).</summary>
        public static int Count(JToken t) => Nodes(t).Count;

        /// <summary>A closed (or open) outline as Revit curves, each node mapped from its mm coordinates by map.</summary>
        public static CurveArray Loop(Document doc, JToken t, Func<double[], XYZ> map, bool closed = true, bool splines = true)
        {
            var nodes = Nodes(t);
            if (nodes.Count < 2) throw new InvalidOperationException("an outline needs at least two nodes (three points, or a curve)");
            double shortest = doc.Application.ShortCurveTolerance;
            var arr = new CurveArray();
            int first = closed ? 0 : 1;
            for (int k = first; k < nodes.Count; k++)
            {
                Node node = nodes[k];
                XYZ from = map(nodes[(k - 1 + nodes.Count) % nodes.Count].To), to = map(node.To);
                if (from.DistanceTo(to) < shortest) continue;
                if (node.Through != null)
                {
                    XYZ m = map(node.Through);
                    try { arr.Append(Arc.Create(from, to, m)); continue; }
                    catch (Exception) { /* the three points are in line: a straight piece */ }
                }
                if (node.Spline != null && node.Spline.Count > 0)
                {
                    var pts = new List<XYZ> { from };
                    foreach (var p in node.Spline.Select(map)) if (p.DistanceTo(pts[pts.Count - 1]) >= shortest) pts.Add(p);
                    if (to.DistanceTo(pts[pts.Count - 1]) < shortest) pts.RemoveAt(pts.Count - 1);
                    pts.Add(to);
                    if (splines && pts.Count >= 3) { arr.Append(HermiteSpline.Create(pts, false)); continue; }
                    for (int i = 0; i + 1 < pts.Count; i++) arr.Append(Line.CreateBound(pts[i], pts[i + 1]));
                    continue;
                }
                arr.Append(Line.CreateBound(from, to));
            }
            if (arr.Size < (closed ? 2 : 1)) throw new InvalidOperationException("the outline collapses: its points are closer than Revit's shortest curve");
            return arr;
        }

        /// <summary>Runs make with splines, and again without them when Revit refuses the splines.</summary>
        public static T WithFallback<T>(Func<bool, T> make, bool hasSplines)
        {
            if (!hasSplines) return make(false);
            try { return make(true); }
            catch (Exception) { return make(false); }
        }
    }
}
