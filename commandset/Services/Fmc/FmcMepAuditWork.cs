using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_mep_audit (Builder 19): read-only MEP connectivity and system audit. Opens no transaction and changes nothing.
    /// Open End connectors on pipe, duct, flex, fittings and accessories (ConnectorManager.UnusedConnectors, cross-checked
    /// both ways with PlumbingUtils.HasOpenConnector on piping) and on mechanical equipment, plumbing fixtures, sprinklers
    /// and air terminals, as a cross-check of fmc_trace's open_end; one row per piping and mechanical system with
    /// IsWellConnected, BaseEquipment, flow, static pressure, critical-path pressure loss with its MEPSection rows, and
    /// fixture units. Conduit and cable tray are left to fmc_conduit and fmc_trace.
    /// The server (server/src/fmc/mepaudit.ts) classifies issues, summarises and caps.
    /// </summary>
    public class FmcMepAuditHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const int ConnectorCap = 20000;
        private const int SystemCap = 5000;
        private const int SectionCap = 100;
        private const int LevelCap = 20;
        private const int SectionElementCap = 50;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft MEP audit";

        private static readonly BuiltInCategory[] PipingCategories =
        {
            BuiltInCategory.OST_PipeCurves, BuiltInCategory.OST_FlexPipeCurves, BuiltInCategory.OST_PipeFitting,
            BuiltInCategory.OST_PipeAccessory, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_Sprinklers,
        };

        private static readonly BuiltInCategory[] DuctCategories =
        {
            BuiltInCategory.OST_DuctCurves, BuiltInCategory.OST_FlexDuctCurves, BuiltInCategory.OST_DuctFitting,
            BuiltInCategory.OST_DuctAccessory, BuiltInCategory.OST_DuctTerminal,
        };

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string domain = (Parameters.Value<string>("domain") ?? "both").Trim().ToLowerInvariant();
                    bool piping = domain != "duct";
                    bool duct = domain != "piping";
                    bool includeEquipment = Parameters.Value<bool?>("include_equipment") ?? true;
                    bool analysis = Parameters.Value<bool?>("analysis") ?? true;
                    var systemFilter = Strings(Parameters["systems"]);
                    var levelFilter = Strings(Parameters["levels"]);
                    var notes = new JArray();
                    var skipped = new FmcNonFamily();

                    // ---- open connectors ----
                    var categories = new List<BuiltInCategory>();
                    if (piping) categories.AddRange(PipingCategories);
                    if (duct) categories.AddRange(DuctCategories);
                    if (includeEquipment) categories.Add(BuiltInCategory.OST_MechanicalEquipment);
                    if (!includeEquipment)
                    {
                        categories.Remove(BuiltInCategory.OST_PlumbingFixtures);
                        categories.Remove(BuiltInCategory.OST_Sprinklers);
                        categories.Remove(BuiltInCategory.OST_DuctTerminal);
                    }

                    var open = new JArray();
                    int elements = 0, connectorsSeen = 0;
                    bool connectorsTruncated = false;
                    var plumbingOpenCache = new Dictionary<long, bool?>();
                    var withUnusedPipingEnd = new HashSet<long>();
                    var plumbingOnly = new JArray();
                    foreach (Element element in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(categories)).WhereElementIsNotElementType())
                    {
                        if (element is not MEPCurve && element is not FamilyInstance)
                        {
                            skipped.Add(element);
                            continue;
                        }
                        ConnectorManager manager = null;
                        try { manager = element is MEPCurve curve ? curve.ConnectorManager : ((FamilyInstance)element).MEPModel?.ConnectorManager; }
                        catch (Exception) { manager = null; }
                        if (manager == null) continue;
                        elements++;
                        string kind = Kind(element);
                        string level = null;
                        bool pipingNetwork = piping && IsPipingNetwork(element) && (kind == "curve" || kind == "fitting" || kind == "accessory");
                        if (pipingNetwork)
                        {
                            long key = element.Id.Value;
                            bool? open0 = null;
                            try { open0 = PlumbingUtils.HasOpenConnector(doc, element.Id); } catch (Exception) { open0 = null; }
                            plumbingOpenCache[key] = open0;
                        }
                        ConnectorSet unused;
                        try { unused = manager.UnusedConnectors; }
                        catch (Exception) { skipped.Add(element); continue; }
                        foreach (Connector connector in unused)
                        {
                            connectorsSeen++;
                            try
                            {
                                if (connector.ConnectorType != ConnectorType.End) continue;
                                string connectorDomain = DomainName(connector.Domain);
                                if (connectorDomain == null) continue; // electrical, conduit, cable tray: out of scope
                                if (connectorDomain == "piping" && !piping) continue;
                                if (connectorDomain == "duct" && !duct) continue;
                                bool connected = false;
                                try { connected = connector.IsConnected; } catch (Exception) { connected = false; }
                                if (connected) continue;
                                if (connectorDomain == "piping") withUnusedPipingEnd.Add(element.Id.Value);

                                MEPSystem system = null;
                                try { system = connector.MEPSystem; } catch (Exception) { system = null; }
                                if (systemFilter.Count > 0 && !Matches(systemFilter, system?.Id.Value, system?.Name)) continue;
                                level ??= LevelName(doc, element);
                                if (levelFilter.Count > 0 && !levelFilter.Contains(level.ToLowerInvariant())) continue;

                                if (open.Count >= ConnectorCap) { connectorsTruncated = true; break; }

                                bool? plumbingOpen = null;
                                if (connectorDomain == "piping" && (kind == "curve" || kind == "fitting" || kind == "accessory"))
                                {
                                    plumbingOpenCache.TryGetValue(element.Id.Value, out plumbingOpen);
                                }

                                ElementId typeId = element.GetTypeId();
                                var row = new JObject
                                {
                                    ["element_id"] = element.Id.Value,
                                    ["connector_index"] = connector.Id,
                                    ["domain"] = connectorDomain,
                                    ["kind"] = kind,
                                    ["category"] = element.Category?.Name ?? "",
                                    ["family"] = (element as FamilyInstance)?.Symbol?.FamilyName ?? "",
                                    ["type_name"] = (doc.GetElement(typeId) as ElementType)?.Name ?? "",
                                    ["level"] = level,
                                    ["system_id"] = system == null ? null : (JToken)system.Id.Value,
                                    ["system_name"] = system?.Name ?? "",
                                    ["plumbing_open"] = plumbingOpen.HasValue ? (JToken)plumbingOpen.Value : null,
                                };
                                AddSize(row, connector);
                                try { row["origin_mm"] = new JArray(Math.Round(connector.Origin.X * FeetToMm, 1), Math.Round(connector.Origin.Y * FeetToMm, 1), Math.Round(connector.Origin.Z * FeetToMm, 1)); }
                                catch (Exception) { row["origin_mm"] = new JArray(); }
                                open.Add(row);
                            }
                            catch (Exception) { skipped.Add(element); }
                        }
                        if (connectorsTruncated) break;
                        if (pipingNetwork && plumbingOpenCache.TryGetValue(element.Id.Value, out bool? hasOpen) && hasOpen == true
                            && !withUnusedPipingEnd.Contains(element.Id.Value) && plumbingOnly.Count < ConnectorCap)
                        {
                            level ??= LevelName(doc, element);
                            if (levelFilter.Count == 0 || levelFilter.Contains(level.ToLowerInvariant()))
                            {
                                MEPSystem pipeSystem = null;
                                try { pipeSystem = (element as MEPCurve)?.MEPSystem; } catch (Exception) { pipeSystem = null; }
                                if (systemFilter.Count == 0 || Matches(systemFilter, pipeSystem?.Id.Value, pipeSystem?.Name))
                                    plumbingOnly.Add(new JObject
                                    {
                                        ["element_id"] = element.Id.Value,
                                        ["kind"] = kind,
                                        ["level"] = level,
                                        ["type_name"] = (doc.GetElement(element.GetTypeId()) as ElementType)?.Name ?? "",
                                        ["system_name"] = pipeSystem?.Name ?? "",
                                    });
                            }
                        }
                    }

                    // ---- systems ----
                    var systems = new JArray();
                    int systemsSeen = 0;
                    bool systemsTruncated = false;
                    var all = new List<MEPSystem>();
                    if (piping) all.AddRange(new FilteredElementCollector(doc).OfClass(typeof(PipingSystem)).Cast<MEPSystem>());
                    if (duct) all.AddRange(new FilteredElementCollector(doc).OfClass(typeof(MechanicalSystem)).Cast<MEPSystem>());
                    foreach (MEPSystem system in all)
                    {
                        systemsSeen++;
                        try
                        {
                            if (systemFilter.Count > 0 && !Matches(systemFilter, system.Id.Value, system.Name)) continue;
                            JObject row = SystemRow(doc, system, analysis);
                            if (levelFilter.Count > 0)
                            {
                                var levels = ((JArray)row["levels"]).Select(t => (t.Value<string>() ?? "").ToLowerInvariant());
                                if (!levels.Any(levelFilter.Contains)) continue;
                            }
                            if (systems.Count >= SystemCap) { systemsTruncated = true; break; }
                            systems.Add(row);
                        }
                        catch (Exception ex) { notes.Add("System " + system.Id.Value + " not read: " + ex.Message); }
                    }

                    // ---- plumbing fixtures for fmc_calc's facts_file (CA-P-01 water demand, CA-P-02 drainage) ----
                    var fixtures = new JArray();
                    if (piping)
                    {
                        foreach (FamilyInstance fixture in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_PlumbingFixtures).WhereElementIsNotElementType().OfType<FamilyInstance>())
                        {
                            if (fixtures.Count >= SystemCap) { notes.Add("plumbing fixtures capped at " + SystemCap); break; }
                            try
                            {
                                string fixtureLevel = LevelName(doc, fixture);
                                if (levelFilter.Count > 0 && !levelFilter.Contains(fixtureLevel.ToLowerInvariant())) continue;
                                string pipeSystem = FixturePipeSystem(fixture, out long? pipeSystemId);
                                if (systemFilter.Count > 0 && !Matches(systemFilter, pipeSystemId, pipeSystem)) continue;
                                fixtures.Add(new JObject
                                {
                                    ["id"] = fixture.Id.Value,
                                    ["family"] = fixture.Symbol?.FamilyName ?? "",
                                    ["type"] = fixture.Symbol?.Name ?? fixture.Name ?? "",
                                    ["level"] = fixtureLevel,
                                    ["room"] = FixtureRoom(doc, fixture),
                                    ["du"] = DischargeUnits(fixture),
                                    ["pipe_system"] = pipeSystem,
                                });
                            }
                            catch (Exception) { skipped.Add(fixture); }
                        }
                    }

                    notes.Add("CriticalPathCollector (Autodesk.Revit.DB.Analysis) needs an MEPNetworkSegmentId from the systems-analysis model and is not used; the critical path is MEPSystem.PressureLossOfCriticalPath, GetCriticalPathSectionNumbers and MEPSystem.GetSectionByNumber (MEPSection TotalPressureLoss, Flow, TotalCurveLength).");
                    notes.Add("Flow, static pressure and fixture units come from Revit's own system calculation (GetFlow, GetStaticPressure, GetFixtureUnits); they are only valid when the system is well connected.");

                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["read_only"] = true;
                    Result["open_connectors"] = open;
                    Result["plumbing_only_open"] = plumbingOnly;
                    Result["systems"] = systems;
                    Result["plumbing_fixtures"] = fixtures;
                    Result["scanned"] = new JObject { ["elements"] = elements, ["connectors"] = connectorsSeen, ["systems"] = systemsSeen };
                    Result["truncated"] = new JObject { ["connectors"] = connectorsTruncated, ["systems"] = systemsTruncated };
                    Result["skipped_non_family"] = skipped.Report();
                    Result["api_notes"] = notes;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject SystemRow(Document doc, MEPSystem system, bool analysis)
        {
            var pipingSystem = system as PipingSystem;
            var mechanicalSystem = system as MechanicalSystem;
            string classification = "";
            bool? wellConnected = null;
            try
            {
                if (pipingSystem != null) { classification = pipingSystem.SystemType.ToString(); wellConnected = pipingSystem.IsWellConnected; }
                else if (mechanicalSystem != null) { classification = mechanicalSystem.SystemType.ToString(); wellConnected = mechanicalSystem.IsWellConnected; }
            }
            catch (Exception) { /* reported as null */ }

            bool? isValid = null, isEmpty = null;
            try { isValid = system.IsValid; } catch (Exception) { }
            try { isEmpty = system.IsEmpty; } catch (Exception) { }

            FamilyInstance baseEquipment = null;
            try { baseEquipment = system.BaseEquipment; } catch (Exception) { baseEquipment = null; }

            int? count = null;
            var levels = new List<string>();
            try
            {
                ElementSet members = system.Elements;
                count = members.Size;
                foreach (Element member in members)
                {
                    if (levels.Count >= LevelCap) break;
                    string name = LevelName(doc, member);
                    if (name.Length > 0 && !levels.Contains(name)) levels.Add(name);
                }
            }
            catch (Exception) { /* membership unreadable on a broken system */ }

            var notes = new JArray();
            double? flow = null, staticPressure = null, criticalLoss = null, fixtureUnits = null;
            var sections = new JArray();
            var criticalPath = new JArray();
            if (!analysis) notes.Add("analysis off");
            else if (wellConnected != true) notes.Add("not well connected: calculated values not read");
            else
            {
                try
                {
                    double raw = pipingSystem != null ? pipingSystem.GetFlow() : mechanicalSystem.GetFlow();
                    flow = UnitUtils.ConvertFromInternalUnits(raw, UnitTypeId.LitersPerSecond);
                }
                catch (Exception ex) { notes.Add("flow: " + ex.Message); }
                try
                {
                    double raw = pipingSystem != null ? pipingSystem.GetStaticPressure() : mechanicalSystem.GetStaticPressure();
                    staticPressure = UnitUtils.ConvertFromInternalUnits(raw, UnitTypeId.Pascals);
                }
                catch (Exception ex) { notes.Add("static pressure: " + ex.Message); }
                try { criticalLoss = UnitUtils.ConvertFromInternalUnits(system.PressureLossOfCriticalPath, UnitTypeId.Pascals); }
                catch (Exception ex) { notes.Add("critical path loss: " + ex.Message); }
                try
                {
                    IList<int> numbers = system.GetCriticalPathSectionNumbers();
                    if (numbers != null)
                        foreach (int n in numbers.Take(SectionCap))
                        {
                            sections.Add(n);
                            try { criticalPath.Add(SectionRow(doc, system, n)); }
                            catch (Exception ex) { notes.Add("section " + n + ": " + ex.Message); }
                        }
                }
                catch (Exception ex) { notes.Add("critical path sections: " + ex.Message); }
                if (pipingSystem != null)
                {
                    try { fixtureUnits = pipingSystem.GetFixtureUnits(); }
                    catch (Exception ex) { notes.Add("fixture units: " + ex.Message); }
                }
            }

            return new JObject
            {
                ["id"] = system.Id.Value,
                ["name"] = system.Name ?? "",
                ["domain"] = pipingSystem != null ? "piping" : "duct",
                ["classification"] = classification,
                ["system_type"] = (doc.GetElement(system.GetTypeId()) as ElementType)?.Name ?? "",
                ["is_well_connected"] = wellConnected.HasValue ? (JToken)wellConnected.Value : null,
                ["is_valid"] = isValid.HasValue ? (JToken)isValid.Value : null,
                ["is_empty"] = isEmpty.HasValue ? (JToken)isEmpty.Value : null,
                ["base_equipment_id"] = baseEquipment == null ? null : (JToken)baseEquipment.Id.Value,
                ["base_equipment_name"] = baseEquipment == null ? "" : ((baseEquipment.Symbol?.FamilyName ?? "") + " " + baseEquipment.Name).Trim(),
                ["element_count"] = count.HasValue ? (JToken)count.Value : null,
                ["levels"] = new JArray(levels),
                ["flow_lps"] = Num(flow, 4),
                ["static_pressure_pa"] = Num(staticPressure, 2),
                ["critical_path_pressure_loss_pa"] = Num(criticalLoss, 2),
                ["critical_path_sections"] = sections,
                ["critical_path"] = criticalPath,
                ["fixture_units"] = Num(fixtureUnits, 2),
                ["calc_notes"] = notes,
            };
        }

        /// <summary>One MEPSection on the critical path, in SI units, with the size of its first pipe or duct.</summary>
        private static JObject SectionRow(Document doc, MEPSystem system, int number)
        {
            MEPSection section = system.GetSectionByNumber(number);
            var row = new JObject { ["number"] = number };
            if (section == null) return row;
            double? flow = null, length = null, loss = null, velocity = null, roughness = null, coefficient = null, units = null;
            try { flow = UnitUtils.ConvertFromInternalUnits(section.Flow, UnitTypeId.LitersPerSecond); } catch (Exception) { }
            try { length = UnitUtils.ConvertFromInternalUnits(section.TotalCurveLength, UnitTypeId.Meters); } catch (Exception) { }
            try { loss = UnitUtils.ConvertFromInternalUnits(section.TotalPressureLoss, UnitTypeId.Pascals); } catch (Exception) { }
            try { velocity = UnitUtils.ConvertFromInternalUnits(section.Velocity, UnitTypeId.MetersPerSecond); } catch (Exception) { }
            try { roughness = UnitUtils.ConvertFromInternalUnits(section.Roughness, UnitTypeId.Millimeters); } catch (Exception) { }
            try { coefficient = section.TotalCoefficient; } catch (Exception) { }
            try { units = section.FixtureUnit; } catch (Exception) { }
            row["flow_lps"] = Num(flow, 4);
            row["length_m"] = Num(length, 3);
            row["pressure_loss_pa"] = Num(loss, 2);
            row["velocity_ms"] = Num(velocity, 3);
            row["roughness_mm"] = Num(roughness, 4);
            row["total_coefficient"] = Num(coefficient, 3);
            row["fixture_units"] = Num(units, 2);
            var ids = new JArray();
            int count = 0;
            try
            {
                foreach (ElementId id in section.GetElementIds())
                {
                    count++;
                    if (ids.Count < SectionElementCap) ids.Add(id.Value);
                    if (row["shape"] == null && doc.GetElement(id) is MEPCurve curve) AddCurveSize(row, curve);
                }
            }
            catch (Exception) { /* membership unreadable */ }
            row["element_count"] = count;
            row["element_ids"] = ids;
            return row;
        }

        private static void AddCurveSize(JObject row, MEPCurve curve)
        {
            try
            {
                double? Mm(BuiltInParameter p)
                {
                    Parameter value = curve.get_Parameter(p);
                    if (value == null || !value.HasValue) return null;
                    return Math.Round(UnitUtils.ConvertFromInternalUnits(value.AsDouble(), UnitTypeId.Millimeters), 1);
                }
                if (curve is Pipe)
                {
                    double? inner = Mm(BuiltInParameter.RBS_PIPE_INNER_DIAM_PARAM) ?? Mm(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
                    if (inner.HasValue) { row["shape"] = "round"; row["size_mm"] = inner.Value; }
                    return;
                }
                if (curve is Duct)
                {
                    double? diameter = Mm(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                    if (diameter.HasValue && diameter.Value > 0) { row["shape"] = "round"; row["size_mm"] = diameter.Value; return; }
                    double? w = Mm(BuiltInParameter.RBS_CURVE_WIDTH_PARAM), h = Mm(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
                    if (w.HasValue && h.HasValue) { row["shape"] = "rect"; row["w_mm"] = w.Value; row["h_mm"] = h.Value; }
                }
            }
            catch (Exception) { /* size unreadable: fmc_mep_size asks the engineer */ }
        }

        /// <summary>FMC_Discharge_Units, the same parameter fmc_mep_facts reads; null when the fixture has none.</summary>
        private static JToken DischargeUnits(FamilyInstance fixture)
        {
            Parameter p = fixture.LookupParameter("FMC_Discharge_Units") ?? fixture.Symbol?.LookupParameter("FMC_Discharge_Units");
            if (p == null || !p.HasValue) return null;
            if (p.StorageType == StorageType.Double) return Math.Round(p.AsDouble(), 3);
            if (p.StorageType == StorageType.Integer) return p.AsInteger();
            if (p.StorageType == StorageType.String && double.TryParse(p.AsString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double v)) return v;
            return null;
        }

        private static string FixturePipeSystem(FamilyInstance fixture, out long? systemId)
        {
            systemId = null;
            try
            {
                ConnectorManager manager = fixture.MEPModel?.ConnectorManager;
                if (manager == null) return "";
                foreach (Connector connector in manager.Connectors)
                {
                    if (connector.Domain != Domain.DomainPiping) continue;
                    MEPSystem system = null;
                    try { system = connector.MEPSystem; } catch (Exception) { system = null; }
                    if (system == null) continue;
                    systemId = system.Id.Value;
                    return system.Name ?? "";
                }
            }
            catch (Exception) { /* no piping connector */ }
            return "";
        }

        private static string FixtureRoom(Document doc, FamilyInstance fixture)
        {
            try
            {
                Autodesk.Revit.DB.Architecture.Room room = fixture.Room;
                if (room == null) return "";
                string number = room.Number ?? "";
                string name = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? room.Name ?? "";
                return (number + " " + name).Trim();
            }
            catch (Exception) { return ""; }
        }

        private static bool IsPipingNetwork(Element element)
        {
            long category = element.Category?.Id.Value ?? 0;
            return category == (long)BuiltInCategory.OST_PipeCurves || category == (long)BuiltInCategory.OST_FlexPipeCurves
                || category == (long)BuiltInCategory.OST_PipeFitting || category == (long)BuiltInCategory.OST_PipeAccessory;
        }

        private static JToken Num(double? value, int digits)
        {
            if (!value.HasValue || double.IsNaN(value.Value) || double.IsInfinity(value.Value)) return null;
            return Math.Round(value.Value, digits);
        }

        private static string Kind(Element element)
        {
            if (element is MEPCurve) return "curve";
            long category = element.Category?.Id.Value ?? 0;
            if (category == (long)BuiltInCategory.OST_PipeFitting || category == (long)BuiltInCategory.OST_DuctFitting) return "fitting";
            if (category == (long)BuiltInCategory.OST_PipeAccessory || category == (long)BuiltInCategory.OST_DuctAccessory) return "accessory";
            if (category == (long)BuiltInCategory.OST_PlumbingFixtures || category == (long)BuiltInCategory.OST_Sprinklers) return "fixture";
            if (category == (long)BuiltInCategory.OST_DuctTerminal) return "terminal";
            return "equipment";
        }

        private static string DomainName(Domain domain)
        {
            if (domain == Domain.DomainPiping) return "piping";
            if (domain == Domain.DomainHvac) return "duct";
            return null;
        }

        private static void AddSize(JObject row, Connector connector)
        {
            try
            {
                if (connector.Shape == ConnectorProfileType.Round)
                {
                    row["size_mm"] = Math.Round(connector.Radius * 2 * FeetToMm, 1);
                    return;
                }
                row["size_mm"] = null;
                row["width_mm"] = Math.Round(connector.Width * FeetToMm, 1);
                row["height_mm"] = Math.Round(connector.Height * FeetToMm, 1);
            }
            catch (Exception) { row["size_mm"] = null; }
        }

        private static string LevelName(Document doc, Element element)
        {
            try
            {
                if (element is MEPCurve curve && curve.ReferenceLevel != null) return curve.ReferenceLevel.Name ?? "";
                ElementId id = element.LevelId;
                if (id == null || id == ElementId.InvalidElementId)
                {
                    Parameter p = element.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)
                        ?? element.get_Parameter(BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM)
                        ?? element.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
                    id = p?.AsElementId();
                }
                if (id == null || id == ElementId.InvalidElementId) return "";
                return (doc.GetElement(id) as Level)?.Name ?? "";
            }
            catch (Exception) { return ""; }
        }

        private static HashSet<string> Strings(JToken token)
        {
            var set = new HashSet<string>();
            if (token is JArray array)
                foreach (JToken t in array)
                {
                    string s = (t?.ToString() ?? "").Trim().ToLowerInvariant();
                    if (s.Length > 0) set.Add(s);
                }
            return set;
        }

        private static bool Matches(HashSet<string> filter, long? id, string name)
        {
            if (filter.Count == 0) return true;
            if (!string.IsNullOrEmpty(name) && filter.Contains(name.Trim().ToLowerInvariant())) return true;
            return id.HasValue && filter.Contains(id.Value.ToString());
        }
    }
}
