using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Bridge;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Power and lighting snapshot. Connector.IsConnected is not used: assignment is GetElectricalSystems.
    /// A family with no electrical connector is reported, not thrown.
    /// </summary>
    public class FmcCircuitsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft circuits snapshot";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var nonBoard = new HashSet<long>();
                    foreach (JToken token in Parameters["non_board_ids"] as JArray ?? new JArray())
                        if (token.Type == JTokenType.Integer) nonBoard.Add(token.Value<long>());
                    var devices = new JArray();
                    var skipped = new FmcNonFamily();
                    var cats = new[]
                    {
                        BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_LightingDevices,
                        BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_ElectricalEquipment,
                    };
                    foreach (Element element in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats)).WhereElementIsNotElementType())
                    {
                        if (element is not FamilyInstance device)
                        {
                            skipped.Add(element);
                            continue;
                        }
                        devices.Add(DeviceRow(doc, device, nonBoard));
                    }
                    var panels = new JArray();
                    foreach (JObject row in devices.OfType<JObject>())
                        if (row.Value<bool?>("is_board") == true) panels.Add(PanelFrom(row));
                    var circuits = new JArray();
                    foreach (ElectricalSystem system in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>())
                    {
                        if (system.SystemType != ElectricalSystemType.PowerCircuit && system.SystemType != ElectricalSystemType.PowerUnBalanced && system.SystemType != ElectricalSystemType.PowerBalanced)
                            continue;
                        var members = new JArray();
                        try { foreach (Element member in system.Elements) if (member != null) members.Add(member.Id.Value); }
                        catch (Exception) { /* one circuit that cannot list its loads is still counted */ }
                        circuits.Add(new JObject
                        {
                            ["id"] = system.Id.Value,
                            ["name"] = Safe(() => system.LoadName) ?? "",
                            ["panel_name"] = Safe(() => system.PanelName) ?? "",
                            ["voltage"] = Volts(system),
                            ["poles"] = SafeInt(() => system.PolesNumber),
                            ["rating_a"] = Rating(system),
                            ["load_va"] = Load(system, true),
                            ["load_w"] = Load(system, false),
                            ["phase"] = PhaseText(system),
                            ["points"] = members.Count,
                            ["element_ids"] = members,
                        });
                    }
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = IsCentral(doc);
                    Result["devices"] = devices;
                    Result["panels"] = panels;
                    Result["circuits"] = circuits;
                    Result["skipped_non_family"] = skipped.Report();
                    Result["read_only"] = true;
                    Result["saved"] = false;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject DeviceRow(Document doc, FamilyInstance device, HashSet<long> nonBoard)
        {
            string system = "";
            bool connector = false;
            double voltage = 0;
            double connectorVoltage = 0;
            int poles = PolesOf(device);
            try
            {
                ConnectorSet set = device.MEPModel?.ConnectorManager?.Connectors;
                if (set != null)
                {
                    foreach (Connector item in set)
                    {
                        if (item.Domain != Domain.DomainElectrical) continue;
                        connector = true;
                        ElectricalSystemType kind = item.ElectricalSystemType;
                        bool power = kind == ElectricalSystemType.PowerCircuit || kind == ElectricalSystemType.PowerBalanced || kind == ElectricalSystemType.PowerUnBalanced;
                        if (!power) continue;
                        system = kind.ToString();
                        try
                        {
                            // Connector.Voltage is the value SelectPanel compares. There is no poles property on Connector.
                            double read = UnitUtils.ConvertFromInternalUnits(item.Voltage, UnitTypeId.Volts);
                            if (read > connectorVoltage) connectorVoltage = Math.Round(read, 1);
                        }
                        catch (Exception) { /* a connector with no voltage */ }
                    }
                }
            }
            catch (Exception) { connector = false; }
            Parameter volts = device.LookupParameter("Voltage");
            if (volts != null && volts.HasValue && volts.StorageType == StorageType.Double)
            {
                try { voltage = UnitUtils.ConvertFromInternalUnits(volts.AsDouble(), UnitTypeId.Volts); }
                catch (Exception) { voltage = volts.AsDouble(); }
            }
            var circuitIds = new JArray();
            try
            {
                var systems = device.MEPModel?.GetElectricalSystems();
                if (systems != null)
                    foreach (ElectricalSystem item in systems)
                        if (item != null) circuitIds.Add(item.Id.Value);
            }
            catch (Exception) { /* not assigned; do not call Connector.IsConnected */ }
            string part = PartName(device);
            bool declaredLoad = nonBoard.Contains(device.Id.Value);
            bool schedule = ScheduleCapable(device);
            bool board = !declaredLoad && (IsPanelPart(part) || schedule);
            string name = device.Name ?? "";
            bool suspect = part == "PanelBoard" && !declaredLoad && Regex.IsMatch(name, "spd|isolat|pump|control panel", RegexOptions.IgnoreCase);
            Room room = null;
            try { room = device.Room; } catch (Exception) { /* not in a room */ }
            Level level = doc.GetElement(device.LevelId) as Level;
            XYZ point = (device.Location as LocationPoint)?.Point;
            var row = new JObject
            {
                ["id"] = device.Id.Value,
                ["name"] = name,
                ["family"] = device.Symbol?.FamilyName ?? "",
                ["type_name"] = device.Symbol?.Name ?? "",
                ["category"] = device.Category?.Name ?? "",
                ["level"] = level?.Name ?? "",
                ["room"] = room?.Number ?? room?.Name ?? "",
                ["room_id"] = room?.Id.Value ?? 0,
                ["mark"] = device.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "",
                ["part_type"] = part,
                ["load_va"] = ParamDouble(device, BuiltInParameter.RBS_ELEC_APPARENT_LOAD),
                ["load_w"] = ParamDouble(device, BuiltInParameter.RBS_ELEC_TRUE_LOAD),
                ["voltage"] = connectorVoltage > 0 ? connectorVoltage : Math.Round(voltage, 1),
                ["connector_voltage"] = connectorVoltage,
                ["poles"] = poles > 0 ? poles : 1,
                ["connector_poles"] = poles,
                ["has_connector"] = connector,
                ["system_type"] = system,
                ["circuit_ids"] = circuitIds,
                ["x"] = point == null ? 0 : Math.Round(point.X * FeetToMm, 1),
                ["y"] = point == null ? 0 : Math.Round(point.Y * FeetToMm, 1),
                ["z"] = point == null ? 0 : Math.Round(point.Z * FeetToMm, 1),
                ["is_switch"] = Regex.IsMatch((device.Category?.Name ?? "") + " " + name, "switch", RegexOptions.IgnoreCase) && (device.Category?.Name ?? "").IndexOf("Device", StringComparison.OrdinalIgnoreCase) >= 0,
                ["is_board"] = board,
                ["schedule_capable"] = schedule,
                ["suspect_board"] = suspect,
                ["utility_fed"] = device.LookupParameter("FMC_UtilityFed")?.AsInteger() == 1 || Regex.IsMatch(MarkOf(device) + " " + name, "utility", RegexOptions.IgnoreCase),
                ["distribution"] = DistributionName(device),
                ["has_supply"] = HasSupply(device),
            };
            AddDistribution(device, row);
            return row;
        }

        /// <summary>Line-to-line, line-to-ground, phase and wire count from DistributionSysType. Missing members stay unset.</summary>
        internal static void AddDistribution(FamilyInstance device, JObject row)
        {
            try
            {
                Parameter parameter = device.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM)
                    ?? device.Symbol?.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM);
                if (parameter == null || parameter.StorageType != StorageType.ElementId) return;
                if (device.Document.GetElement(parameter.AsElementId()) is not DistributionSysType system) return;
                row["voltage_ll"] = VoltageOf(system.VoltageLineToLine);
                row["voltage_lg"] = VoltageOf(system.VoltageLineToGround);
                row["phase"] = system.ElectricalPhase.ToString();
                row["wires"] = system.NumWires;
                row["phase_config"] = system.PhaseConfiguration.ToString();
            }
            catch (Exception) { /* the parameter is absent on a device that is not a panel */ }
        }

        private static double VoltageOf(VoltageType type)
        {
            if (type == null) return 0;
            try { return Math.Round(UnitUtils.ConvertFromInternalUnits(type.ActualValue, UnitTypeId.Volts), 1); }
            catch (Exception) { return Math.Round(type.ActualValue, 1); }
        }

        private static JObject PanelFrom(JObject row)
        {
            return new JObject
            {
                ["id"] = row["id"], ["name"] = row.Value<string>("name") ?? row.Value<string>("mark") ?? "",
                ["level"] = row["level"], ["x"] = row["x"], ["y"] = row["y"], ["z"] = row["z"],
                ["distribution"] = row["distribution"], ["voltage"] = row["voltage"],
                ["voltage_ll"] = row["voltage_ll"], ["voltage_lg"] = row["voltage_lg"],
                ["phase"] = row["phase"], ["wires"] = row["wires"],
                ["has_supply"] = row["has_supply"], ["utility_fed"] = row["utility_fed"],
                ["part_type"] = row["part_type"], ["is_board"] = true,
            };
        }

        internal static bool IsPanelPart(string part)
        {
            string name = (part ?? "").Replace(" ", "").Replace("_", "");
            return name.Equals("PanelBoard", StringComparison.OrdinalIgnoreCase)
                || name.Equals("SwitchBoard", StringComparison.OrdinalIgnoreCase)
                || name.Equals("OtherPanel", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Electrical equipment with a power-balanced or power-unbalanced connector can take a panel schedule.
        /// A device connector is PowerCircuit and is not enough on its own.
        /// </summary>
        internal static bool ScheduleCapable(FamilyInstance device)
        {
            if (device.Category?.Id.Value != (long)BuiltInCategory.OST_ElectricalEquipment) return false;
            try
            {
                ConnectorSet set = device.MEPModel?.ConnectorManager?.Connectors;
                if (set == null) return false;
                foreach (Connector item in set)
                {
                    if (item.Domain != Domain.DomainElectrical) continue;
                    if (item.ElectricalSystemType == ElectricalSystemType.PowerBalanced || item.ElectricalSystemType == ElectricalSystemType.PowerUnBalanced)
                        return true;
                }
            }
            catch (Exception) { return false; }
            return false;
        }

        internal static string PartName(FamilyInstance device)
        {
            Parameter parameter = device.Symbol?.Family?.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
            if (parameter == null || parameter.StorageType != StorageType.Integer) return "";
            return ((PartType)parameter.AsInteger()).ToString();
        }

        private static int PolesOf(FamilyInstance device)
        {
            foreach (string name in new[] { "Number of Poles", "Poles" })
            {
                Parameter parameter = device.LookupParameter(name);
                if (parameter == null || !parameter.HasValue) continue;
                if (parameter.StorageType == StorageType.Integer) return parameter.AsInteger();
                if (parameter.StorageType == StorageType.Double) return (int)Math.Round(parameter.AsDouble());
            }
            return 1;
        }

        private static double ParamDouble(Element element, BuiltInParameter builtIn)
        {
            try
            {
                Parameter parameter = element.get_Parameter(builtIn);
                if (parameter == null || !parameter.HasValue || parameter.StorageType != StorageType.Double) return 0;
                return Math.Round(parameter.AsDouble(), 1);
            }
            catch (Exception) { return 0; }
        }

        internal static string DistributionName(FamilyInstance device)
        {
            try
            {
                Parameter parameter = device.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM)
                    ?? device.Symbol?.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM);
                if (parameter == null || parameter.StorageType != StorageType.ElementId) return "";
                Element type = device.Document.GetElement(parameter.AsElementId());
                return type?.Name ?? "";
            }
            catch (Exception) { return ""; }
        }

        private static bool HasSupply(FamilyInstance device)
        {
            string supply = device.LookupParameter("Supply From")?.AsString() ?? "";
            return !string.IsNullOrWhiteSpace(supply);
        }

        private static string MarkOf(FamilyInstance device) => device.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "";
        private static string PhaseText(ElectricalSystem system) => system.LookupParameter("FMC_Phase")?.AsString() ?? system.LookupParameter("Phase")?.AsString() ?? "";
        private static double Volts(ElectricalSystem system) { try { return Math.Round(UnitUtils.ConvertFromInternalUnits(system.Voltage, UnitTypeId.Volts), 1); } catch (Exception) { return 0; } }
        private static double Rating(ElectricalSystem system) { try { return system.Rating; } catch (Exception) { return 0; } }
        private static double Load(ElectricalSystem system, bool apparent) { try { return Math.Round(apparent ? system.ApparentLoad : system.TrueLoad, 1); } catch (Exception) { return 0; } }
        private static string Safe(Func<string> read) { try { return read(); } catch (Exception) { return ""; } }
        private static int SafeInt(Func<int> read) { try { return read(); } catch (Exception) { return 0; } }

        private static bool IsCentral(Document doc)
        {
            if (doc == null || !doc.IsWorkshared || string.IsNullOrEmpty(doc.PathName)) return false;
            try
            {
                string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                return !string.IsNullOrEmpty(central) && string.Equals(Path.GetFullPath(central), Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
        }
    }

    /// <summary>Creates circuits and sets a panel. One transaction, one subtransaction per circuit.</summary>
    public class FmcCircuitsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft circuits apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    string mode = (Parameters.Value<string>("mode") ?? "apply").Trim();
                    bool committed = false;
                    var created = new JArray();
                    var failed = new JArray();
                    var unset = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft circuits"))
                    {
                        transaction.Start();
                        if (mode == "panel") SetPanel(doc, unset, failed);
                        else
                        {
                            BindPhase(app, doc, unset);
                            foreach (JObject circuit in (Parameters["circuits"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                using (var sub = new SubTransaction(doc))
                                {
                                    sub.Start();
                                    try
                                    {
                                        JObject row = MakeCircuit(doc, circuit, unset);
                                        sub.Commit();
                                        created.Add(row);
                                    }
                                    catch (Exception ex)
                                    {
                                        try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                                        failed.Add(new JObject { ["name"] = circuit.Value<string>("name") ?? "", ["error"] = ex.Message });
                                    }
                                }
                            }
                            foreach (JObject row in (Parameters["switches"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                using (var sub = new SubTransaction(doc))
                                {
                                    sub.Start();
                                    try
                                    {
                                        JObject made = MakeSwitch(doc, row);
                                        if (made.Value<bool?>("ok") == true) { sub.Commit(); created.Add(made); }
                                        else { sub.RollBack(); failed.Add(made); }
                                    }
                                    catch (Exception ex)
                                    {
                                        try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                                        failed.Add(new JObject { ["op"] = "switch", ["error"] = ex.Message });
                                    }
                                }
                            }
                        }
                        transaction.Commit();
                        committed = true;
                    }
                    bool attempted = mode == "panel" || (Parameters["circuits"] as JArray ?? new JArray()).Count > 0;
                    Result["applied"] = committed && (created.Count > 0 || (mode == "panel" && failed.Count == 0));
                    if (mode == "panel" && !attempted) Result["applied"] = committed;
                    Result["created"] = created;
                    Result["failed"] = failed;
                    Result["unset"] = unset;
                    Result["saved"] = false;
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    if (created.Count == 0 && failed.Count > 0) Result["applied"] = false;
                }
            }
            catch (Exception ex) { Error = ex.Message; Result["applied"] = false; }
            finally { _done.Set(); }
        }

        private void SetPanel(Document doc, JArray unset, JArray failed)
        {
            FamilyInstance panel = FindPanel(doc, Parameters.Value<string>("panel") ?? "");
            if (panel == null) { failed.Add(new JObject { ["error"] = "Panel was not found." }); return; }
            string distribution = Parameters.Value<string>("distribution") ?? "";
            if (!string.IsNullOrWhiteSpace(distribution))
            {
                DistributionSysType match = ElectricalSetting.GetElectricalSettings(doc).DistributionSysTypes.Cast<DistributionSysType>()
                    .FirstOrDefault(item => string.Equals(item.Name, distribution, StringComparison.OrdinalIgnoreCase));
                Parameter parameter = panel.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM)
                    ?? panel.Symbol?.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM);
                if (match == null) unset.Add("distribution system " + distribution + " is not in this model. It was not created.");
                else if (parameter == null || parameter.IsReadOnly) unset.Add("Distribution system parameter is read-only on " + panel.Name + ".");
                else parameter.Set(match.Id);
            }
            SetText(panel, new[] { "Supply From" }, Parameters.Value<string>("supply_from"), "supply_from", unset);
            SetText(panel, new[] { "Feeder" }, Parameters.Value<string>("feeder"), "feeder", unset);
            SetText(panel, new[] { "Mains Type" }, Parameters.Value<string>("mains_type"), "mains_type", unset);
            double? mains = Parameters.Value<double?>("mains_a");
            if (mains != null) SetNumber(panel, new[] { "Mains", "Rating" }, mains.Value, "mains_a", unset);
        }

        private static JObject MakeCircuit(Document doc, JObject plan, JArray unset)
        {
            var ids = new List<ElementId>();
            foreach (JToken token in plan["element_ids"] as JArray ?? new JArray())
            {
                long id = token.Value<long>();
                Element element = doc.GetElement(new ElementId(id));
                if (element is DirectShape) throw new InvalidOperationException("DirectShape " + id + " skipped.");
                if (element is not FamilyInstance) throw new InvalidOperationException("Element " + id + " is not a family.");
                ids.Add(element.Id);
            }
            if (ids.Count == 0) throw new InvalidOperationException("The circuit has no devices.");
            ElectricalSystem system = ElectricalSystem.Create(doc, ids, ElectricalSystemType.PowerCircuit);
            FamilyInstance panel = FindPanel(doc, plan.Value<string>("panel_name") ?? "") ?? FindPanel(doc, (plan.Value<long?>("panel_id") ?? 0).ToString());
            if (panel == null) throw new InvalidOperationException("Panel " + (plan.Value<string>("panel_name") ?? "") + " was not found. The circuit was not kept.");
            if (!FmcCircuitsHandler.IsPanelPart(FmcCircuitsHandler.PartName(panel)) && !FmcCircuitsHandler.ScheduleCapable(panel))
                throw new InvalidOperationException("FMC-PANEL-NO-DISTRIBUTION is not this case. " + (panel.Symbol?.FamilyName ?? panel.Name) + " is not a panel: it needs Part Type Panelboard, Switchboard or Other Panel, or a panel-schedule connector.");
            if (string.IsNullOrWhiteSpace(FmcCircuitsHandler.DistributionName(panel)))
                throw new InvalidOperationException("FMC-PANEL-NO-DISTRIBUTION " + (panel.Name ?? "") + " has no distribution system. Set the Distribution System parameter (RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM).");
            string mismatch = PanelMismatch(panel, system);
            if (!string.IsNullOrEmpty(mismatch)) throw new InvalidOperationException(mismatch);
            try { system.SelectPanel(panel); }
            catch (Exception ex)
            {
                string reason = PanelMismatch(panel, system);
                if (string.IsNullOrEmpty(reason)) reason = "FMC-CIRCUIT-PANEL-MISMATCH " + (panel.Name ?? "") + " vs circuit " + CircuitVolts(system) + " V, " + CircuitPoles(system) + "-pole.";
                throw new InvalidOperationException(reason + " Revit: " + ex.Message);
            }
            string name = plan.Value<string>("name") ?? "";
            TrySet(system, BuiltInParameter.RBS_ELEC_CIRCUIT_NAME, name, "circuit name", unset);
            TrySet(system, BuiltInParameter.RBS_ELEC_CIRCUIT_NUMBER, plan.Value<string>("slot") ?? "", "circuit number", unset);
            try { system.LoadName = name; } catch (Exception) { unset.Add("LoadName"); }
            SetText(system, new[] { "FMC_Phase", "Phase" }, plan.Value<string>("phase"), "phase", unset);
            SetNumber(system, new[] { "Rating" }, plan.Value<double?>("breaker_a") ?? 0, "breaker rating", unset);
            string cable = (plan.Value<double?>("cable_mm2") ?? 0).ToString(System.Globalization.CultureInfo.InvariantCulture);
            WireType wire = new FilteredElementCollector(doc).OfClass(typeof(WireType)).Cast<WireType>()
                .FirstOrDefault(item => (item.Name ?? "").IndexOf(cable, StringComparison.OrdinalIgnoreCase) >= 0);
            if (wire == null) unset.Add("wire size " + cable + " mm2: no WireType of that name. Poles come from the connectors and were not overwritten.");
            else { try { system.WireType = wire; } catch (Exception) { unset.Add("WireType is read-only."); } }
            unset.Add("poles: PolesNumber is read from the connectors and was not set.");
            return new JObject { ["ok"] = true, ["id"] = system.Id.Value, ["name"] = name, ["panel"] = panel.Name };
        }

        private static JObject MakeSwitch(Document doc, JObject row)
        {
            // Revit 2025 has no SwitchSystem type. The plan still lists the groups. Nothing is created.
            long switchId = row.Value<long?>("switch_id") ?? 0;
            int lights = (row["light_ids"] as JArray ?? new JArray()).Count;
            return new JObject
            {
                ["ok"] = false,
                ["op"] = "switch",
                ["id"] = switchId,
                ["lights"] = lights,
                ["error"] = "SwitchSystem is not in the Revit 2025 API. The switch-to-luminaire association was not created.",
            };
        }

        private static void BindPhase(UIApplication app, Document doc, JArray unset)
        {
            if (new FilteredElementCollector(doc).OfClass(typeof(SharedParameterElement)).Cast<SharedParameterElement>().Any(item => item.Name == "FMC_Phase"))
                return;
            try
            {
                DefinitionFile file = app.Application.OpenSharedParameterFile();
                if (file == null)
                {
                    string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Formcraft", "circuits", "FMC_SharedParameters.txt");
                    Directory.CreateDirectory(Path.GetDirectoryName(path) ?? path);
                    if (!File.Exists(path)) File.WriteAllText(path, "");
                    app.Application.SharedParametersFilename = path;
                    file = app.Application.OpenSharedParameterFile();
                }
                if (file == null) { unset.Add("FMC_Phase: no shared parameter file could be opened."); return; }
                DefinitionGroup group = file.Groups.get_Item("FMC") ?? file.Groups.Create("FMC");
                Definition definition = group.Definitions.get_Item("FMC_Phase") ?? group.Definitions.Create(new ExternalDefinitionCreationOptions("FMC_Phase", SpecTypeId.String.Text));
                var categories = app.Application.Create.NewCategorySet();
                categories.Insert(Category.GetCategory(doc, BuiltInCategory.OST_ElectricalCircuit));
                var binding = app.Application.Create.NewInstanceBinding(categories);
                if (!doc.ParameterBindings.Insert(definition, binding) && !doc.ParameterBindings.ReInsert(definition, binding))
                    unset.Add("FMC_Phase could not be bound to Electrical Circuits.");
            }
            catch (Exception ex) { unset.Add("FMC_Phase was not bound: " + ex.Message); }
        }

        private static double CircuitVolts(ElectricalSystem system)
        {
            try { return Math.Round(UnitUtils.ConvertFromInternalUnits(system.Voltage, UnitTypeId.Volts), 1); }
            catch (Exception) { return 0; }
        }

        private static int CircuitPoles(ElectricalSystem system)
        {
            try { return system.PolesNumber; }
            catch (Exception) { return 0; }
        }

        /// <summary>
        /// The same check planning uses. SelectPanel throws "panel and circuit do not match" when the
        /// distribution system voltage or phase cannot feed the circuit's connector voltage and poles.
        /// Returns "" when the voltages were not read, so SelectPanel still runs and its own message is kept.
        /// </summary>
        private static string PanelMismatch(FamilyInstance panel, ElectricalSystem system)
        {
            var row = new JObject();
            FmcCircuitsHandler.AddDistribution(panel, row);
            double ll = row.Value<double?>("voltage_ll") ?? 0;
            double lg = row.Value<double?>("voltage_lg") ?? 0;
            string phase = row.Value<string>("phase") ?? "";
            int wires = row.Value<int?>("wires") ?? 0;
            double volts = CircuitVolts(system);
            int poles = CircuitPoles(system);
            if (ll <= 0 && lg <= 0) return "";
            bool single = phase.IndexOf("Single", StringComparison.OrdinalIgnoreCase) >= 0;
            string described = (panel.Name ?? "panel") + " is " + ll + " V line-to-line / " + lg + " V line-to-ground, " + (phase.Length > 0 ? phase : "phase unknown") + (wires > 0 ? ", " + wires + "-wire" : "");
            string device = "circuit is " + volts + " V, " + (poles > 0 ? poles : 1) + "-pole";
            int n = poles > 0 ? poles : 1;
            if (n >= 3)
            {
                if (single) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". A single-phase panel cannot take a " + n + "-pole circuit.";
                if (ll <= 0) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". No line-to-line voltage for a " + n + "-pole circuit.";
                if (volts > 0 && Math.Abs(volts - ll) > 15) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". A " + n + "-pole circuit needs " + ll + " V line-to-line.";
                return "";
            }
            if (n == 2)
            {
                double expected = ll > 0 ? ll : lg;
                if (expected <= 0) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". No line-to-line voltage for a 2-pole circuit.";
                if (volts > 0 && Math.Abs(volts - expected) > 15) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". A 2-pole circuit needs " + expected + " V.";
                return "";
            }
            double one = lg > 0 ? lg : (single ? ll : 0);
            if (one <= 0) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". No line-to-ground voltage for a 1-pole circuit.";
            if (volts > 0 && Math.Abs(volts - one) > 15) return "FMC-CIRCUIT-PANEL-MISMATCH " + described + " vs " + device + ". A 1-pole circuit needs " + one + " V line-to-ground.";
            return "";
        }

        private static FamilyInstance FindPanel(Document doc, string key)
        {
            key = (key ?? "").Trim();
            if (key.Length == 0) return null;
            if (long.TryParse(key, out long id))
            {
                if (doc.GetElement(new ElementId(id)) is FamilyInstance byId) return byId;
            }
            return new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ElectricalEquipment).WhereElementIsNotElementType()
                .Cast<FamilyInstance>().FirstOrDefault(item => string.Equals(item.Name, key, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(item.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString(), key, StringComparison.OrdinalIgnoreCase));
        }

        private static void TrySet(Element element, BuiltInParameter builtIn, string value, string label, JArray unset)
        {
            if (string.IsNullOrEmpty(value)) return;
            try
            {
                Parameter parameter = element.get_Parameter(builtIn);
                if (parameter == null || parameter.IsReadOnly) unset.Add(label + " (" + builtIn + ") cannot be set.");
                else parameter.Set(value);
            }
            catch (Exception) { unset.Add(label + " cannot be set."); }
        }

        private static void SetText(Element element, string[] names, string value, string label, JArray unset)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            foreach (string name in names)
            {
                Parameter parameter = element.LookupParameter(name);
                if (parameter == null || parameter.IsReadOnly || parameter.StorageType != StorageType.String) continue;
                parameter.Set(value);
                return;
            }
            unset.Add(label + " has no writable parameter (" + string.Join(", ", names) + ").");
        }

        private static void SetNumber(Element element, string[] names, double value, string label, JArray unset)
        {
            if (value <= 0) return;
            foreach (string name in names)
            {
                Parameter parameter = element.LookupParameter(name);
                if (parameter == null || parameter.IsReadOnly) continue;
                if (parameter.StorageType == StorageType.Double) { parameter.Set(value); return; }
                if (parameter.StorageType == StorageType.Integer) { parameter.Set((int)Math.Round(value)); return; }
            }
            unset.Add(label + " has no writable parameter.");
        }

        private static void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_circuits.");
            if (doc.IsWorkshared && !string.IsNullOrEmpty(doc.PathName))
            {
                try
                {
                    string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                    if (!string.IsNullOrEmpty(central) && string.Equals(Path.GetFullPath(central), Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("A central model is not written by fmc_circuits.");
                }
                catch (InvalidOperationException) { throw; }
                catch (Exception) { /* a local whose central path cannot be read is still checked by the server */ }
            }
        }
    }
}
