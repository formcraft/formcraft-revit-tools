using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Facts for a BS 8666 bar bending schedule: every Rebar set with its mark, bar type, diameter, quantity, Revit bar
    /// length, shape name, shape dimensions A to F and R, layout and spacing, its host with the host cover settings, and the
    /// bar centre-line extents for a cover check. Read-only: nothing is started, nothing is rolled back, no parameter is
    /// written. The schedule maths, BS 8666 unit masses, shape-code lengths and the cover and spacing rules are in the
    /// server (server/src/fmc/rebar.ts), which has no Revit dependency and is unit tested.
    /// </summary>
    public class FmcRebarScheduleHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const int RebarCap = 5000;
        private const int PositionCap = 400;
        private static readonly string[] ShapeDims = { "A", "B", "C", "D", "E", "F", "R" };
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft rebar schedule";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_rebar_schedule needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (JToken token in Parameters["host_ids"] as JArray ?? new JArray())
                        if (!string.IsNullOrWhiteSpace(token.ToString())) hosts.Add(token.ToString().Trim());
                    var notes = new JArray();
                    var rows = new JArray();
                    var hostCache = new Dictionary<long, JObject>();
                    bool cut = false;
                    int inSystem = 0;
                    foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rebar).WhereElementIsNotElementType())
                    {
                        if (element is RebarInSystem) { inSystem++; }
                        if (!(element is Rebar) && !(element is RebarInSystem)) continue;
                        ElementId hostId = HostOf(element);
                        string hostKey = hostId == null || hostId == ElementId.InvalidElementId ? "" : hostId.Value.ToString();
                        if (hosts.Count > 0 && !hosts.Contains(hostKey)) continue;
                        if (rows.Count >= RebarCap) { cut = true; break; }
                        rows.Add(Row(doc, element, hostId, hostKey, hostCache));
                    }
                    if (cut) notes.Add("Rebar list stopped at " + RebarCap + " sets. Pass host_ids to read the rest.");
                    if (inSystem > 0) notes.Add(inSystem + " bar sets belong to area or path reinforcement. Their cover is from the bounding box.");
                    if (rows.Count == 0) notes.Add("No Rebar elements were found" + (hosts.Count > 0 ? " in those hosts." : "."));
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["applied"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["notes"] = notes,
                        ["rebars"] = rows,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static ElementId HostOf(Element element)
        {
            try
            {
                if (element is Rebar rebar) return rebar.GetHostId();
                if (element is RebarInSystem system) return system.GetHostId();
            }
            catch (Exception) { /* a free-standing bar has no host */ }
            return ElementId.InvalidElementId;
        }

        private static JObject Row(Document doc, Element element, ElementId hostId, string hostKey, Dictionary<long, JObject> hostCache)
        {
            ElementId typeId = element.GetTypeId();
            Element barType = typeId == null || typeId == ElementId.InvalidElementId ? null : doc.GetElement(typeId);
            double diameter = Mm(element.get_Parameter(BuiltInParameter.REBAR_BAR_DIAMETER))
                ?? Mm(barType?.get_Parameter(BuiltInParameter.REBAR_BAR_DIAMETER))
                ?? 0;
            var row = new JObject
            {
                ["id"] = element.Id.Value.ToString(),
                ["kind"] = element is RebarInSystem ? "rebar_in_system" : "rebar",
                ["mark"] = MarkOf(element),
                ["bar_type"] = barType?.Name ?? "",
                ["diameter_mm"] = Round(diameter),
                ["quantity"] = Int(element.get_Parameter(BuiltInParameter.REBAR_ELEM_QUANTITY_OF_BARS)) ?? 1,
                ["bar_length_mm"] = OrNull(Mm(element.get_Parameter(BuiltInParameter.REBAR_ELEM_LENGTH))),
                ["total_length_mm"] = OrNull(Mm(element.get_Parameter(BuiltInParameter.REBAR_ELEM_TOTAL_LENGTH))),
                ["shape"] = ShapeName(doc, element),
                ["dims"] = Dims(element),
                ["layout"] = LayoutOf(element),
                ["spacing_mm"] = OrNull(Mm(element.get_Parameter(BuiltInParameter.REBAR_ELEM_BAR_SPACING))),
                ["host_id"] = hostKey,
            };
            if (hostKey.Length > 0)
            {
                long hostValue = hostId.Value;
                if (!hostCache.TryGetValue(hostValue, out JObject host))
                {
                    host = HostFacts(doc, doc.GetElement(hostId));
                    hostCache[hostValue] = host;
                }
                foreach (var pair in host) row[pair.Key] = pair.Value?.DeepClone();
            }
            if (element is Rebar bar && CentreLineBox(bar, out XYZ min, out XYZ max))
            {
                row["centerline_min"] = Vec(min);
                row["centerline_max"] = Vec(max);
            }
            else
            {
                // Area and path reinforcement: the box includes the bar, so a bar radius is taken off.
                BoundingBoxXYZ box = element.get_BoundingBox(null);
                if (box != null)
                {
                    double r = diameter / 2 / FeetToMm;
                    row["centerline_min"] = Vec(new XYZ(box.Min.X + r, box.Min.Y + r, box.Min.Z + r));
                    row["centerline_max"] = Vec(new XYZ(box.Max.X - r, box.Max.Y - r, box.Max.Z - r));
                    row["cover_method"] = "bbox";
                }
            }
            return row;
        }

        private static JObject HostFacts(Document doc, Element host)
        {
            var facts = new JObject();
            if (host == null) return facts;
            facts["host_category"] = host.Category?.Name ?? "";
            facts["host_mark"] = host.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "";
            ElementId typeId = host.GetTypeId();
            facts["host_type"] = typeId == null || typeId == ElementId.InvalidElementId ? "" : (doc.GetElement(typeId)?.Name ?? "");
            facts["host_cover_mm"] = new JObject
            {
                ["top"] = OrNull(Cover(doc, host, BuiltInParameter.CLEAR_COVER_TOP)),
                ["bottom"] = OrNull(Cover(doc, host, BuiltInParameter.CLEAR_COVER_BOTTOM)),
                ["other"] = OrNull(Cover(doc, host, BuiltInParameter.CLEAR_COVER_OTHER)),
            };
            BoundingBoxXYZ box = host.get_BoundingBox(null);
            if (box != null)
            {
                facts["host_min"] = Vec(box.Min);
                facts["host_max"] = Vec(box.Max);
            }
            return facts;
        }

        private static double? Cover(Document doc, Element host, BuiltInParameter which)
        {
            Parameter p = host.get_Parameter(which);
            if (p == null || p.StorageType != StorageType.ElementId) return null;
            ElementId id = p.AsElementId();
            if (id == null || id == ElementId.InvalidElementId) return null;
            return doc.GetElement(id) is RebarCoverType cover ? Round(cover.CoverDistance * FeetToMm) : (double?)null;
        }

        /// <summary>Extents of every bar centre line in the set, with hooks and bends, in model coordinates.</summary>
        private static bool CentreLineBox(Rebar rebar, out XYZ min, out XYZ max)
        {
            min = null;
            max = null;
            double x0 = double.MaxValue, y0 = double.MaxValue, z0 = double.MaxValue;
            double x1 = double.MinValue, y1 = double.MinValue, z1 = double.MinValue;
            bool any = false;
            try
            {
                int positions = Math.Min(rebar.NumberOfBarPositions, PositionCap);
                for (int i = 0; i < positions; i++)
                {
                    if (!rebar.DoesBarExistAtPosition(i)) continue;
                    IList<Curve> curves = rebar.GetTransformedCenterlineCurves(false, false, false, MultiplanarOption.IncludeAllMultiplanarCurves, i);
                    foreach (Curve curve in curves)
                    {
                        foreach (XYZ point in curve.Tessellate())
                        {
                            any = true;
                            x0 = Math.Min(x0, point.X); y0 = Math.Min(y0, point.Y); z0 = Math.Min(z0, point.Z);
                            x1 = Math.Max(x1, point.X); y1 = Math.Max(y1, point.Y); z1 = Math.Max(z1, point.Z);
                        }
                    }
                }
            }
            catch (Exception) { any = false; }
            if (!any) return false;
            min = new XYZ(x0, y0, z0);
            max = new XYZ(x1, y1, z1);
            return true;
        }

        private static string MarkOf(Element element)
        {
            foreach (string name in new[] { "Schedule Mark", "Bar Mark", "Rebar Number" })
            {
                string value = Text(element.LookupParameter(name));
                if (value.Length > 0) return value;
            }
            return Text(element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK));
        }

        private static string ShapeName(Document doc, Element element)
        {
            Parameter p = element.get_Parameter(BuiltInParameter.REBAR_SHAPE);
            if (p != null && p.StorageType == StorageType.ElementId)
            {
                Element shape = doc.GetElement(p.AsElementId());
                if (shape != null) return shape.Name ?? "";
            }
            return p == null ? "" : Text(p);
        }

        private static JObject Dims(Element element)
        {
            var dims = new JObject();
            foreach (string name in ShapeDims)
            {
                Parameter p = element.LookupParameter(name);
                if (p == null || p.StorageType != StorageType.Double || !p.HasValue) continue;
                dims[name] = Round(p.AsDouble() * FeetToMm);
            }
            return dims;
        }

        private static string LayoutOf(Element element)
        {
            if (!(element is Rebar rebar)) return "system";
            try
            {
                switch (rebar.LayoutRule)
                {
                    case RebarLayoutRule.Single: return "single";
                    case RebarLayoutRule.FixedNumber: return "fixed_number";
                    case RebarLayoutRule.MaximumSpacing: return "maximum_spacing";
                    case RebarLayoutRule.NumberWithSpacing: return "number_with_spacing";
                    case RebarLayoutRule.MinimumClearSpacing: return "minimum_clear_spacing";
                    default: return rebar.LayoutRule.ToString();
                }
            }
            catch (Exception) { return ""; }
        }

        private static string Text(Parameter p)
        {
            if (p == null || !p.HasValue) return "";
            string value = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString();
            return (value ?? "").Trim();
        }

        private static double? Mm(Parameter p)
        {
            if (p == null || p.StorageType != StorageType.Double || !p.HasValue) return null;
            return p.AsDouble() * FeetToMm;
        }

        private static int? Int(Parameter p)
        {
            if (p == null || !p.HasValue) return null;
            if (p.StorageType == StorageType.Integer) return p.AsInteger();
            if (p.StorageType == StorageType.Double) return (int)Math.Round(p.AsDouble());
            return null;
        }

        private static JToken OrNull(double? value) => value.HasValue ? (JToken)Round(value.Value) : JValue.CreateNull();
        private static double Round(double value) => Math.Round(value, 1);
        private static JArray Vec(XYZ p) => new JArray(Round(p.X * FeetToMm), Round(p.Y * FeetToMm), Round(p.Z * FeetToMm));
    }
}
