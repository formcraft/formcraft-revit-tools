using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_area_check: the model's facts for a planning check, in metres and square metres. Read only: no transaction, nothing
    /// is created, set or changed. Areas, rooms and floors are each summed by level (the server picks the source and does the
    /// arithmetic against the planning values, so every number and every limit is judged in one tested place); the outlines of
    /// the footprint level, the property-line curves, any named areas and the Parking-category elements are returned as facts.
    /// Nothing here knows a planning value.
    /// </summary>
    public static class FmcAreaFacts
    {
        private const double FtToM = 0.3048;
        private const double Ft2ToM2 = 0.09290304;
        public const int IdCap = 50;
        public const int ParkingIdCap = 200;
        public const int PointCap = 3000;

        private sealed class Row
        {
            public Element El;
            public double Ft2;
            public Level Lvl;
            public Func<List<List<double[]>>> Loops;
        }

        public static JObject Collect(Document doc, string schemeName, string footprintLevel, string plotAreaName, ISet<long> lineIds)
        {
            var schemes = new FilteredElementCollector(doc).OfClass(typeof(AreaScheme)).Cast<AreaScheme>().ToList();
            var result = new JObject
            {
                ["document"] = doc.Title,
                ["area_schemes"] = new JArray(schemes.Select(s => s.Name)),
                ["model_changed"] = false
            };
            var sources = new JObject();
            sources["areas"] = AreasSource(doc, schemes, schemeName, footprintLevel);
            sources["rooms"] = Source(doc, "rooms", RoomRows(doc), footprintLevel, null);
            sources["floors"] = Source(doc, "floors", FloorRows(doc), footprintLevel, null);
            result["sources"] = sources;
            result["named_areas"] = NamedAreas(doc, plotAreaName);
            result["property_lines"] = PropertyLines(doc, lineIds);
            result["parking"] = Parking(doc);
            return result;
        }

        // ------------------------------------------------------------ the three sources

        private static JObject AreasSource(Document doc, List<AreaScheme> schemes, string schemeName, string footprintLevel)
        {
            AreaScheme scheme = null;
            string problem = "";
            if (schemes.Count == 0) problem = "The model has no area schemes (no Area Plans).";
            else if (!string.IsNullOrWhiteSpace(schemeName))
            {
                scheme = schemes.FirstOrDefault(s => string.Equals(s.Name, schemeName.Trim(), StringComparison.OrdinalIgnoreCase));
                if (scheme == null) problem = $"No area scheme is named \"{schemeName}\". Schemes: {string.Join("; ", schemes.Select(s => s.Name))}.";
            }
            else if (schemes.Count == 1) scheme = schemes[0];
            else
            {
                scheme = schemes.FirstOrDefault(s => string.Equals(s.Name, "Gross Building", StringComparison.OrdinalIgnoreCase));
                if (scheme == null) problem = $"There are several area schemes and none is named Gross Building: pass area_scheme. Schemes: {string.Join("; ", schemes.Select(s => s.Name))}.";
            }
            if (scheme == null) return new JObject { ["available"] = false, ["problem"] = problem };
            var rows = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Areas).WhereElementIsNotElementType().OfType<Area>()
                .Where(a => a.AreaScheme != null && a.AreaScheme.Id == scheme.Id)
                .Select(a => new Row { El = a, Ft2 = a.Area, Lvl = a.Level, Loops = () => Loops(a) });
            return Source(doc, "areas", rows, footprintLevel, scheme.Name);
        }

        private static IEnumerable<Row> RoomRows(Document doc)
        {
            return new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().OfType<Autodesk.Revit.DB.Architecture.Room>()
                .Select(r => new Row { El = r, Ft2 = r.Area, Lvl = r.Level, Loops = () => Loops(r) });
        }

        private static IEnumerable<Row> FloorRows(Document doc)
        {
            return new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Floors).WhereElementIsNotElementType().OfClass(typeof(Floor)).Cast<Floor>()
                .Select(f => new Row
                {
                    El = f,
                    Ft2 = f.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED)?.AsDouble() ?? 0,
                    Lvl = doc.GetElement(f.LevelId) as Level,
                    Loops = () => FloorLoops(f)
                });
        }

        private static JObject Source(Document doc, string name, IEnumerable<Row> rows, string footprintLevel, string scheme)
        {
            var counted = new List<Row>();
            var skipped = new JArray();
            int skippedTotal = 0;
            foreach (Row r in rows)
            {
                // an unplaced or not enclosed area/room has no area; a floor with no computed area is likewise left out and listed
                if (r.Ft2 > 1e-9 && (name == "floors" || r.El.Location != null)) counted.Add(r);
                else { skippedTotal++; if (skipped.Count < IdCap) skipped.Add(r.El.Id.Value.ToString()); }
            }
            var levels = new JArray();
            var groups = counted.GroupBy(r => r.Lvl == null ? -1 : r.Lvl.Id.Value).Select(g => new { g, lvl = g.First().Lvl })
                .OrderBy(x => x.lvl == null ? double.MaxValue : x.lvl.Elevation).ToList();
            foreach (var x in groups)
                levels.Add(new JObject
                {
                    ["level"] = x.lvl?.Name ?? "(no level)",
                    ["level_id"] = x.lvl == null ? "" : x.lvl.Id.Value.ToString(),
                    ["elevation_m"] = x.lvl == null ? JValue.CreateNull() : (JToken)Math.Round(x.lvl.Elevation * FtToM, 3),
                    ["area_m2"] = Math.Round(x.g.Sum(r => r.Ft2) * Ft2ToM2, 3),
                    ["count"] = x.g.Count(),
                    ["element_ids"] = new JArray(x.g.Take(IdCap).Select(r => r.El.Id.Value.ToString())),
                    ["ids_truncated"] = x.g.Count() > IdCap
                });
            var src = new JObject
            {
                ["available"] = counted.Count > 0,
                ["levels"] = levels,
                ["total_m2"] = Math.Round(counted.Sum(r => r.Ft2) * Ft2ToM2, 3),
                ["count"] = counted.Count,
                ["skipped_count"] = skippedTotal,
                ["skipped_ids"] = skipped
            };
            if (scheme != null) src["scheme"] = scheme;
            if (counted.Count == 0) { src["problem"] = $"No {name} with an area" + (scheme == null ? "" : $" in the scheme \"{scheme}\"") + "."; return src; }

            // the footprint level: the level asked for, else the lowest level that has any of this source
            var pick = !string.IsNullOrWhiteSpace(footprintLevel)
                ? groups.FirstOrDefault(x => x.lvl != null && string.Equals(x.lvl.Name, footprintLevel.Trim(), StringComparison.OrdinalIgnoreCase))
                : groups.FirstOrDefault(x => x.lvl != null);
            if (pick == null)
            {
                src["footprint"] = new JObject { ["found"] = false, ["problem"] = string.IsNullOrWhiteSpace(footprintLevel) ? "No row of this source has a level." : $"No {name} on a level named \"{footprintLevel}\"." };
                return src;
            }
            var loops = new JArray();
            int points = 0; bool truncated = false; string loopProblem = "";
            foreach (Row r in pick.g)
            {
                List<List<double[]>> ls;
                try { ls = r.Loops(); }
                catch (Exception e) { loopProblem = e.GetType().Name + ": " + e.Message; continue; }
                foreach (List<double[]> l in ls)
                {
                    if (points + l.Count > PointCap) { truncated = true; continue; }
                    points += l.Count;
                    loops.Add(new JObject { ["element_id"] = r.El.Id.Value.ToString(), ["points"] = new JArray(l.Select(p => new JArray(p[0], p[1]))) });
                }
            }
            src["footprint"] = new JObject
            {
                ["found"] = true,
                ["level"] = pick.lvl.Name,
                ["level_id"] = pick.lvl.Id.Value.ToString(),
                ["area_m2"] = Math.Round(pick.g.Sum(r => r.Ft2) * Ft2ToM2, 3),
                ["loops"] = loops,
                ["outline_truncated"] = truncated,
                ["outline_problem"] = loopProblem
            };
            return src;
        }

        // ------------------------------------------------------------ outlines

        private static double[] P(XYZ p) { return new[] { Math.Round(p.X * FtToM, 4), Math.Round(p.Y * FtToM, 4) }; }

        private static List<List<double[]>> Loops(SpatialElement e)
        {
            var result = new List<List<double[]>>();
            IList<IList<BoundarySegment>> loops = e.GetBoundarySegments(new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish });
            if (loops == null) return result;
            foreach (IList<BoundarySegment> loop in loops)
            {
                var pts = new List<double[]>();
                foreach (BoundarySegment seg in loop)
                {
                    Curve c = seg.GetCurve();
                    if (c == null) continue;
                    foreach (XYZ p in c.Tessellate()) pts.Add(P(p));
                }
                if (pts.Count > 0) result.Add(pts);
            }
            return result;
        }

        private static List<List<double[]>> FloorLoops(Floor f)
        {
            var result = new List<List<double[]>>();
            foreach (Reference r in HostObjectUtils.GetTopFaces(f))
            {
                PlanarFace face = f.GetGeometryObjectFromReference(r) as PlanarFace;
                if (face == null) continue;
                foreach (CurveLoop cl in face.GetEdgesAsCurveLoops())
                {
                    var pts = new List<double[]>();
                    foreach (Curve c in cl) foreach (XYZ p in c.Tessellate()) pts.Add(P(p));
                    if (pts.Count > 0) result.Add(pts);
                }
            }
            return result;
        }

        // ------------------------------------------------------------ named areas, property lines, parking

        private static JArray NamedAreas(Document doc, string name)
        {
            var rows = new JArray();
            if (string.IsNullOrWhiteSpace(name)) return rows;
            foreach (Area a in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Areas).WhereElementIsNotElementType().OfType<Area>())
            {
                if (!string.Equals((a.Name ?? "").Trim(), name.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
                rows.Add(new JObject
                {
                    ["id"] = a.Id.Value.ToString(), ["name"] = a.Name ?? "", ["scheme"] = a.AreaScheme?.Name ?? "",
                    ["level"] = a.Level?.Name ?? "", ["placed"] = a.Location != null, ["area_m2"] = Math.Round(a.Area * Ft2ToM2, 3)
                });
            }
            return rows;
        }

        private static JObject PropertyLines(Document doc, ISet<long> only)
        {
            var elements = new JArray();
            var lines = new JArray();
            int n = 0, points = 0; bool truncated = false;
            foreach (Element e in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_SiteProperty).WhereElementIsNotElementType())
            {
                if (only != null && only.Count > 0 && !only.Contains(e.Id.Value)) continue;
                var curves = new List<Curve>();
                try { Gather(e.get_Geometry(new Options { ComputeReferences = false }), curves, 0); } catch (Exception) { }
                if (curves.Count == 0 && e.Location is LocationCurve lc && lc.Curve != null) curves.Add(lc.Curve);
                elements.Add(new JObject { ["id"] = e.Id.Value.ToString(), ["name"] = e.Name ?? "", ["curves"] = curves.Count });
                foreach (Curve c in curves)
                {
                    IList<XYZ> t = c.Tessellate();
                    n++;
                    if (points + t.Count > PointCap) { truncated = true; continue; }
                    points += t.Count;
                    lines.Add(new JObject { ["n"] = n, ["element_id"] = e.Id.Value.ToString(), ["curved"] = t.Count > 2, ["points"] = new JArray(t.Select(p => { double[] q = P(p); return new JArray(q[0], q[1]); })) });
                }
            }
            return new JObject { ["elements"] = elements, ["lines"] = lines, ["truncated"] = truncated };
        }

        private static void Gather(GeometryElement ge, List<Curve> into, int depth)
        {
            if (ge == null || depth > 3) return;
            foreach (GeometryObject go in ge)
            {
                if (go is Curve c) into.Add(c);
                else if (go is PolyLine pl)
                {
                    IList<XYZ> pts = pl.GetCoordinates();
                    for (int i = 0; i + 1 < pts.Count; i++) into.Add(Line.CreateBound(pts[i], pts[i + 1]));
                }
                else if (go is GeometryInstance gi) Gather(gi.GetInstanceGeometry(), into, depth + 1);
            }
        }

        private static JObject Parking(Document doc)
        {
            var items = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Parking).WhereElementIsNotElementType().ToList();
            var byType = new Dictionary<string, int>();
            foreach (Element e in items)
            {
                string type = (e as FamilyInstance)?.Symbol is FamilySymbol s ? s.FamilyName + " : " + s.Name : (doc.GetElement(e.GetTypeId())?.Name ?? e.GetType().Name);
                byType[type] = byType.TryGetValue(type, out int k) ? k + 1 : 1;
            }
            return new JObject
            {
                ["count"] = items.Count,
                ["by_type"] = new JArray(byType.OrderByDescending(x => x.Value).Select(x => new JObject { ["type"] = x.Key, ["count"] = x.Value })),
                ["element_ids"] = new JArray(items.Take(ParkingIdCap).Select(e => e.Id.Value.ToString())),
                ["ids_truncated"] = items.Count > ParkingIdCap
            };
        }
    }
}
