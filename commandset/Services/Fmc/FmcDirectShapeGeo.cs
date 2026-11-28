using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    internal sealed class DsPart
    {
        public bool Box;
        public double Ox, Oy, Oz, Sx, Sy, Sz, Height, Rot;
        public List<double[]> Profile = new List<double[]>();
    }

    internal sealed class DsShape
    {
        public int Index;
        public string Name = "", Bic = "", CategoryName = "", Purpose = "other", Mark = "", Level = "";
        public List<DsPart> Parts = new List<DsPart>();
    }

    /// <summary>
    /// fmc_directshape geometry and rules. The server checks all of this first (server/src/fmc/directshape_*.ts); the add-in
    /// checks the document, the category and the numbers again and never trusts the caller. Units in are mm and degrees.
    /// </summary>
    internal static class FmcDirectShapeGeo
    {
        internal const string ApplicationId = "Formcraft.fmc_directshape";
        internal const string DataPrefix = "fmc_directshape|";
        internal const double Mm = 304.8;
        internal const int MaxShapes = 50, MaxParts = 20, MaxVertices = 64;
        internal const double MinMm = 1, MaxSizeMm = 500000, CoordMm = 10000000;

        /// <summary>The most the guard file may enable (mirrors directshape_cats.ts). Walls, floors, doors and the like are not here.</summary>
        private static readonly string[] Universe =
        {
            "OST_GenericModel", "OST_Mass", "OST_Entourage", "OST_Site", "OST_Parking", "OST_Planting", "OST_Furniture",
            "OST_SpecialityEquipment", "OST_Casework", "OST_MechanicalEquipment", "OST_ElectricalEquipment", "OST_PlumbingFixtures",
        };

        internal static readonly Regex RunPattern = new Regex(@"^DS-\d{14}-[0-9a-f]{4}$");

        internal static InvalidOperationException Fail(string code, string message) => new InvalidOperationException("[" + code + "] " + message);

        /// <summary>The whitelist the server sent, kept to the fixed universe. No list means Generic Models and Mass.</summary>
        internal static HashSet<string> Allowed(JObject p)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var rows = p["whitelist"] as JArray;
            var names = rows == null
                ? new List<string> { "OST_GenericModel", "OST_Mass" }
                : rows.OfType<JObject>().Select(o => (o.Value<string>("bic") ?? "").Trim()).ToList();
            foreach (string bic in names)
            {
                if (!Universe.Contains(bic, StringComparer.OrdinalIgnoreCase))
                    throw Fail("FMC-DS-CATEGORY", bic + " is not a category fmc_directshape can make a DirectShape in.");
                set.Add(bic);
            }
            if (set.Count == 0) throw Fail("FMC-DS-CATEGORY", "The category whitelist is empty.");
            return set;
        }

        /// <summary>Documents never written: families, central models, HEBERT HOSTELS and protected paths.</summary>
        internal static void RefuseDocument(Document doc, JObject p)
        {
            if (doc.IsFamilyDocument) throw Fail("FMC-DS-DOC", "fmc_directshape runs on a project model, not a family.");
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw Fail("FMC-DS-DOC", "HEBERT HOSTELS is not written by fmc_directshape.");
            if (FmcPhaseIds.IsCentral(doc)) throw Fail("FMC-DS-DOC", "A central model is not written by fmc_directshape.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(p))) throw Fail("FMC-DS-DOC", "The document is under a protected path.");
        }

        private static double[] Nums(JToken t, int n, string label, bool positive)
        {
            var a = t as JArray;
            if (a == null || a.Count != n || a.Any(x => x.Type != JTokenType.Float && x.Type != JTokenType.Integer))
                throw Fail("FMC-DS-SPEC", label + " must be " + n + " numbers in mm.");
            double[] v = a.Select(x => (double)x).ToArray();
            double limit = positive ? MaxSizeMm : CoordMm;
            if (v.Any(x => double.IsNaN(x) || Math.Abs(x) > limit)) throw Fail("FMC-DS-SPEC", label + " is outside +-" + limit + " mm.");
            if (positive && v.Any(x => x < MinMm)) throw Fail("FMC-DS-SPEC", label + " must be at least " + MinMm + " mm.");
            return v;
        }

        private static DsPart ParsePart(JObject o, int shape)
        {
            string kind = (o.Value<string>("kind") ?? "").Trim().ToLowerInvariant();
            double[] origin = o["origin_mm"] == null ? new double[] { 0, 0, 0 } : Nums(o["origin_mm"], 3, "origin_mm", false);
            var part = new DsPart { Ox = origin[0], Oy = origin[1], Oz = origin[2], Rot = o.Value<double?>("rotation_deg") ?? 0 };
            if (kind == "box")
            {
                double[] size = Nums(o["size_mm"], 3, "size_mm", true);
                part.Box = true; part.Sx = size[0]; part.Sy = size[1]; part.Sz = size[2];
                return part;
            }
            if (kind != "extrusion" && kind != "mass") throw Fail("FMC-DS-SPEC", "shape " + (shape + 1) + ": kind must be box or extrusion.");
            var prof = o["profile_mm"] as JArray;
            if (prof == null || prof.Count < 3 || prof.Count > MaxVertices) throw Fail("FMC-DS-SPEC", "shape " + (shape + 1) + ": profile_mm needs 3 to " + MaxVertices + " vertices.");
            foreach (JToken v in prof)
            {
                double[] xy = Nums(v, 2, "profile_mm", false);
                part.Profile.Add(xy);
            }
            double h = o.Value<double?>("height_mm") ?? 0;
            if (h < MinMm || h > MaxSizeMm) throw Fail("FMC-DS-SPEC", "shape " + (shape + 1) + ": height_mm must be " + MinMm + " to " + MaxSizeMm + " mm.");
            part.Height = h;
            return part;
        }

        /// <summary>The shapes in the request, checked against the whitelist and the limits. Throws on the first problem.</summary>
        internal static List<DsShape> ParseShapes(JObject p, HashSet<string> allowed)
        {
            var rows = (p["shapes"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (rows.Count == 0) throw Fail("FMC-DS-SPEC", "No shapes.");
            if (rows.Count > MaxShapes) throw Fail("FMC-DS-SPEC", rows.Count + " shapes; the most in one call is " + MaxShapes + ".");
            var list = new List<DsShape>();
            for (int i = 0; i < rows.Count; i++)
            {
                JObject r = rows[i];
                string bic = (r.Value<string>("bic") ?? "").Trim();
                if (!allowed.Contains(bic)) throw Fail("FMC-DS-CATEGORY", "shape " + (i + 1) + ": '" + (r.Value<string>("category") ?? bic) + "' is not on the DirectShape whitelist.");
                var shape = new DsShape
                {
                    Index = r.Value<int?>("index") ?? i, Bic = bic, CategoryName = r.Value<string>("category") ?? bic,
                    Name = (r.Value<string>("name") ?? "").Trim(), Purpose = r.Value<string>("purpose") ?? "other",
                    Mark = r.Value<string>("mark") ?? "", Level = (r.Value<string>("level") ?? "").Trim(),
                };
                if (shape.Name.Length == 0) shape.Name = "FMC DirectShape " + (i + 1);
                var parts = (r["parts"] as JArray)?.OfType<JObject>().ToList() ?? new List<JObject>();
                if (parts.Count == 0) parts.Add(r);
                if (parts.Count > MaxParts) throw Fail("FMC-DS-SPEC", "shape " + (i + 1) + ": " + parts.Count + " parts; the most is " + MaxParts + ".");
                foreach (JObject part in parts) shape.Parts.Add(ParsePart(part, i));
                list.Add(shape);
            }
            return list;
        }

        internal static double LevelFeet(Document doc, string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return 0;
            Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .FirstOrDefault(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
            if (level == null) throw Fail("FMC-DS-LEVEL", "No level named '" + name + "'.");
            return level.Elevation;
        }

        /// <summary>One solid: the part's footprint turned about the vertical through its origin, then extruded up.</summary>
        internal static Solid BuildSolid(DsPart part, double zOffsetFeet)
        {
            double t = part.Rot * Math.PI / 180.0, c = Math.Cos(t), s = Math.Sin(t);
            List<double[]> baseLoop = part.Box
                ? new List<double[]> { new[] { -part.Sx / 2, -part.Sy / 2 }, new[] { part.Sx / 2, -part.Sy / 2 }, new[] { part.Sx / 2, part.Sy / 2 }, new[] { -part.Sx / 2, part.Sy / 2 } }
                : new List<double[]>(part.Profile);
            double area = 0;
            for (int i = 0; i < baseLoop.Count; i++)
            {
                double[] a = baseLoop[i], b = baseLoop[(i + 1) % baseLoop.Count];
                area += a[0] * b[1] - b[0] * a[1];
            }
            if (Math.Abs(area) < MinMm * MinMm) throw Fail("FMC-DS-SPEC", "A profile encloses no area.");
            if (area < 0) baseLoop.Reverse();
            var pts = baseLoop.Select(v => new XYZ((part.Ox + v[0] * c - v[1] * s) / Mm, (part.Oy + v[0] * s + v[1] * c) / Mm, part.Oz / Mm + zOffsetFeet)).ToList();
            var loop = new CurveLoop();
            for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
            double height = (part.Box ? part.Sz : part.Height) / Mm;
            return GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop> { loop }, XYZ.BasisZ, height);
        }

        /// <summary>True for a DirectShape this tool made: its ApplicationId and an ApplicationDataId with the tool's prefix.</summary>
        internal static bool IsOurs(Element e)
        {
            var ds = e as DirectShape;
            return ds != null && ds.ApplicationId == ApplicationId && (ds.ApplicationDataId ?? "").StartsWith(DataPrefix, StringComparison.Ordinal);
        }

        internal static string RunOf(DirectShape ds)
        {
            string[] bits = (ds.ApplicationDataId ?? "").Split('|');
            return bits.Length > 1 ? bits[1] : "";
        }

        internal static JObject Row(DirectShape ds)
        {
            string[] bits = (ds.ApplicationDataId ?? "").Split('|');
            return new JObject
            {
                ["id"] = ds.Id.Value, ["unique_id"] = ds.UniqueId, ["name"] = ds.Name, ["category"] = ds.Category?.Name ?? "",
                ["run_id"] = RunOf(ds), ["index"] = bits.Length > 2 ? bits[2] : "", ["application_data_id"] = ds.ApplicationDataId,
                ["comments"] = ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString() ?? "", ["pinned"] = ds.Pinned,
            };
        }

        /// <summary>This tool's shapes, narrowed by of_run and ids. all (or either filter) is how the caller says which.</summary>
        internal static List<DirectShape> Ours(Document doc, JObject p)
        {
            string run = (p.Value<string>("of_run") ?? "").Trim();
            if (run.Length > 0 && !RunPattern.IsMatch(run)) throw Fail("FMC-DS-SELECT", "of_run is not a run_id from create.");
            var ids = new HashSet<string>((p["ids"] as JArray ?? new JArray()).Select(x => x.ToString()));
            return new FilteredElementCollector(doc).OfClass(typeof(DirectShape)).Cast<DirectShape>().Where(IsOurs)
                .Where(ds => run.Length == 0 || RunOf(ds) == run)
                .Where(ds => ids.Count == 0 || ids.Contains(ds.Id.Value.ToString())).ToList();
        }
    }
}
