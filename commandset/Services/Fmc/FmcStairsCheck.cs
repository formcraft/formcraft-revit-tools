using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Stair, ramp and handrail facts for fmc_stairs_check. Read-only.
    /// Nothing is started, nothing is rolled back, nothing is created or set. The numbers go to the server,
    /// which compares them with the kit values in the standards bank.
    /// </summary>
    public class FmcStairsCheckHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const int ElementCap = 3000;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft stairs check";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_stairs_check needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var kinds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (JToken token in Parameters["kinds"] as JArray ?? new JArray())
                        if (!string.IsNullOrWhiteSpace(token.ToString())) kinds.Add(token.ToString().Trim());
                    bool all = kinds.Count == 0;
                    bool host = Wants(Parameters["sources"] as JArray, "host");
                    bool links = Wants(Parameters["sources"] as JArray, "link");
                    var stairs = new JArray();
                    var ramps = new JArray();
                    var railings = new JArray();
                    var notes = new JArray();
                    var unloaded = new JArray();
                    bool cut = false;
                    // Railings are always read: a stair or ramp needs its railings even when only stairs were asked for.
                    if (host) Collect(doc, "host", "", all || kinds.Contains("stair"), all || kinds.Contains("ramp"), stairs, ramps, railings, ref cut);
                    if (links)
                    {
                        foreach (RevitLinkInstance link in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
                        {
                            Document linked = link.GetLinkDocument();
                            if (linked == null) { unloaded.Add(link.Name ?? ""); continue; }
                            Collect(linked, "link", link.Name ?? "", all || kinds.Contains("stair"), all || kinds.Contains("ramp"), stairs, ramps, railings, ref cut);
                        }
                    }
                    if (cut) notes.Add("The read stopped at " + ElementCap + " elements of one kind.");
                    notes.Add("Ramp gradient is the ramp's Maximum Incline (1/x). Ramp rise is the bounding box height less the thickness, so it is approximate. Revit stores no width on a sketched ramp.");
                    notes.Add("A stair that is not by component has no runs or landings to read. Its run width, risers per flight and landings are not applicable.");
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["applied"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["notes"] = notes,
                        ["unloaded_links"] = unloaded,
                        ["stairs"] = stairs,
                        ["ramps"] = ramps,
                        ["railings"] = railings,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static void Collect(Document source, string side, string linkName, bool wantStairs, bool wantRamps, JArray stairs, JArray ramps, JArray railings, ref bool cut)
        {
            var rampIds = new HashSet<long>();
            foreach (Element element in new FilteredElementCollector(source).OfCategory(BuiltInCategory.OST_Ramps).WhereElementIsNotElementType())
            {
                rampIds.Add(element.Id.Value);
                if (!wantRamps) continue;
                if (ramps.Count >= ElementCap) { cut = true; continue; }
                ramps.Add(RampRow(source, element, side, linkName));
            }
            if (wantStairs)
            {
                foreach (Element element in new FilteredElementCollector(source).OfCategory(BuiltInCategory.OST_Stairs).WhereElementIsNotElementType())
                {
                    if (stairs.Count >= ElementCap) { cut = true; break; }
                    if (!(element is Stairs stair)) continue;
                    stairs.Add(StairRow(source, stair, side, linkName));
                }
            }
            foreach (Railing railing in new FilteredElementCollector(source).OfClass(typeof(Railing)).Cast<Railing>())
            {
                if (railings.Count >= ElementCap) { cut = true; break; }
                railings.Add(RailingRow(source, railing, rampIds, side, linkName));
            }
        }

        private static JObject Base(Document doc, Element element, string side, string linkName)
        {
            return new JObject
            {
                ["id"] = element.Id.Value.ToString(),
                ["name"] = element.Name ?? "",
                ["type"] = TypeName(doc, element),
                ["level"] = LevelName(doc, element),
                ["source"] = side,
                ["link"] = linkName,
            };
        }

        private static JObject StairRow(Document doc, Stairs stair, string side, string linkName)
        {
            JObject row = Base(doc, stair, side, linkName);
            bool component = false;
            try { component = Stairs.IsByComponent(doc, stair.Id); } catch { component = false; }
            row["method"] = component ? "component" : "sketch";
            row["riser_mm"] = Mm(stair.ActualRiserHeight);
            row["tread_mm"] = Mm(stair.ActualTreadDepth);
            row["risers"] = stair.ActualRisersNumber;
            var runs = new JArray();
            var landings = new JArray();
            if (component)
            {
                foreach (ElementId id in stair.GetStairsRuns())
                {
                    if (!(doc.GetElement(id) is StairsRun run)) continue;
                    runs.Add(new JObject { ["id"] = id.Value.ToString(), ["width_mm"] = Mm(run.ActualRunWidth), ["risers"] = run.ActualRisersNumber });
                }
                foreach (ElementId id in stair.GetStairsLandings())
                {
                    if (!(doc.GetElement(id) is StairsLanding landing)) continue;
                    landings.Add(LandingRow(landing, id));
                }
            }
            row["runs"] = runs;
            row["landings"] = landings;
            var rails = new JArray();
            try { foreach (ElementId id in stair.GetAssociatedRailings()) rails.Add(id.Value.ToString()); } catch { }
            row["railing_ids"] = rails;
            return row;
        }

        /// <summary>A rectangular footprint gives its two side lengths. Anything else gives the bounding box, marked approximate.</summary>
        private static JObject LandingRow(StairsLanding landing, ElementId id)
        {
            var row = new JObject { ["id"] = id.Value.ToString() };
            try
            {
                CurveLoop loop = landing.GetFootprintBoundary();
                var lines = new List<Line>();
                foreach (Curve curve in loop) if (curve is Line line) lines.Add(line);
                if (lines.Count == 4 && loop.Count() == 4)
                {
                    row["width_mm"] = Mm(lines[0].Length);
                    row["depth_mm"] = Mm(lines[1].Length);
                    row["approximate"] = false;
                    return row;
                }
            }
            catch { }
            BoundingBoxXYZ box = landing.get_BoundingBox(null);
            if (box != null)
            {
                row["width_mm"] = Mm(box.Max.X - box.Min.X);
                row["depth_mm"] = Mm(box.Max.Y - box.Min.Y);
            }
            row["approximate"] = true;
            return row;
        }

        private static JObject RampRow(Document doc, Element ramp, string side, string linkName)
        {
            JObject row = Base(doc, ramp, side, linkName);
            double? inv = ParamDouble(doc, ramp, BuiltInParameter.RAMP_ATTR_MIN_INV_SLOPE);
            row["max_incline_inv"] = inv.HasValue && inv.Value > 0 ? (JToken)Math.Round(inv.Value, 2) : JValue.CreateNull();
            double? thickness = ParamDouble(doc, ramp, BuiltInParameter.RAMP_ATTR_THICKNESS);
            BoundingBoxXYZ box = ramp.get_BoundingBox(null);
            if (box != null) row["rise_mm"] = Mm(Math.Max(0, (box.Max.Z - box.Min.Z) - (thickness ?? 0)));
            else row["rise_mm"] = JValue.CreateNull();
            row["railing_ids"] = new JArray();
            return row;
        }

        private static JObject RailingRow(Document doc, Railing railing, HashSet<long> rampIds, string side, string linkName)
        {
            JObject row = Base(doc, railing, side, linkName);
            string kind = "other";
            string hostId = "";
            try
            {
                if (railing.HasHost)
                {
                    hostId = railing.HostId.Value.ToString();
                    Element host = doc.GetElement(railing.HostId);
                    if (host is Stairs || host is StairsRun || host is StairsLanding) kind = "stair";
                    else if (rampIds.Contains(railing.HostId.Value)) kind = "ramp";
                }
            }
            catch { }
            row["host_id"] = hostId;
            row["host_kind"] = kind;
            double offset = ParamDouble(doc, railing, BuiltInParameter.STAIRS_RAILING_HEIGHT_OFFSET) ?? 0;
            double? hand = null, top = null;
            if (doc.GetElement(railing.GetTypeId()) is RailingType type)
            {
                try
                {
                    if (type.PrimaryHandrailType != ElementId.InvalidElementId) hand = type.PrimaryHandrailHeight + offset;
                }
                catch { }
                try
                {
                    Parameter has = type.get_Parameter(BuiltInParameter.RAILING_SYSTEM_HAS_TOP_RAIL);
                    bool hasTop = has != null ? has.AsInteger() == 1 : type.TopRailType != ElementId.InvalidElementId;
                    if (hasTop) top = type.TopRailHeight + offset;
                }
                catch { }
            }
            row["handrail_height_mm"] = hand.HasValue ? (JToken)Mm(hand.Value) : JValue.CreateNull();
            row["top_rail_height_mm"] = top.HasValue ? (JToken)Mm(top.Value) : JValue.CreateNull();
            return row;
        }

        private static double? ParamDouble(Document doc, Element element, BuiltInParameter id)
        {
            Parameter p = element.get_Parameter(id);
            if ((p == null || !p.HasValue) && doc.GetElement(element.GetTypeId()) is Element type) p = type.get_Parameter(id);
            if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
            return p.AsDouble();
        }

        private static string TypeName(Document doc, Element element)
        {
            try { return doc.GetElement(element.GetTypeId())?.Name ?? ""; } catch { return ""; }
        }

        private static string LevelName(Document doc, Element element)
        {
            ElementId id = element.LevelId;
            if (id == null || id == ElementId.InvalidElementId)
            {
                Parameter p = element.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL) ?? element.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM);
                if (p != null && p.StorageType == StorageType.ElementId) id = p.AsElementId();
            }
            return id != null && id != ElementId.InvalidElementId ? (doc.GetElement(id)?.Name ?? "") : "";
        }

        private static bool Wants(JArray sources, string name)
        {
            if (sources == null || sources.Count == 0) return true;
            return sources.Any(token => string.Equals(token.ToString(), name, StringComparison.OrdinalIgnoreCase));
        }

        private static double Mm(double feet) => Math.Round(feet * FeetToMm, 1);
    }
}