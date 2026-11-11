using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The actual bottom and top of a structural column's solid after cuts and joins, and the elements
    /// whose horizontal faces meet those ends. Host coordinates, millimetres. Read-only.
    /// A constraint axis (base level + offset to top level + offset) is not this solid.
    /// </summary>
    public static class FmcColumnEnds
    {
        public static JObject Read(Document doc, Element column, Transform toHost, double searchMm, double touchMm)
        {
            try
            {
                Transform t = toHost ?? Transform.Identity;
                List<XYZ> pts = HostPoints(column, t);
                if (pts.Count == 0)
                    return new JObject
                    {
                        ["available"] = false,
                        ["reason"] = "No solid geometry on this column. A bounding-box centre was not used.",
                    };
                double minZ = pts.Min(p => p.Z), maxZ = pts.Max(p => p.Z);
                XYZ bottom = EndPoint(pts, minZ);
                XYZ top = EndPoint(pts, maxZ);
                var bottomBox = Footprint(pts, minZ);
                var topBox = Footprint(pts, maxZ);
                return new JObject
                {
                    ["available"] = true,
                    ["source"] = "instance_geometry_after_cuts_and_joins",
                    ["bottom_mm"] = P(bottom),
                    ["top_mm"] = P(top),
                    ["bottom_z_mm"] = Mm(minZ),
                    ["top_z_mm"] = Mm(maxZ),
                    ["note"] = "bottom_mm and top_mm are the solid after cuts and joins, in host coordinates. start_mm and end_mm on the column stay the constraint axis or location curve. A bounding-box centre is not used.",
                    ["bottom"] = new JObject { ["point_mm"] = P(bottom), ["contacts"] = Contacts(doc, column, t, bottomBox, minZ, true, searchMm, touchMm) },
                    ["top"] = new JObject { ["point_mm"] = P(top), ["contacts"] = Contacts(doc, column, t, topBox, maxZ, false, searchMm, touchMm) },
                };
            }
            catch (Exception ex)
            {
                return new JObject { ["available"] = false, ["reason"] = ex.Message };
            }
        }

        /// <summary>Instance solids, with cuts and joins, in model coordinates. Symbol geometry is not used.</summary>
        public static List<Solid> Solids(Element e)
        {
            var solids = new List<Solid>();
            if (e == null) return solids;
            GeometryElement geo;
            try
            {
                geo = e.get_Geometry(new Options
                {
                    ComputeReferences = false,
                    IncludeNonVisibleObjects = false,
                    DetailLevel = ViewDetailLevel.Fine,
                });
            }
            catch (Exception) { return solids; }
            if (geo != null) Collect(geo, solids);
            return solids;
        }

        private static void Collect(GeometryElement geo, List<Solid> solids)
        {
            foreach (GeometryObject o in geo)
            {
                if (o is Solid s && s.Volume > 1e-9) solids.Add(s);
                else if (o is GeometryInstance gi)
                {
                    GeometryElement inst = null;
                    try { inst = gi.GetInstanceGeometry(); } catch (Exception) { inst = null; }
                    if (inst != null) Collect(inst, solids);
                }
            }
        }

        private static List<XYZ> HostPoints(Element e, Transform t)
        {
            var pts = new List<XYZ>();
            foreach (Solid s in Solids(e))
                foreach (Face f in s.Faces)
                    foreach (EdgeArray loop in f.EdgeLoops)
                        foreach (Edge edge in loop)
                            foreach (XYZ p in edge.Tessellate())
                                pts.Add(t.OfPoint(p));
            return pts;
        }

        private static XYZ EndPoint(List<XYZ> pts, double z)
        {
            double band = 2.0 / 304.8;
            var sel = pts.Where(p => Math.Abs(p.Z - z) <= band).ToList();
            if (sel.Count == 0) sel = new List<XYZ> { pts.OrderBy(p => Math.Abs(p.Z - z)).First() };
            return new XYZ(sel.Average(p => p.X), sel.Average(p => p.Y), sel.Average(p => p.Z));
        }

        private static double[] Footprint(List<XYZ> pts, double z)
        {
            double band = 5.0 / 304.8;
            var sel = pts.Where(p => Math.Abs(p.Z - z) <= band).ToList();
            if (sel.Count == 0) sel = pts;
            return new[] { sel.Min(p => p.X), sel.Min(p => p.Y), sel.Max(p => p.X), sel.Max(p => p.Y) };
        }

        private static JArray Contacts(Document doc, Element column, Transform t, double[] foot, double endZ, bool bottom, double searchMm, double touchMm)
        {
            var list = new JArray();
            if (foot == null) return list;
            double pad = Math.Max(searchMm, 50) / 304.8;
            BoundingBoxXYZ bb = column.get_BoundingBox(null);
            if (bb == null) return list;
            var outline = new Outline(bb.Min - new XYZ(pad, pad, pad), bb.Max + new XYZ(pad, pad, pad));
            if (outline.IsEmpty) return list;
            var cats = new List<ElementId>
            {
                new ElementId((long)BuiltInCategory.OST_StructuralFoundation),
                new ElementId((long)BuiltInCategory.OST_StructuralFraming),
                new ElementId((long)BuiltInCategory.OST_Floors),
                new ElementId((long)BuiltInCategory.OST_Walls),
                new ElementId((long)BuiltInCategory.OST_StructuralColumns),
            };
            IList<Element> near;
            try
            {
                near = new FilteredElementCollector(doc)
                    .WhereElementIsNotElementType()
                    .WherePasses(new LogicalAndFilter(new ElementMulticategoryFilter(cats), new BoundingBoxIntersectsFilter(outline)))
                    .ToElements();
            }
            catch (Exception) { return list; }
            double slack = 10.0 / 304.8;
            foreach (Element other in near)
            {
                if (other.Id == column.Id) continue;
                JObject hit = null;
                try { hit = ClosestFace(other, t, foot, endZ, bottom, searchMm, touchMm, slack); }
                catch (Exception) { hit = null; }
                if (hit != null) list.Add(hit);
            }
            var ordered = list.OfType<JObject>().OrderBy(o => Math.Abs(o.Value<double?>("gap_mm") ?? 1e9)).Take(12).ToList();
            var arr = new JArray();
            foreach (JObject o in ordered) arr.Add(o);
            return arr;
        }

        private static JObject ClosestFace(Element other, Transform t, double[] foot, double endZ, bool bottom, double searchMm, double touchMm, double slack)
        {
            JObject best = null;
            double bestAbs = double.MaxValue;
            foreach (Solid s in Solids(other))
            {
                foreach (Face face in s.Faces)
                {
                    if (!(face is PlanarFace pf)) continue;
                    XYZ normal = t.OfVector(pf.FaceNormal);
                    if (normal.GetLength() < 1e-9 || Math.Abs(normal.Normalize().Z) < 0.85) continue;
                    var pts = new List<XYZ>();
                    foreach (EdgeArray loop in pf.EdgeLoops)
                        foreach (Edge edge in loop)
                            foreach (XYZ p in edge.Tessellate())
                                pts.Add(t.OfPoint(p));
                    if (pts.Count == 0) continue;
                    double minX = pts.Min(p => p.X), minY = pts.Min(p => p.Y), maxX = pts.Max(p => p.X), maxY = pts.Max(p => p.Y);
                    if (maxX < foot[0] - slack || minX > foot[2] + slack || maxY < foot[1] - slack || minY > foot[3] + slack) continue;
                    double faceZ = t.OfPoint(pf.Origin).Z;
                    double gapMm = bottom ? Mm(endZ - faceZ) : Mm(faceZ - endZ);
                    if (Math.Abs(gapMm) > searchMm) continue;
                    if (Math.Abs(gapMm) >= bestAbs) continue;
                    bestAbs = Math.Abs(gapMm);
                    string relation = Math.Abs(gapMm) <= touchMm ? "touch" : gapMm > 0 ? "gap" : "overlap";
                    best = new JObject
                    {
                        ["id"] = other.Id.Value,
                        ["category"] = other.Category?.Name ?? "",
                        ["class"] = other.GetType().Name,
                        ["gap_mm"] = gapMm,
                        ["relation"] = relation,
                        ["face_z_mm"] = Mm(faceZ),
                        ["end"] = bottom ? "bottom" : "top",
                    };
                }
            }
            return best;
        }

        private static double Mm(double ft) => Math.Round(ft * 304.8, 1);

        private static JArray P(XYZ p) => new JArray(Mm(p.X), Mm(p.Y), Mm(p.Z));
    }
}
