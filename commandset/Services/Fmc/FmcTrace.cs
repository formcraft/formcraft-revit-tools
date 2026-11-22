using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Fabrication;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_trace on the Revit thread. Snapshot reads ConnectorManager, AllRefs, piping and duct systems,
    /// and ElectricalSystem. Highlight, when asked, calls IsolateElementsTemporary on the view that is
    /// already active. Neither path starts a transaction, checks out elements, saves, or switches the
    /// active document or view. A closed file is not opened (that would detach a workshared local).
    /// Phase 2 checks add a collector beside CollectFlow and CollectElectrical. They stay read-only.
    /// </summary>
    public class FmcTraceHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const int Cap = 100000;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);

        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _done.Reset();
            return FmcBusy.Wait(_done, timeoutMilliseconds);
        }

        public string GetName() => "Formcraft systems flow tracer";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    if (target.Doc.IsFamilyDocument) throw new InvalidOperationException("fmc_trace runs on a project model.");
                    bool modifiedBefore = target.Doc.IsModified;
                    string mode = (Parameters.Value<string>("mode") ?? "snapshot").Trim().ToLowerInvariant();
                    Result = mode == "highlight" ? Highlight(target) : Snapshot(target.Doc);
                    Result["model"] = target.Doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(target.Doc);
                    Result["read_only"] = true;
                    Result["is_workshared"] = target.Doc.IsWorkshared;
                    Result["is_central"] = IsCentral(target.Doc);
                    Result["modified_during_call"] = !modifiedBefore && target.Doc.IsModified;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        private JObject Highlight(FmcTarget target)
        {
            var ids = new List<ElementId>();
            foreach (JToken token in Parameters["ids"] as JArray ?? new JArray())
            {
                if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float) continue;
                long id = token.Value<long>();
                if (id <= 0) continue;
                ElementId eid = new ElementId(id);
                if (target.Doc.GetElement(eid) != null) ids.Add(eid);
                if (ids.Count >= 2000) break;
            }
            if (target.Ui == null)
                return new JObject
                {
                    ["applied"] = false,
                    ["reason"] = "This document is not the active document. The active document was not changed.",
                    ["saved"] = false,
                };
            if (ids.Count == 0) return new JObject { ["applied"] = false, ["reason"] = "Nothing to highlight.", ["saved"] = false };
            View view = target.Ui.ActiveView;
            string viewId = view?.UniqueId ?? "";
            try
            {
                // Temporary view mode. Revit does not save it with the model. No transaction.
                view.IsolateElementsTemporary(ids);
            }
            catch (Exception ex)
            {
                return new JObject { ["applied"] = false, ["reason"] = ex.Message, ["saved"] = false };
            }
            bool sameView = (target.Ui.ActiveView?.UniqueId ?? "") == viewId;
            return new JObject { ["applied"] = true, ["count"] = ids.Count, ["view_unchanged"] = sameView, ["saved"] = false };
        }

        private JObject Snapshot(Document doc)
        {
            var want = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (JToken token in Parameters["checks"] as JArray ?? new JArray()) want.Add(token.ToString());
            var flowIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "leak", "missing", "drainage_fall", "venting", "cross_connection", "dead_legs", "pressure_flow", "counts", "recommend" };
            var elecIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "continuity", "missing", "voltage_drop", "overload", "phase_balance", "counts", "recommend" };
            bool flow = want.Count == 0 || want.Any(flowIds.Contains);
            bool electrical = want.Count == 0 || want.Any(elecIds.Contains);
            var result = new JObject { ["truncated"] = false, ["connectors_skipped"] = 0 };
            var state = new CollectState();
            if (flow) result["flow"] = CollectFlow(doc, state);
            if (electrical) result["electrical"] = CollectElectrical(doc, state);
            result["truncated"] = state.Truncated;
            result["connectors_skipped"] = state.Skipped;
            result["skipped_non_family"] = state.NonFamily.Report();
            if (state.Notes.Count > 0) result["notes"] = new JArray(state.Notes);
            return result;
        }

        private static readonly BuiltInCategory[] FlowCategories =
        {
            BuiltInCategory.OST_PipeCurves, BuiltInCategory.OST_FlexPipeCurves, BuiltInCategory.OST_PipeFitting,
            BuiltInCategory.OST_PipeAccessory, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_Sprinklers,
            BuiltInCategory.OST_DuctCurves, BuiltInCategory.OST_FlexDuctCurves, BuiltInCategory.OST_DuctFitting,
            BuiltInCategory.OST_DuctAccessory, BuiltInCategory.OST_DuctTerminal, BuiltInCategory.OST_MechanicalEquipment,
            BuiltInCategory.OST_PlumbingEquipment,
            BuiltInCategory.OST_Conduit, BuiltInCategory.OST_ConduitFitting,
            BuiltInCategory.OST_CableTray, BuiltInCategory.OST_CableTrayFitting,
        };

        private static JObject CollectFlow(Document doc, CollectState state)
        {
            var systems = new JArray();
            var members = new Dictionary<long, HashSet<long>>();
            void AddSystem(Element system, string domain, string classification, Element baseEquipment, IEnumerable<Element> owned)
            {
                if (state.Truncated) return;
                var ids = new HashSet<long>();
                if (owned != null)
                {
                    foreach (Element element in owned)
                    {
                        if (element == null) continue;
                        ids.Add(element.Id.Value);
                        if (!members.TryGetValue(element.Id.Value, out HashSet<long> set)) members[element.Id.Value] = set = new HashSet<long>();
                        set.Add(system.Id.Value);
                    }
                }
                long baseId = 0;
                if (baseEquipment != null)
                {
                    baseId = baseEquipment.Id.Value;
                    ids.Add(baseId);
                    if (!members.TryGetValue(baseId, out HashSet<long> set)) members[baseId] = set = new HashSet<long>();
                    set.Add(system.Id.Value);
                }
                systems.Add(new JObject
                {
                    ["id"] = system.Id.Value,
                    ["name"] = Short(system.Name),
                    ["domain"] = domain,
                    ["classification"] = classification ?? "",
                    ["base_equipment_id"] = baseId,
                    ["element_ids"] = new JArray(ids.ToArray()),
                });
            }

            foreach (PipingSystem system in new FilteredElementCollector(doc).OfClass(typeof(PipingSystem)).OfType<PipingSystem>())
            {
                string classification = "";
                ElementSet owned = null;
                Element basis = null;
                try { classification = system.SystemType.ToString(); } catch (Exception) { /* unset */ }
                try { owned = system.Elements; } catch (Exception) { state.Note("A piping system could not list its elements."); }
                try { basis = system.BaseEquipment; } catch (Exception) { /* no base equipment */ }
                AddSystem(system, "piping", classification, basis, owned == null ? null : owned.OfType<Element>());
            }
            foreach (MechanicalSystem system in new FilteredElementCollector(doc).OfClass(typeof(MechanicalSystem)).OfType<MechanicalSystem>())
            {
                string classification = "";
                ElementSet owned = null;
                Element basis = null;
                try { classification = system.SystemType.ToString(); } catch (Exception) { /* unset */ }
                try { owned = system.Elements; } catch (Exception) { state.Note("A duct system could not list its elements."); }
                try { basis = system.BaseEquipment; } catch (Exception) { /* no base equipment */ }
                AddSystem(system, "hvac", classification, basis, owned == null ? null : owned.OfType<Element>());
            }

            var elements = new JArray();
            var connectors = new JArray();
            var seen = new HashSet<long>();
            void Take(Element element)
            {
                if (element == null || state.Truncated || !seen.Add(element.Id.Value)) return;
                if (elements.Count >= Cap || connectors.Count >= Cap) { state.Truncated = true; return; }
                // A DirectShape in a pipe, duct or fixture category has no family connectors. Casting it throws.
                if (element is not MEPCurve && element is not FamilyInstance && element is not FabricationPart)
                {
                    state.Skip(element);
                    return;
                }
                JArray found = ReadConnectors(element, state);
                if (found.Count == 0) return;
                members.TryGetValue(element.Id.Value, out HashSet<long> onSystems);
                var systemIds = onSystems == null ? new HashSet<long>() : new HashSet<long>(onSystems);
                bool piping = false, hvac = false, conduit = false, tray = false;
                foreach (JObject row in found.OfType<JObject>())
                {
                    string domain = row.Value<string>("domain") ?? "";
                    if (domain == "piping") piping = true;
                    if (domain == "hvac") hvac = true;
                    if (domain == "conduit") conduit = true;
                    if (domain == "tray") tray = true;
                    long sid = row.Value<long?>("system_id") ?? 0;
                    if (sid != 0) systemIds.Add(sid);
                    connectors.Add(row);
                    if (connectors.Count >= Cap) { state.Truncated = true; break; }
                }
                string elementDomain = piping && hvac ? "both" : hvac ? "hvac" : piping ? "piping" : tray && !conduit ? "tray" : conduit ? "conduit" : "piping";
                elements.Add(ElementRow(element, elementDomain, systemIds));
            }

            foreach (Element element in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(FlowCategories)).WhereElementIsNotElementType())
                Take(element);
            try
            {
                foreach (FabricationPart part in new FilteredElementCollector(doc).OfClass(typeof(FabricationPart)).WhereElementIsNotElementType().OfType<FabricationPart>())
                    Take(part);
            }
            catch (Exception)
            {
                state.Note("Fabrication parts were not read.");
            }
            return new JObject { ["elements"] = elements, ["connectors"] = connectors, ["systems"] = systems };
        }

        private static JObject CollectElectrical(Document doc, CollectState state)
        {
            var panels = new JArray();
            var panelDist = new Dictionary<long, string>();
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ElectricalEquipment).WhereElementIsNotElementType())
            {
                if (element is not FamilyInstance board)
                {
                    state.Skip(element);
                    continue;
                }
                string name = Text(board, BuiltInParameter.RBS_ELEC_PANEL_NAME);
                if (name.Length == 0) name = Short(board.Name);
                string distribution = Distribution(board);
                panelDist[board.Id.Value] = distribution;
                long supplyCircuit = 0, supplyFrom = 0;
                bool feeder = false;
                try
                {
                    ISet<ElectricalSystem> memberOf = board.MEPModel?.GetElectricalSystems();
                    if (memberOf != null)
                    {
                        foreach (ElectricalSystem system in memberOf)
                        {
                            if (!IsPower(system.SystemType) || system.BaseEquipment == null || system.BaseEquipment.Id == board.Id) continue;
                            supplyCircuit = system.Id.Value;
                            supplyFrom = system.BaseEquipment.Id.Value;
                            break;
                        }
                    }
                }
                catch (Exception) { state.Skipped++; }
                ConnectorManager manager = board.MEPModel?.ConnectorManager;
                if (manager != null)
                {
                    foreach (Connector connector in manager.Connectors)
                    {
                        try
                        {
                            if (connector.Domain != Domain.DomainElectrical || !connector.IsConnected) continue;
                            if (IsPower(connector.ElectricalSystemType)) feeder = true;
                        }
                        catch (Exception) { state.Skipped++; }
                    }
                }
                panels.Add(new JObject
                {
                    ["id"] = board.Id.Value,
                    ["name"] = name,
                    ["distribution"] = distribution,
                    ["voltage"] = Volts(board),
                    ["poles"] = Poles(board),
                    ["has_supply"] = supplyCircuit != 0 || feeder,
                    ["supply_circuit_id"] = supplyCircuit,
                    ["supply_from_id"] = supplyFrom,
                    ["main_a"] = MainAmps(board),
                    ["ways"] = Ways(board),
                });
            }

            var circuits = new JArray();
            foreach (ElectricalSystem system in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).OfType<ElectricalSystem>())
            {
                if (!IsPower(system.SystemType)) continue;
                long panelId = 0;
                try { if (system.BaseEquipment != null) panelId = system.BaseEquipment.Id.Value; } catch (Exception) { state.Skipped++; }
                var loads = new List<long>();
                try
                {
                    foreach (Element member in system.Elements)
                    {
                        if (member == null || member.Id.Value == panelId) continue;
                        loads.Add(member.Id.Value);
                    }
                }
                catch (Exception) { state.Note("A circuit could not list its loads."); }
                double voltage = 0, apparent = 0;
                int poles = 0;
                try { voltage = Math.Round(system.Voltage, 1); } catch (Exception) { /* unset */ }
                try { poles = system.PolesNumber; } catch (Exception) { /* unset */ }
                try { apparent = Math.Round(system.ApparentLoad, 1); } catch (Exception) { /* unset */ }
                string panelName = "";
                try { panelName = system.PanelName ?? ""; } catch (Exception) { /* unset */ }
                string number = "";
                try { number = system.CircuitNumber ?? ""; } catch (Exception) { /* unset */ }
                panelDist.TryGetValue(panelId, out string distribution);
                circuits.Add(new JObject
                {
                    ["id"] = system.Id.Value,
                    ["name"] = Short(system.Name),
                    ["number"] = number,
                    ["panel_id"] = panelId,
                    ["panel_name"] = panelName,
                    ["system_type"] = system.SystemType.ToString(),
                    ["voltage"] = voltage,
                    ["poles"] = poles,
                    ["distribution"] = distribution ?? "",
                    ["element_ids"] = new JArray(loads),
                    ["apparent_va"] = apparent,
                    ["rating_a"] = Measure(system, BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM, UnitTypeId.Amperes),
                    ["length_m"] = Measure(system, BuiltInParameter.RBS_ELEC_CIRCUIT_LENGTH_PARAM, UnitTypeId.Meters),
                    ["wire_size"] = system.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_SIZE_PARAM)?.AsString() ?? "",
                    ["phase"] = TextOf(system, "Phase").Length > 0 ? TextOf(system, "Phase") : TextOf(system, "FMC_Phase"),
                });
            }

            var devices = new JArray();
            var deviceCats = new[]
            {
                BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_LightingDevices,
                BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_SpecialityEquipment,
                BuiltInCategory.OST_FireAlarmDevices,
            };
            foreach (Element element in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(deviceCats)).WhereElementIsNotElementType())
            {
                if (element is not FamilyInstance device)
                {
                    state.Skip(element);
                    continue;
                }
                bool power = false;
                string ground = "absent";
                ConnectorManager manager = device.MEPModel?.ConnectorManager;
                if (manager != null)
                {
                    foreach (Connector connector in manager.Connectors)
                    {
                        try
                        {
                            if (connector.Domain != Domain.DomainElectrical) continue;
                            if (IsPower(connector.ElectricalSystemType)) power = true;
                            string described = "";
                            try { described = connector.Description ?? ""; } catch (Exception) { described = ""; }
                            if (System.Text.RegularExpressions.Regex.IsMatch(described, "ground|earth|cpc", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                            {
                                if (!connector.IsConnected) ground = "open";
                                else if (ground != "open") ground = "connected";
                            }
                        }
                        catch (Exception) { state.Skipped++; }
                    }
                }
                var circuitIds = new List<long>();
                try
                {
                    ISet<ElectricalSystem> on = device.MEPModel?.GetElectricalSystems();
                    if (on != null)
                        foreach (ElectricalSystem system in on)
                            if (IsPower(system.SystemType)) circuitIds.Add(system.Id.Value);
                }
                catch (Exception) { state.Skipped++; }
                if (!power && circuitIds.Count == 0) continue;
                devices.Add(new JObject
                {
                    ["id"] = device.Id.Value,
                    ["name"] = Short(device.Name),
                    ["category"] = device.Category?.Name ?? "",
                    ["voltage"] = Volts(device),
                    ["poles"] = Poles(device),
                    ["distribution"] = Distribution(device),
                    ["power_connector"] = power,
                    ["ground"] = ground,
                    ["circuit_ids"] = new JArray(circuitIds),
                });
            }
            return new JObject { ["panels"] = panels, ["circuits"] = circuits, ["devices"] = devices };
        }

        private static JArray ReadConnectors(Element element, CollectState state)
        {
            var rows = new JArray();
            ConnectorManager manager = Manager(element);
            if (manager == null) return rows;
            foreach (Connector connector in manager.Connectors)
            {
                try
                {
                    if (connector.Domain != Domain.DomainPiping && connector.Domain != Domain.DomainHvac && connector.Domain != Domain.DomainCableTrayConduit) continue;
                    // Layout nodes, logical connectors and super-system links are not pipe or duct joints.
                    if (connector.ConnectorType == ConnectorType.Logical || connector.ConnectorType == ConnectorType.Reference
                        || connector.ConnectorType == ConnectorType.Invalid || connector.ConnectorType == ConnectorType.NodeReference
                        || connector.ConnectorType == ConnectorType.Super || connector.ConnectorType == ConnectorType.NonEnd)
                        continue;
                    // Curve connectors are tap hosts. Every other physical connector can be an open end.
                    // Logical, reference and invalid connectors were skipped above.
                    bool curve = connector.ConnectorType == ConnectorType.Curve;
                    bool connected = false;
                    try { connected = connector.IsConnected; }
                    catch (Exception)
                    {
                        // IsConnected throws on some connectors. Record the end as unreadable rather than dropping it.
                        state.Skipped++;
                        connected = false;
                    }
                    string shape = "invalid";
                    double size = 0, height = 0;
                    try
                    {
                        shape = connector.Shape.ToString().ToLowerInvariant();
                        if (connector.Shape == ConnectorProfileType.Round) size = connector.Radius * 2 * FeetToMm;
                        else { size = connector.Width * FeetToMm; height = connector.Height * FeetToMm; }
                    }
                    catch (Exception) { /* a connector with no profile */ }
                    var direction = new JArray();
                    try
                    {
                        Transform frame = connector.CoordinateSystem;
                        if (frame != null) direction = new JArray(Round4(frame.BasisZ.X), Round4(frame.BasisZ.Y), Round4(frame.BasisZ.Z));
                    }
                    catch (Exception) { /* no axis */ }
                    string flow = "";
                    try { flow = connector.Direction.ToString().ToLowerInvariant(); } catch (Exception) { /* no flow */ }
                    long systemId = 0;
                    string systemClass = "";
                    try { if (connector.MEPSystem != null) systemId = connector.MEPSystem.Id.Value; } catch (Exception) { /* unset */ }
                    try
                    {
                        if (connector.Domain == Domain.DomainPiping) systemClass = connector.PipeSystemType.ToString();
                        else if (connector.Domain == Domain.DomainHvac) systemClass = connector.DuctSystemType.ToString();
                    }
                    catch (Exception) { /* a connector with no system class */ }
                    var refs = new JArray();
                    try
                    {
                        foreach (Connector other in connector.AllRefs)
                        {
                            if (other?.Owner == null) continue;
                            if (other.Owner.Id == element.Id && other.Id == connector.Id) continue;
                            refs.Add(new JArray(other.Owner.Id.Value, other.Id));
                        }
                    }
                    catch (Exception) { state.Skipped++; }
                    rows.Add(new JObject
                    {
                        ["element_id"] = element.Id.Value,
                        ["index"] = connector.Id,
                        ["domain"] = ConnectorDomain(element, connector),
                        ["origin"] = Point(connector.Origin),
                        ["direction"] = direction,
                        ["flow"] = flow,
                        ["shape"] = shape,
                        ["size_mm"] = Math.Round(size, 1),
                        ["height_mm"] = Math.Round(height, 1),
                        ["connected"] = connected,
                        ["type"] = curve ? "curve" : connector.ConnectorType == ConnectorType.End ? "end" : "other",
                        ["open_end"] = !curve && !connected,
                        ["system_id"] = systemId,
                        ["system_class"] = systemClass,
                        ["refs"] = refs,
                    });
                }
                catch (Exception)
                {
                    state.Skipped++;
                }
            }
            return rows;
        }

        private static string ConnectorDomain(Element element, Connector connector)
        {
            if (connector.Domain == Domain.DomainPiping) return "piping";
            if (connector.Domain == Domain.DomainHvac) return "hvac";
            long category = element?.Category?.Id.Value ?? 0;
            if (category == (long)BuiltInCategory.OST_CableTray || category == (long)BuiltInCategory.OST_CableTrayFitting) return "tray";
            return "conduit";
        }

        private static ConnectorManager Manager(Element element)
        {
            if (element is MEPCurve curve) return curve.ConnectorManager;
            if (element is FamilyInstance instance) return instance.MEPModel?.ConnectorManager;
            if (element is FabricationPart part) return part.ConnectorManager;
            return null;
        }

        private static JObject ElementRow(Element element, string domain, HashSet<long> systemIds)
        {
            var row = new JObject
            {
                ["id"] = element.Id.Value,
                ["name"] = Short(element.Name),
                ["category"] = element.Category?.Name ?? "",
                ["kind"] = Kind(element),
                ["domain"] = domain,
                ["system_ids"] = new JArray(systemIds.ToArray()),
            };
            BoundingBoxXYZ box = element.get_BoundingBox(null);
            if (box != null) row["bbox"] = new JArray(Mm(box.Min.X), Mm(box.Min.Y), Mm(box.Min.Z), Mm(box.Max.X), Mm(box.Max.Y), Mm(box.Max.Z));
            if (element.Location is LocationCurve located && located.Curve != null && located.Curve.IsBound)
                row["curve"] = new JArray(Point(located.Curve.GetEndPoint(0)), Point(located.Curve.GetEndPoint(1)));
            return row;
        }

        private static string Kind(Element element)
        {
            if (element is FabricationPart) return "fabrication";
            long category = element.Category?.Id.Value ?? 0;
            if (category == (long)BuiltInCategory.OST_PipeCurves) return "pipe";
            if (category == (long)BuiltInCategory.OST_FlexPipeCurves) return "flex_pipe";
            if (category == (long)BuiltInCategory.OST_PipeFitting || category == (long)BuiltInCategory.OST_DuctFitting) return "fitting";
            if (category == (long)BuiltInCategory.OST_PipeAccessory || category == (long)BuiltInCategory.OST_DuctAccessory) return "accessory";
            if (category == (long)BuiltInCategory.OST_PlumbingFixtures) return "fixture";
            if (category == (long)BuiltInCategory.OST_Sprinklers) return "sprinkler";
            if (category == (long)BuiltInCategory.OST_DuctCurves) return "duct";
            if (category == (long)BuiltInCategory.OST_FlexDuctCurves) return "flex_duct";
            if (category == (long)BuiltInCategory.OST_DuctTerminal) return "terminal";
            if (category == (long)BuiltInCategory.OST_Conduit) return "conduit";
            if (category == (long)BuiltInCategory.OST_CableTray) return "tray";
            if (category == (long)BuiltInCategory.OST_ConduitFitting || category == (long)BuiltInCategory.OST_CableTrayFitting) return "fitting";
            if (category == (long)BuiltInCategory.OST_MechanicalEquipment || category == (long)BuiltInCategory.OST_PlumbingEquipment) return "equipment";
            if (element is MEPCurve) return "curve";
            return "other";
        }

        private static bool IsCentral(Document doc)
        {
            if (doc == null || !doc.IsWorkshared || string.IsNullOrEmpty(doc.PathName)) return false;
            try
            {
                string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                return !string.IsNullOrEmpty(central) && string.Equals(System.IO.Path.GetFullPath(central), System.IO.Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
        }

        private static double Measure(Element element, BuiltInParameter parameter, ForgeTypeId unit)
        {
            Parameter value = element.get_Parameter(parameter);
            if (value == null || !value.HasValue || value.StorageType != StorageType.Double) return 0;
            try { return Math.Round(UnitUtils.ConvertFromInternalUnits(value.AsDouble(), unit), 2); }
            catch (Exception) { return 0; }
        }

        private static double MainAmps(Element element)
        {
            foreach (string name in new[] { "Mains", "Main Rating", "FMC_Main_Rating" })
            {
                Parameter parameter = element.LookupParameter(name);
                if (parameter == null || !parameter.HasValue) continue;
                if (parameter.StorageType == StorageType.Double) return Math.Round(parameter.AsDouble(), 1);
                if (parameter.StorageType == StorageType.Integer) return parameter.AsInteger();
            }
            return 0;
        }

        private static double Ways(Element element)
        {
            foreach (string name in new[] { "Number of Ways", "Max Number of Circuits", "Slots", "FMC_Ways" })
            {
                Parameter parameter = element.LookupParameter(name);
                if (parameter == null || !parameter.HasValue) continue;
                if (parameter.StorageType == StorageType.Integer) return parameter.AsInteger();
                if (parameter.StorageType == StorageType.Double) return Math.Round(parameter.AsDouble(), 0);
            }
            return 0;
        }

        private static string TextOf(Element element, string name)
        {
            Parameter parameter = element.LookupParameter(name);
            if (parameter == null || !parameter.HasValue) return "";
            return (parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString()) ?? "";
        }

        private static bool IsPower(ElectricalSystemType type) =>
            type == ElectricalSystemType.PowerCircuit || type == ElectricalSystemType.PowerBalanced || type == ElectricalSystemType.PowerUnBalanced;

        private static string Text(Element element, BuiltInParameter parameter) => element.get_Parameter(parameter)?.AsString() ?? "";

        private static double Volts(Element element)
        {
            Parameter parameter = element.get_Parameter(BuiltInParameter.RBS_ELEC_VOLTAGE);
            if (parameter == null || !parameter.HasValue) return 0;
            if (parameter.StorageType == StorageType.Double) return Math.Round(parameter.AsDouble(), 1);
            if (parameter.StorageType == StorageType.Integer) return parameter.AsInteger();
            return double.TryParse(parameter.AsValueString() ?? parameter.AsString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double value) ? value : 0;
        }

        private static int Poles(Element element)
        {
            Parameter parameter = element.get_Parameter(BuiltInParameter.RBS_ELEC_NUMBER_OF_POLES);
            return parameter != null && parameter.StorageType == StorageType.Integer ? parameter.AsInteger() : 0;
        }

        private static string Distribution(Element element)
        {
            Parameter parameter = element.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM);
            if (parameter == null) return "";
            return parameter.AsValueString() ?? parameter.AsString() ?? "";
        }

        private static JArray Point(XYZ point) => new JArray(Mm(point.X), Mm(point.Y), Mm(point.Z));
        private static double Mm(double feet) => Math.Round(feet * FeetToMm, 1);
        private static double Round4(double value) => Math.Round(value, 4);
        private static string Short(string value) => string.IsNullOrEmpty(value) ? "" : value.Length <= 80 ? value : value.Substring(0, 80);

        private sealed class CollectState
        {
            public bool Truncated;
            public int Skipped;
            public FmcNonFamily NonFamily = new FmcNonFamily();
            public List<string> Notes = new List<string>();
            public void Note(string message) { if (Notes.Count < 20 && !Notes.Contains(message)) Notes.Add(message); }
            public void Skip(Element element) => NonFamily.Add(element);
        }
    }

    /// <summary>Elements in an MEP or fixture category that are not a family. A DirectShape is the usual case. Ids are capped; the count is not.</summary>
    internal sealed class FmcNonFamily
    {
        private const int Cap = 50;
        private readonly HashSet<long> _seen = new HashSet<long>();
        private readonly List<long> _ids = new List<long>();
        private readonly JArray _items = new JArray();
        public int Count { get; private set; }

        public void Add(Element element)
        {
            if (element == null) return;
            long id = element.Id.Value;
            if (!_seen.Add(id)) return;
            Count++;
            if (_ids.Count >= Cap) return;
            _ids.Add(id);
            _items.Add(new JObject
            {
                ["id"] = id,
                ["class"] = element.GetType().Name,
                ["category"] = element.Category?.Name ?? "",
            });
        }

        public JObject Report()
        {
            return new JObject
            {
                ["count"] = Count,
                ["ids"] = new JArray(_ids),
                ["capped"] = Count > _ids.Count,
                ["items"] = _items,
            };
        }
    }
}
