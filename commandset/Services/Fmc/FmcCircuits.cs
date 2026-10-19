using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_circuits_create (fmc_systems create_circuits, KISIC 4.4): groups chosen devices' power connectors into circuits
    /// on a named board (ElectricalSystem.Create, then SelectPanel), in one transaction. When the board has no
    /// distribution system, the one named from the kit's Electrical_Settings is set (and made in the project from the
    /// kit's values when the project lacks it). A dry run is the real run rolled back, so a board Revit refuses shows up
    /// in the dry run. Rule 5: nothing is sized here: no rating, wire size, demand factor or load is ever set.
    /// </summary>
    public partial class FmcSystemsEventHandler
    {
        private static readonly PartType[] PanelParts = { PartType.PanelBoard, PartType.SwitchBoard, PartType.OtherPanel };

        private static Element ByKey(Document doc, string key)
        {
            key = (key ?? "").Trim();
            if (key.Length == 0) return null;
            Element e = doc.GetElement(key);
            if (e == null && long.TryParse(key, out long id)) e = doc.GetElement(new ElementId(id));
            return e;
        }

        private static string PanelName(FamilyInstance b) => b.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString() ?? "";

        private static FamilyInstance FindBoard(Document doc, string key)
        {
            if (ByKey(doc, key) is FamilyInstance fi) return fi;
            return new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ElectricalEquipment).WhereElementIsNotElementType()
                .OfType<FamilyInstance>().FirstOrDefault(b => string.Equals(PanelName(b), key, StringComparison.OrdinalIgnoreCase));
        }

        private static PartType? PartOf(FamilyInstance b)
        {
            Parameter p = b.Symbol?.Family?.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
            return p == null || p.StorageType != StorageType.Integer ? (PartType?)null : (PartType)p.AsInteger();
        }

        /// <summary>The distribution system by name, made from the kit's values (voltages first) when the project has none of that name.</summary>
        private static DistributionSysType DistributionSystem(Document doc, JObject spec, JArray voltages, JArray notes)
        {
            ElectricalSetting es = ElectricalSetting.GetElectricalSettings(doc);
            string name = spec.Value<string>("name");
            DistributionSysType have = es.DistributionSysTypes.Cast<DistributionSysType>().FirstOrDefault(s => s.Name == name);
            if (have != null) return have;
            double V(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Volts);
            VoltageType Voltage(string vn)
            {
                if (string.IsNullOrEmpty(vn)) return null;
                VoltageType vt = es.VoltageTypes.Cast<VoltageType>().FirstOrDefault(v => v.Name == vn);
                if (vt != null) return vt;
                JObject x = voltages.OfType<JObject>().FirstOrDefault(v => v.Value<string>("name") == vn)
                    ?? throw new InvalidOperationException($"{name} names voltage {vn}, which the kit's Electrical_Settings doesn't define");
                notes.Add($"Voltage {vn} made from the kit's Electrical_Settings");
                return es.AddVoltageType(vn, V(x.Value<double>("value")), V(x.Value<double>("min")), V(x.Value<double>("max")));
            }
            var phase = spec.Value<string>("phase") == "Single" ? ElectricalPhase.SinglePhase : ElectricalPhase.ThreePhase;
            var config = spec.Value<string>("config") switch { "Delta" => ElectricalPhaseConfiguration.Delta, "Wye" => ElectricalPhaseConfiguration.Wye, _ => ElectricalPhaseConfiguration.Undefined };
            VoltageType ll = Voltage(spec.Value<string>("ll")), lg = Voltage(spec.Value<string>("lg"));
            notes.Add($"Distribution system {name} made from the kit's Electrical_Settings");
            return es.AddDistributionSysType(name, phase, config, spec.Value<int>("wires"), ll, lg);
        }

        private static bool PowerConnector(Connector c) =>
            c.Domain == Domain.DomainElectrical && (c.ElectricalSystemType == ElectricalSystemType.PowerCircuit
                || c.ElectricalSystemType == ElectricalSystemType.PowerBalanced || c.ElectricalSystemType == ElectricalSystemType.PowerUnBalanced);

        private JObject CreateCircuits(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            var notes = new JArray();
            var problems = new JArray();
            var made = new JArray();
            var skipped = new JArray();
            var failures = new FmcFailures();
            JObject boardOut = new JObject();

            using (var t = new Transaction(doc, "Formcraft: create circuits"))
            {
                failures.Attach(t);
                t.Start();
                string key = p.Value<string>("board") ?? "";
                FamilyInstance board = FindBoard(doc, key)
                    ?? throw new InvalidOperationException($"No board {key} in the model (give its unique id, element id or panel name)");
                if (board.Category?.Id.Value != (long)BuiltInCategory.OST_ElectricalEquipment)
                    throw new InvalidOperationException($"{key} is {board.Category?.Name}, not Electrical Equipment");
                PartType? part = PartOf(board);
                boardOut["id"] = board.Id.Value;
                boardOut["unique_id"] = board.UniqueId;
                boardOut["family"] = board.Symbol?.FamilyName ?? "";
                boardOut["type"] = board.Symbol?.Name ?? "";
                boardOut["part_type"] = part?.ToString() ?? "";
                if (part == null || !PanelParts.Contains(part.Value))
                    throw new InvalidOperationException($"{board.Symbol?.FamilyName} has Part Type {part?.ToString() ?? "(none)"}: Revit takes a board as a circuit's panel only " +
                        "when its Part Type is Panelboard, Switchboard or Other Panel. Rebuild the family with set_family_params part_type (kit change request §6)");

                string boardName = (p.Value<string>("board_name") ?? "").Trim();
                if (PanelName(board).Length == 0 && boardName.Length > 0)
                {
                    board.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.Set(boardName);
                    notes.Add($"Panel Name set to {boardName}");
                }
                boardOut["name"] = PanelName(board);

                Parameter dsp = board.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM)
                    ?? throw new InvalidOperationException($"{board.Symbol?.FamilyName} offers no Distribution System");
                ElementId dsId = dsp.AsElementId();
                bool dsSet = false;
                if (dsId == null || dsId == ElementId.InvalidElementId)
                {
                    if (!(p["distribution_system"] is JObject spec))
                        throw new InvalidOperationException("The board has no distribution system: name one from the kit's Electrical_Settings (distribution_system)");
                    DistributionSysType ds = DistributionSystem(doc, spec, p["voltages"] as JArray ?? new JArray(), notes);
                    if (dsp.IsReadOnly || !dsp.Set(ds.Id))
                        throw new InvalidOperationException($"Revit didn't take distribution system {ds.Name} on the board");
                    dsSet = true;
                    notes.Add($"Distribution system {ds.Name} set on the board (from the kit)");
                }
                boardOut["distribution_system"] = doc.GetElement(dsp.AsElementId())?.Name ?? "";
                boardOut["distribution_set"] = dsSet;

                int n = 0;
                foreach (JObject c in (p["circuits"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    n++;
                    string label = (c.Value<string>("load_name") ?? "").Trim();
                    string where = label.Length > 0 ? label : "circuit " + n;
                    var ids = new List<ElementId>();
                    foreach (string k in (c["elements"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    {
                        Element e = ByKey(doc, k);
                        if (!(e is FamilyInstance fi)) { problems.Add($"{where}: no element {k} in the model"); continue; }
                        var power = fi.MEPModel?.ConnectorManager?.Connectors?.Cast<Connector>().Where(PowerConnector).ToList() ?? new List<Connector>();
                        if (power.Count == 0) { problems.Add($"{where}: {fi.Symbol?.FamilyName} ({k}) has no power connector"); continue; }
                        ElectricalSystem on = fi.MEPModel.GetElectricalSystems()?.FirstOrDefault(s => s.SystemType == ElectricalSystemType.PowerCircuit
                            && (s.BaseEquipment == null || s.BaseEquipment.Id != fi.Id));
                        if (on != null) { skipped.Add($"{where}: {fi.Symbol?.FamilyName} ({k}) is already on circuit {on.PanelName} / {on.CircuitNumber}"); continue; }
                        ids.Add(fi.Id);
                    }
                    if (ids.Count == 0) { problems.Add($"{where}: nothing to circuit"); continue; }
                    ElectricalSystem sys;
                    try { sys = ElectricalSystem.Create(doc, ids, ElectricalSystemType.PowerCircuit); }
                    catch (Exception ex) { problems.Add($"{where}: Revit made no circuit ({ex.Message})"); continue; }
                    if (sys == null) { problems.Add($"{where}: Revit made no circuit"); continue; }
                    try { sys.SelectPanel(board); }
                    catch (Exception ex)
                    {
                        problems.Add($"{where}: Revit refused {PanelName(board)} as the circuit's panel ({ex.Message})");
                        doc.Delete(sys.Id);
                        continue;
                    }
                    if (label.Length > 0) { try { sys.LoadName = label; } catch (Exception) { notes.Add($"{where}: Load Name not set"); } }
                    doc.Regenerate();
                    made.Add(new JObject
                    {
                        ["id"] = dry ? null : (JToken)sys.Id.Value, ["unique_id"] = dry ? "" : sys.UniqueId,
                        ["board"] = sys.PanelName ?? "", ["number"] = sys.CircuitNumber ?? "", ["load_name"] = sys.LoadName ?? "",
                        ["elements"] = ids.Count, ["poles"] = sys.PolesNumber,
                    });
                }

                // all or nothing: a real run with any problem changes nothing
                if (dry || problems.Count > 0) t.RollBack();
                else t.Commit();
            }
            return new JObject
            {
                ["dry_run"] = dry, ["committed"] = !dry && problems.Count == 0 && !failures.RolledBack,
                ["board"] = boardOut, ["circuits"] = made, ["made"] = made.Count, ["skipped"] = skipped, ["problems"] = problems, ["notes"] = notes,
                ["warnings"] = new JArray(failures.Warnings), ["errors"] = new JArray(failures.Errors), ["rolled_back"] = failures.RolledBack,
            };
        }
    }
}
