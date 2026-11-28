using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Read-only clash scan. Ids are collected, then boxes for one chunk at a time.
    /// Solids are built only for a box hit when exact is true, and are not kept.
    /// Hits are appended to a JSONL file. The peak working set is the Revit process.
    /// </summary>
    public class FmcClashHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft clash scan";

        private sealed class Ref
        {
            public long Id;
            public string Link;
            public Document Doc;
            public Transform ToHost;
        }

        private sealed class Box
        {
            public long Id;
            public string Link;
            public XYZ Min;
            public XYZ Max;
            public Transform ToHost;
            public Document Doc;
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string mode = (Parameters.Value<string>("mode") ?? "scan").Trim();
                    if (string.Equals(mode, "export_cache", StringComparison.OrdinalIgnoreCase))
                    {
                        ExportCache(doc);
                        return;
                    }
                    string source = Parameters.Value<string>("source") ?? "";
                    if (string.Equals(mode, "sleeves", StringComparison.OrdinalIgnoreCase))
                    {
                        Sleeves(doc);
                        return;
                    }
                    if (source.StartsWith("cache:", StringComparison.OrdinalIgnoreCase))
                    {
                        ScanAgainstCache(doc, source.Substring("cache:".Length).Trim());
                        return;
                    }
                    int chunk = Parameters.Value<int?>("chunk") ?? 250;
                    if (chunk < 1) chunk = 1;
                    if (chunk > 2000) chunk = 2000;
                    double tolerance = (Parameters.Value<double?>("tolerance_mm") ?? 0) / FeetToMm;
                    bool exact = Parameters.Value<bool?>("exact") == true;
                    bool links = Parameters.Value<bool?>("include_links") != false;
                    int maxHits = Parameters.Value<int?>("max_hits") ?? 5000;
                    long peak = WorkingSet();
                    var skipped = new JArray();
                    var linkNames = new JArray();
                    var byPair = new Dictionary<string, int>();
                    int compared = 0;
                    int chunks = 0;
                    int count = 0;
                    var sample = new JArray();
                    string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Formcraft", "clash");
                    Directory.CreateDirectory(folder);
                    string file = UniqueReport(folder, "clash-", doc.Title);
                    int perPair = Math.Max(0, Parameters.Value<int?>("max_hits_per_pair") ?? 0);
                    var cappedPairs = new JArray();
                    int pairsTotal = 0;
                    int pairsDone = 0;
                    using (var writer = new StreamWriter(file, false))
                    {
                        JArray pairTokens = Parameters["pairs"] as JArray ?? new JArray();
                        if (pairTokens.Count == 0) pairTokens = DefaultPairs();
                        bool centreline = Parameters.Value<bool?>("centreline") == true;
                        double clearance = (Parameters.Value<double?>("clearance_mm") ?? 0) / FeetToMm;
                        List<OpeningInfo> openings = LoadOpenings(doc);
                        pairsTotal = pairTokens.OfType<JObject>().Count();
                        foreach (JObject pair in pairTokens.OfType<JObject>())
                        {
                            int pairCount = 0;
                            bool Full() => count >= maxHits || (perPair > 0 && pairCount >= perPair);
                            string nameA = pair.Value<string>("a") ?? "";
                            string nameB = pair.Value<string>("b") ?? "";
                            if (!TryCategory(nameA, out BuiltInCategory catA)) { skipped.Add(nameA); continue; }
                            if (!TryCategory(nameB, out BuiltInCategory catB)) { skipped.Add(nameB); continue; }
                            List<Ref> left = Collect(doc, catA, "", null);
                            List<Ref> right = new List<Ref>();
                            string wanted = (Parameters.Value<string>("link") ?? "").Trim();
                            if (wanted.Length > 0)
                            {
                                var matches = MatchingLinks(doc, wanted);
                                if (matches.Count == 0)
                                {
                                    Result["code"] = "FMC-LINK-NOT-FOUND";
                                    Result["message"] = "No link instance matches \"" + wanted + "\". The structural model does not have to be open, but it does have to be linked into this host.";
                                    Result["read_only"] = true;
                                    Result["applied"] = false;
                                    Result["count"] = 0;
                                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                                    return;
                                }
                                var loaded = matches.Where(link => link.GetLinkDocument() != null).ToList();
                                if (loaded.Count == 0)
                                {
                                    Result["code"] = "FMC-LINK-NOT-LOADED";
                                    Result["message"] = "Link \"" + wanted + "\" is in the host but GetLinkDocument() is null. Nothing was scanned.";
                                    Result["unloaded"] = new JArray(matches.Select(Label));
                                    Result["read_only"] = true;
                                    Result["applied"] = false;
                                    Result["count"] = 0;
                                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                                    return;
                                }
                                foreach (RevitLinkInstance link in loaded)
                                {
                                    Document linked = link.GetLinkDocument();
                                    string title = linked.Title ?? Label(link);
                                    if (!linkNames.Any(token => token.ToString() == title)) linkNames.Add(title);
                                    right.AddRange(Collect(linked, catB, title, link.GetTotalTransform()));
                                }
                            }
                            else
                            {
                                right.AddRange(Collect(doc, catB, "", null));
                                if (links) AddLoadedLinks(doc, catA, catB, nameA, nameB, left, right, linkNames);
                            }
                            bool same = string.Equals(nameA, nameB, StringComparison.OrdinalIgnoreCase);
                            for (int i = 0; i < left.Count; i += chunk)
                            {
                                List<Box> aChunk = Boxes(left.Skip(i).Take(chunk));
                                for (int j = same ? i : 0; j < right.Count; j += chunk)
                                {
                                    List<Box> bChunk = Boxes(right.Skip(j).Take(chunk));
                                    chunks++;
                                    foreach (Box a in aChunk)
                                    {
                                        foreach (Box b in bChunk)
                                        {
                                            if (a.Id == b.Id && a.Link == b.Link) continue;
                                            if (same && (a.Id > b.Id || (a.Id == b.Id && string.CompareOrdinal(a.Link, b.Link) >= 0))) continue;
                                            compared++;
                                            if (!Overlap(a, b, tolerance)) continue;
                                            bool? exactHit = null;
                                            if (exact)
                                            {
                                                exactHit = SolidsHit(a, b);
                                                if (exactHit == false) continue;
                                            }
                                            count++;
                                            pairCount++;
                                            string key = nameA + "|" + nameB;
                                            byPair[key] = byPair.TryGetValue(key, out int have) ? have + 1 : 1;
                                            string status = Mark(a, b, nameA, nameB, centreline, clearance, openings, out long openingId);
                                            var line = new JObject
                                            {
                                                ["a"] = a.Id, ["b"] = b.Id, ["category_a"] = nameA, ["category_b"] = nameB,
                                                ["link_a"] = a.Link, ["link_b"] = b.Link, ["overlap"] = true, ["exact"] = exactHit == null ? (JToken)JValue.CreateNull() : exactHit,
                                                ["status"] = status, ["opening_id"] = openingId,
                                            };
                                            writer.WriteLine(line.ToString(Newtonsoft.Json.Formatting.None));
                                            if (sample.Count < 40) sample.Add(line);
                                            if (Full()) break;
                                        }
                                        if (Full()) break;
                                    }
                                    bChunk.Clear();
                                    if (Full()) break;
                                }
                                aChunk.Clear();
                                peak = Math.Max(peak, WorkingSet());
                                if (Full()) break;
                            }
                            left.Clear();
                            right.Clear();
                            peak = Math.Max(peak, WorkingSet());
                            pairsDone++;
                            if (perPair > 0 && pairCount >= perPair) cappedPairs.Add(nameA + "|" + nameB);
                            if (count >= maxHits) break;
                        }
                        writer.Flush();
                    }
                    var pairs = new JObject();
                    foreach (KeyValuePair<string, int> item in byPair) pairs[item.Key] = item.Value;
                    Result["read_only"] = true;
                    Result["applied"] = false;
                    Result["saved"] = false;
                    Result["count"] = count;
                    Result["compared"] = compared;
                    Result["chunks"] = chunks;
                    Result["truncated"] = count >= maxHits;
                    Result["pairs_total"] = pairsTotal;
                    Result["pairs_done"] = pairsDone;
                    Result["max_hits_per_pair"] = perPair;
                    Result["capped_pairs"] = cappedPairs;
                    Result["by_pair"] = pairs;
                    Result["sample"] = sample;
                    Result["report"] = file;
                    Result["peak_working_set_mb"] = Math.Round(peak / 1048576.0, 1);
                    Result["skipped_categories"] = skipped;
                    Result["links"] = linkNames;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["model"] = doc.Title;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static List<Ref> Collect(Document doc, BuiltInCategory category, string link, Transform toHost)
        {
            var refs = new List<Ref>();
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
                refs.Add(new Ref { Id = element.Id.Value, Link = link ?? "", Doc = doc, ToHost = toHost });
            return refs;
        }

        private static List<Box> Boxes(IEnumerable<Ref> refs)
        {
            var boxes = new List<Box>();
            foreach (Ref item in refs)
            {
                Element element = item.Doc.GetElement(new ElementId(item.Id));
                BoundingBoxXYZ box = element?.get_BoundingBox(null);
                if (box == null) continue;
                XYZ min = box.Min;
                XYZ max = box.Max;
                if (item.ToHost != null)
                {
                    min = null;
                    max = null;
                    for (int ix = 0; ix < 2; ix++)
                        for (int iy = 0; iy < 2; iy++)
                            for (int iz = 0; iz < 2; iz++)
                            {
                                XYZ corner = item.ToHost.OfPoint(new XYZ(ix == 0 ? box.Min.X : box.Max.X, iy == 0 ? box.Min.Y : box.Max.Y, iz == 0 ? box.Min.Z : box.Max.Z));
                                if (min == null) { min = corner; max = corner; continue; }
                                min = new XYZ(Math.Min(min.X, corner.X), Math.Min(min.Y, corner.Y), Math.Min(min.Z, corner.Z));
                                max = new XYZ(Math.Max(max.X, corner.X), Math.Max(max.Y, corner.Y), Math.Max(max.Z, corner.Z));
                            }
                }
                boxes.Add(new Box { Id = item.Id, Link = item.Link, Min = min, Max = max, ToHost = item.ToHost, Doc = item.Doc });
            }
            return boxes;
        }

        private static bool Overlap(Box a, Box b, double tolerance)
        {
            return a.Min.X - tolerance <= b.Max.X && a.Max.X + tolerance >= b.Min.X
                && a.Min.Y - tolerance <= b.Max.Y && a.Max.Y + tolerance >= b.Min.Y
                && a.Min.Z - tolerance <= b.Max.Z && a.Max.Z + tolerance >= b.Min.Z;
        }

        private static bool SolidsHit(Box a, Box b)
        {
            Solid left = FirstSolid(a);
            Solid right = FirstSolid(b);
            if (left == null || right == null) return false;
            try
            {
                if (a.ToHost != null) left = SolidUtils.CreateTransformed(left, a.ToHost);
                if (b.ToHost != null) right = SolidUtils.CreateTransformed(right, b.ToHost);
                Solid hit = BooleanOperationsUtils.ExecuteBooleanOperation(left, right, BooleanOperationsType.Intersect);
                return hit != null && hit.Volume > 1e-9;
            }
            catch (Exception) { return false; }
        }

        private static Solid FirstSolid(Box box)
        {
            Element element = box.Doc.GetElement(new ElementId(box.Id));
            if (element == null) return null;
            var options = new Options { ComputeReferences = false, IncludeNonVisibleObjects = false, DetailLevel = ViewDetailLevel.Fine };
            GeometryElement geometry = element.get_Geometry(options);
            if (geometry == null) return null;
            foreach (GeometryObject item in geometry)
            {
                if (item is Solid solid && solid.Volume > 1e-9) return solid;
                if (item is GeometryInstance instance)
                {
                    foreach (GeometryObject nested in instance.GetInstanceGeometry())
                        if (nested is Solid inner && inner.Volume > 1e-9) return inner;
                }
            }
            return null;
        }

        private static bool TryCategory(string name, out BuiltInCategory category)
        {
            string text = (name ?? "").Trim();
            if (!text.StartsWith("OST_", StringComparison.OrdinalIgnoreCase)) text = "OST_" + text;
            return Enum.TryParse(text, true, out category);
        }

        private sealed class OpeningInfo
        {
            public long Id;
            public long Host;
            public XYZ Min;
            public XYZ Max;
            public string Kind;
            public string Name;
        }

        private static JArray DefaultPairs()
        {
            string[] hosts = { "OST_Walls", "OST_Floors", "OST_Ceilings", "OST_Roofs", "OST_StructuralColumns", "OST_StructuralFraming", "OST_StructuralFoundation", "OST_Site" };
            string[] guests = { "OST_PipeCurves", "OST_DuctCurves", "OST_Conduit", "OST_CableTray", "OST_MechanicalEquipment", "OST_PlumbingEquipment", "OST_GenericModel", "OST_SpecialityEquipment", "OST_ElectricalFixtures", "OST_LightingFixtures" };
            var pairs = new JArray();
            foreach (string host in hosts) foreach (string guest in guests) pairs.Add(new JObject { ["a"] = host, ["b"] = guest });
            return pairs;
        }

        private static List<OpeningInfo> LoadOpenings(Document doc)
        {
            var list = new List<OpeningInfo>();
            try
            {
                foreach (Opening opening in new FilteredElementCollector(doc).OfClass(typeof(Opening)).Cast<Opening>())
                {
                    BoundingBoxXYZ box = opening.get_BoundingBox(null);
                    if (box == null) continue;
                    long host = 0;
                    try { host = opening.Host?.Id.Value ?? 0; } catch (Exception) { host = 0; }
                    list.Add(new OpeningInfo { Id = opening.Id.Value, Host = host, Min = box.Min, Max = box.Max, Kind = "opening", Name = opening.Name ?? "" });
                }
            }
            catch (Exception) { /* a model with no openings still scans */ }
            var hosted = new[] { BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_GenericModel, BuiltInCategory.OST_PipeAccessory, BuiltInCategory.OST_SpecialityEquipment };
            foreach (FamilyInstance instance in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(hosted)).WhereElementIsNotElementType().OfType<FamilyInstance>())
            {
                if (instance.Host == null) continue;
                string name = ((instance.Symbol?.FamilyName ?? "") + " " + (instance.Symbol?.Name ?? "") + " " + instance.Name).ToLowerInvariant();
                bool sleeve = name.Contains("sleeve");
                bool door = instance.Category != null && (instance.Category.Id.Value == (long)BuiltInCategory.OST_Doors || instance.Category.Id.Value == (long)BuiltInCategory.OST_Windows);
                if (!sleeve && !door) continue;
                BoundingBoxXYZ box = instance.get_BoundingBox(null);
                if (box == null) continue;
                list.Add(new OpeningInfo { Id = instance.Id.Value, Host = instance.Host.Id.Value, Min = box.Min, Max = box.Max, Kind = sleeve ? "sleeve" : "opening", Name = name });
            }
            return list;
        }

        private static string Mark(Box a, Box b, string catA, string catB, bool centreline, double clearance, List<OpeningInfo> openings, out long openingId)
        {
            openingId = 0;
            try
            {
                if (Joined(a, b)) return "join";
                if (HostedOn(a, b) || HostedOn(b, a)) return "hosted";
                long wall = catA.IndexOf("Wall", StringComparison.OrdinalIgnoreCase) >= 0 || catA.IndexOf("Floor", StringComparison.OrdinalIgnoreCase) >= 0 ? a.Id
                    : catB.IndexOf("Wall", StringComparison.OrdinalIgnoreCase) >= 0 || catB.IndexOf("Floor", StringComparison.OrdinalIgnoreCase) >= 0 ? b.Id : 0;
                if (wall != 0 && InsideOpening(a, b, wall, openings, out openingId)) return "cleared_by_opening";
                if (centreline && (CurveMisses(a, b) || CurveMisses(b, a))) return "clearance";
                double depth = Math.Min(Math.Min(Overlap1(a.Min.X, a.Max.X, b.Min.X, b.Max.X), Overlap1(a.Min.Y, a.Max.Y, b.Min.Y, b.Max.Y)), Overlap1(a.Min.Z, a.Max.Z, b.Min.Z, b.Max.Z));
                if (clearance > 0 && depth > 0 && depth <= clearance) return "clearance";
            }
            catch (Exception) { return "hard"; }
            return "hard";
        }

        private static bool Joined(Box a, Box b)
        {
            ConnectorManager manager = Connectors(a.Doc.GetElement(new ElementId(a.Id)));
            if (manager == null) return false;
            foreach (Connector connector in manager.Connectors)
            {
                try
                {
                    foreach (Connector other in connector.AllRefs)
                        if (other?.Owner != null && other.Owner.Id.Value == b.Id) return true;
                }
                catch (Exception) { /* one connector is not a reason to call this a clash */ }
            }
            return false;
        }

        private static ConnectorManager Connectors(Element element)
        {
            if (element is MEPCurve curve) return curve.ConnectorManager;
            if (element is FamilyInstance instance) return instance.MEPModel?.ConnectorManager;
            return null;
        }

        private static bool HostedOn(Box device, Box host)
        {
            if (device.Doc.GetElement(new ElementId(device.Id)) is FamilyInstance instance && instance.Host != null)
                return instance.Host.Id.Value == host.Id;
            return false;
        }

        private static bool InsideOpening(Box a, Box b, long wall, List<OpeningInfo> openings, out long openingId)
        {
            openingId = 0;
            XYZ min = new XYZ(Math.Max(a.Min.X, b.Min.X), Math.Max(a.Min.Y, b.Min.Y), Math.Max(a.Min.Z, b.Min.Z));
            XYZ max = new XYZ(Math.Min(a.Max.X, b.Max.X), Math.Min(a.Max.Y, b.Max.Y), Math.Min(a.Max.Z, b.Max.Z));
            foreach (OpeningInfo opening in openings)
            {
                if (opening.Host != 0 && opening.Host != wall) continue;
                if (min.X >= opening.Min.X - 0.01 && min.Y >= opening.Min.Y - 0.01 && min.Z >= opening.Min.Z - 0.01
                    && max.X <= opening.Max.X + 0.01 && max.Y <= opening.Max.Y + 0.01 && max.Z <= opening.Max.Z + 0.01)
                {
                    openingId = opening.Id;
                    return true;
                }
            }
            return false;
        }

        private static bool CurveMisses(Box curve, Box other)
        {
            if (!(curve.Doc.GetElement(new ElementId(curve.Id)) is MEPCurve mep)) return false;
            if (!(mep.Location is LocationCurve located) || located.Curve == null || !located.Curve.IsBound) return false;
            double radius = 0;
            foreach (BuiltInParameter parameter in new[] { BuiltInParameter.RBS_PIPE_DIAMETER_PARAM, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM, BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM, BuiltInParameter.RBS_CURVE_WIDTH_PARAM })
            {
                Parameter value = mep.get_Parameter(parameter);
                if (value == null || !value.HasValue) continue;
                radius = Math.Max(radius, value.AsDouble() / 2);
            }
            XYZ p0 = located.Curve.GetEndPoint(0);
            XYZ p1 = located.Curve.GetEndPoint(1);
            XYZ min = new XYZ(other.Min.X - radius, other.Min.Y - radius, other.Min.Z - radius);
            XYZ max = new XYZ(other.Max.X + radius, other.Max.Y + radius, other.Max.Z + radius);
            return !SegmentHits(p0, p1, min, max);
        }

        private static bool SegmentHits(XYZ p0, XYZ p1, XYZ min, XYZ max)
        {
            double t0 = 0, t1 = 1;
            double[] start = { p0.X, p0.Y, p0.Z };
            double[] delta = { p1.X - p0.X, p1.Y - p0.Y, p1.Z - p0.Z };
            double[] lo = { min.X, min.Y, min.Z };
            double[] hi = { max.X, max.Y, max.Z };
            for (int axis = 0; axis < 3; axis++)
            {
                if (Math.Abs(delta[axis]) < 1e-9)
                {
                    if (start[axis] < lo[axis] || start[axis] > hi[axis]) return false;
                    continue;
                }
                double near = (lo[axis] - start[axis]) / delta[axis];
                double far = (hi[axis] - start[axis]) / delta[axis];
                if (near > far) { double swap = near; near = far; far = swap; }
                t0 = Math.Max(t0, near);
                t1 = Math.Min(t1, far);
                if (t0 > t1) return false;
            }
            return true;
        }

        private static double Overlap1(double a0, double a1, double b0, double b1) => Math.Min(a1, b1) - Math.Max(a0, b0);

        private void Sleeves(Document doc)
        {
            double radius = (Parameters.Value<double?>("radius_mm") ?? 300) / FeetToMm;
            long hitA = Parameters.Value<long?>("hit_a") ?? 0;
            long hitB = Parameters.Value<long?>("hit_b") ?? 0;
            JArray point = Parameters["point_mm"] as JArray;
            XYZ at = null;
            if (point != null && point.Count >= 3) at = new XYZ(point[0].Value<double>() / FeetToMm, point[1].Value<double>() / FeetToMm, point[2].Value<double>() / FeetToMm);
            var rows = new JArray();
            foreach (OpeningInfo opening in LoadOpenings(doc))
            {
                bool named = opening.Id == hitA || opening.Id == hitB || opening.Host == hitA || opening.Host == hitB;
                XYZ centre = (opening.Min + opening.Max) / 2;
                bool near = at != null && centre.DistanceTo(at) <= radius;
                if (!named && !near && hitA == 0 && at == null) continue;
                if (!named && !near) continue;
                rows.Add(new JObject
                {
                    ["id"] = opening.Id, ["host_id"] = opening.Host, ["kind"] = opening.Kind, ["name"] = opening.Name,
                    ["min"] = Mm(opening.Min), ["max"] = Mm(opening.Max),
                });
            }
            Result["read_only"] = true;
            Result["applied"] = false;
            Result["sleeves"] = rows;
            Result["count"] = rows.Count;
            Result["resolved_document"] = FmcTarget.Resolved(doc);
        }

        private static long WorkingSet()
        {
            try { return Process.GetCurrentProcess().WorkingSet64; }
            catch (Exception) { return 0; }
        }

        private static void AddLoadedLinks(Document doc, BuiltInCategory catA, BuiltInCategory catB, string nameA, string nameB, List<Ref> left, List<Ref> right, JArray linkNames)
        {
            foreach (RevitLinkInstance link in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
            {
                Document linked = link.GetLinkDocument();
                if (linked == null) continue;
                string title = linked.Title ?? Label(link);
                if (!linkNames.Any(token => token.ToString() == title)) linkNames.Add(title);
                Transform transform = link.GetTotalTransform();
                right.AddRange(Collect(linked, catB, title, transform));
                if (!string.Equals(nameA, nameB, StringComparison.OrdinalIgnoreCase))
                    left.AddRange(Collect(linked, catA, title, transform));
            }
        }

        private static List<RevitLinkInstance> MatchingLinks(Document doc, string wanted)
        {
            return new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>()
                .Where(link => LinkMatches(wanted, link, doc)).ToList();
        }

        private static string Label(RevitLinkInstance link)
        {
            var type = link.Document.GetElement(link.GetTypeId()) as RevitLinkType;
            return type?.Name ?? link.Name ?? "";
        }

        private static bool LinkMatches(string wanted, RevitLinkInstance link, Document host)
        {
            string key = (wanted ?? "").Trim();
            if (key.Length == 0) return false;
            var type = host.GetElement(link.GetTypeId()) as RevitLinkType;
            string name = type?.Name ?? "";
            string instance = link.Name ?? "";
            Document linked = link.GetLinkDocument();
            string title = linked?.Title ?? "";
            if (Same(name, key) || Same(instance, key) || Same(title, key)) return true;
            string role = Role(name);
            if (role.Length == 0) role = Role(title);
            if (key.Length <= 3 && role.Length > 0 && string.Equals(role, key, StringComparison.OrdinalIgnoreCase)) return true;
            if (key.Length > 3)
            {
                string blob = (name + " " + instance + " " + title).ToLowerInvariant();
                return blob.Contains(key.ToLowerInvariant());
            }
            return false;
        }

        private static bool Same(string value, string key) => value.Trim().Length > 0 && string.Equals(value.Trim(), key.Trim(), StringComparison.OrdinalIgnoreCase);

        private static string Role(string title)
        {
            string file = Path.GetFileNameWithoutExtension(title ?? "");
            if (file.EndsWith("_USER", StringComparison.OrdinalIgnoreCase)) file = file.Substring(0, file.Length - 5);
            string[] parts = file.Split(new[] { '-' }, StringSplitOptions.RemoveEmptyEntries);
            return parts.Length >= 6 ? parts[5].ToUpperInvariant() : "";
        }

        private void ExportCache(Document doc)
        {
            var categories = new List<BuiltInCategory>();
            var skipped = new JArray();
            foreach (JToken token in Parameters["categories"] as JArray ?? new JArray())
            {
                if (!TryCategory(token.ToString(), out BuiltInCategory category)) { skipped.Add(token.ToString()); continue; }
                categories.Add(category);
            }
            if (categories.Count == 0)
            {
                Result["code"] = "FMC-CLASH-CATEGORY";
                Result["message"] = "export_cache needs categories.";
                Result["read_only"] = true;
                return;
            }
            string dir = CacheDir();
            if (OnD(dir))
            {
                Result["code"] = "FMC-CLASH-PATH";
                Result["message"] = "A clash cache is not written on D:.";
                Result["read_only"] = true;
                return;
            }
            bool meshes = Parameters.Value<bool?>("meshes") == true;
            int cap = Parameters.Value<int?>("mesh_cap") ?? 24;
            string title = string.IsNullOrEmpty(doc.Title) ? "model" : doc.Title;
            string file = Path.Combine(dir, Safe(title) + "-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ".json");
            if (OnD(file) || string.Equals(file, doc.PathName, StringComparison.OrdinalIgnoreCase))
            {
                Result["code"] = "FMC-CLASH-PATH";
                Result["message"] = "Refusing to write the cache onto D: or onto the source model.";
                Result["read_only"] = true;
                return;
            }
            Directory.CreateDirectory(dir);
            DateTime saved = !string.IsNullOrEmpty(doc.PathName) && File.Exists(doc.PathName) ? File.GetLastWriteTimeUtc(doc.PathName) : DateTime.UtcNow;
            int count = 0;
            long peak = WorkingSet();
            using (var writer = new StreamWriter(file, false))
            {
                writer.WriteLine(new JObject
                {
                    ["kind"] = "fmc_clash_cache",
                    ["doc_title"] = title,
                    ["path"] = doc.PathName ?? "",
                    ["saved_at"] = saved.ToString("o"),
                    ["written_at"] = DateTime.UtcNow.ToString("o"),
                    ["categories"] = new JArray(categories.Select(category => category.ToString())),
                    ["mesh_cap"] = cap,
                }.ToString(Newtonsoft.Json.Formatting.None));
                foreach (BuiltInCategory category in categories)
                {
                    foreach (Element element in new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
                    {
                        BoundingBoxXYZ box = element.get_BoundingBox(null);
                        if (box == null) continue;
                        var row = new JObject
                        {
                            ["id"] = element.Id.Value,
                            ["unique_id"] = element.UniqueId,
                            ["category"] = category.ToString(),
                            ["min"] = Mm(box.Min),
                            ["max"] = Mm(box.Max),
                            ["version"] = element.VersionGuid.ToString(),
                        };
                        if (meshes && cap > 0) row["mesh"] = Mesh(element, cap);
                        writer.WriteLine(row.ToString(Newtonsoft.Json.Formatting.None));
                        count++;
                        if ((count % 200) == 0) peak = Math.Max(peak, WorkingSet());
                    }
                }
            }
            Result["read_only"] = true;
            Result["applied"] = false;
            Result["saved"] = false;
            Result["cache"] = file;
            Result["doc_title"] = title;
            Result["path"] = doc.PathName ?? "";
            Result["saved_at"] = saved.ToString("o");
            Result["count"] = count;
            Result["skipped_categories"] = skipped;
            Result["peak_working_set_mb"] = Math.Round(peak / 1048576.0, 1);
            Result["resolved_document"] = FmcTarget.Resolved(doc);
            Result["note"] = "The source model was not saved.";
        }

        private void ScanAgainstCache(Document doc, string cacheKey)
        {
            string file = cacheKey;
            if (!File.Exists(file))
            {
                Result["code"] = "FMC-CLASH-CACHE";
                Result["message"] = "Cache file was not found: " + cacheKey;
                Result["read_only"] = true;
                Result["applied"] = false;
                Result["count"] = 0;
                return;
            }
            int chunk = Parameters.Value<int?>("chunk") ?? 250;
            double tolerance = (Parameters.Value<double?>("tolerance_mm") ?? 0) / FeetToMm;
            int maxHits = Parameters.Value<int?>("max_hits") ?? 5000;
            long peak = WorkingSet();
            int count = 0;
            int chunks = 0;
            var sample = new JArray();
            string reportDir = Path.GetDirectoryName(CacheDir()) ?? CacheDir();
            if (OnD(reportDir)) reportDir = Path.GetTempPath();
            Directory.CreateDirectory(reportDir);
            string report = UniqueReport(reportDir, "clash-cache-", doc.Title);
            using (var writer = new StreamWriter(report, false))
            {
                foreach (JObject pair in (Parameters["pairs"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    string nameA = pair.Value<string>("a") ?? "";
                    string nameB = pair.Value<string>("b") ?? "";
                    if (!TryCategory(nameA, out BuiltInCategory catA)) continue;
                    List<Ref> host = Collect(doc, catA, "", null);
                    for (int i = 0; i < host.Count; i += chunk)
                    {
                        List<Box> aChunk = Boxes(host.Skip(i).Take(chunk));
                        chunks++;
                        using (var reader = new StreamReader(file))
                        {
                            string header = reader.ReadLine();
                            if (string.IsNullOrEmpty(header)) continue;
                            string line;
                            while ((line = reader.ReadLine()) != null)
                            {
                                if (line.Length == 0) continue;
                                JObject row;
                                try { row = JObject.Parse(line); } catch (Exception) { continue; }
                                if (!string.Equals(row.Value<string>("category") ?? "", nameB, StringComparison.OrdinalIgnoreCase)) continue;
                                var min = Xyz(row["min"] as JArray);
                                var max = Xyz(row["max"] as JArray);
                                if (min == null || max == null) continue;
                                var cached = new Box { Id = row.Value<long?>("id") ?? 0, Link = "cache", Min = min, Max = max, Doc = doc };
                                foreach (Box hostBox in aChunk)
                                {
                                    if (!Overlap(hostBox, cached, tolerance)) continue;
                                    count++;
                                    var hit = new JObject { ["a"] = hostBox.Id, ["b"] = cached.Id, ["category_a"] = nameA, ["category_b"] = nameB, ["link_b"] = "cache", ["overlap"] = true };
                                    writer.WriteLine(hit.ToString(Newtonsoft.Json.Formatting.None));
                                    if (sample.Count < 40) sample.Add(hit);
                                    if (count >= maxHits) break;
                                }
                                if (count >= maxHits) break;
                            }
                        }
                        aChunk.Clear();
                        peak = Math.Max(peak, WorkingSet());
                        if (count >= maxHits) break;
                    }
                    host.Clear();
                    if (count >= maxHits) break;
                }
            }
            Result["read_only"] = true;
            Result["applied"] = false;
            Result["saved"] = false;
            Result["count"] = count;
            Result["chunks"] = chunks;
            Result["sample"] = sample;
            Result["report"] = report;
            Result["cache"] = file;
            Result["peak_working_set_mb"] = Math.Round(peak / 1048576.0, 1);
            Result["resolved_document"] = FmcTarget.Resolved(doc);
            Result["truncated"] = count >= maxHits;
        }

        private static string CacheDir()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dir = Path.Combine(local, "Formcraft", "clash", "cache");
            if (!OnD(dir)) return dir;
            string fallback = Path.Combine("C:\\Users\\Public", "Formcraft", "clash", "cache");
            return OnD(fallback) ? Path.Combine(Path.GetTempPath(), "Formcraft", "clash", "cache") : fallback;
        }

        private static bool OnD(string file) => !string.IsNullOrWhiteSpace(file) && file.Trim().StartsWith("D:", StringComparison.OrdinalIgnoreCase);

        /// <summary>A report name that two scans in the same second cannot share: a short document tag, milliseconds, then -2, -3 if still taken.</summary>
        private static string UniqueReport(string folder, string prefix, string title)
        {
            string tag = Safe(title ?? "").Replace(' ', '_');
            if (tag.Length > 24) tag = tag.Substring(0, 24);
            string stem = prefix + (tag.Length > 0 ? tag + "-" : "") + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
            string file = Path.Combine(folder, stem + ".jsonl");
            for (int n = 2; File.Exists(file); n++) file = Path.Combine(folder, stem + "-" + n + ".jsonl");
            return file;
        }

        private static string Safe(string title)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) title = title.Replace(c, '_');
            return title.Length > 80 ? title.Substring(0, 80) : title;
        }

        private static JArray Mm(XYZ point) => new JArray(Math.Round(point.X * FeetToMm, 1), Math.Round(point.Y * FeetToMm, 1), Math.Round(point.Z * FeetToMm, 1));

        private static XYZ Xyz(JArray array)
        {
            if (array == null || array.Count < 3) return null;
            return new XYZ(array[0].Value<double>() / FeetToMm, array[1].Value<double>() / FeetToMm, array[2].Value<double>() / FeetToMm);
        }

        private static JArray Mesh(Element element, int cap)
        {
            var points = new JArray();
            int kept = 0;
            var options = new Options { ComputeReferences = false, IncludeNonVisibleObjects = false, DetailLevel = ViewDetailLevel.Coarse };
            GeometryElement geometry = element.get_Geometry(options);
            if (geometry == null) return points;
            void Take(Solid solid)
            {
                if (solid == null || solid.Faces.Size == 0 || kept >= cap) return;
                foreach (Face face in solid.Faces)
                {
                    Mesh mesh = face.Triangulate();
                    if (mesh == null) continue;
                    for (int i = 0; i < mesh.NumTriangles && kept < cap; i++)
                    {
                        MeshTriangle triangle = mesh.get_Triangle(i);
                        var tri = new JArray();
                        for (int v = 0; v < 3; v++) tri.Add(Mm(triangle.get_Vertex(v)));
                        points.Add(tri);
                        kept++;
                    }
                    if (kept >= cap) return;
                }
            }
            foreach (GeometryObject item in geometry)
            {
                if (item is Solid solid) Take(solid);
                else if (item is GeometryInstance instance)
                    foreach (GeometryObject nested in instance.GetInstanceGeometry())
                        if (nested is Solid inner) Take(inner);
                if (kept >= cap) break;
            }
            return points;
        }
    }
}
