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
    /// Duct and pipe systems, and the routing preferences of duct and pipe types, as facts. No transaction.
    /// Connectivity (IsWellConnected, unused connectors, critical path) is fmc_mep_audit's, and open ends are fmc_trace's.
    /// Routing preferences are only read here: the system-type editor (modify_model) owns writing them.
    /// </summary>
    public class FmcMepSystemsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const int Cap = 2000;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft MEP systems";

        private static readonly RoutingPreferenceRuleGroupType[] Groups =
        {
            RoutingPreferenceRuleGroupType.Segments, RoutingPreferenceRuleGroupType.Elbows, RoutingPreferenceRuleGroupType.Junctions,
            RoutingPreferenceRuleGroupType.Crosses, RoutingPreferenceRuleGroupType.Transitions, RoutingPreferenceRuleGroupType.Unions,
            RoutingPreferenceRuleGroupType.MechanicalJoints, RoutingPreferenceRuleGroupType.TransitionsRectangularToRound,
            RoutingPreferenceRuleGroupType.TransitionsRectangularToOval, RoutingPreferenceRuleGroupType.TransitionsOvalToRound, RoutingPreferenceRuleGroupType.Caps,
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
                    bool withRouting = Parameters.Value<bool?>("routing") == true;
                    var systems = new JArray();
                    int total = 0;
                    if (domain != "piping")
                        foreach (MechanicalSystem s in new FilteredElementCollector(doc).OfClass(typeof(MechanicalSystem)).Cast<MechanicalSystem>())
                        {
                            total++;
                            if (systems.Count < Cap) systems.Add(SystemRow(doc, s, "duct"));
                        }
                    if (domain != "duct")
                        foreach (PipingSystem s in new FilteredElementCollector(doc).OfClass(typeof(PipingSystem)).Cast<PipingSystem>())
                        {
                            total++;
                            if (systems.Count < Cap) systems.Add(SystemRow(doc, s, "piping"));
                        }
                    var systemTypes = new JArray();
                    foreach (MEPSystemType t in new FilteredElementCollector(doc).OfClass(typeof(MEPSystemType)).Cast<MEPSystemType>())
                    {
                        string kind = t is MechanicalSystemType ? "duct" : t is PipingSystemType ? "piping" : "";
                        if (kind.Length == 0 || (domain == "duct" && kind != "duct") || (domain == "piping" && kind != "piping")) continue;
                        systemTypes.Add(new JObject
                        {
                            ["id"] = t.Id.Value, ["name"] = t.Name, ["kind"] = kind,
                            ["classification"] = t.SystemClassification.ToString(),
                            ["abbreviation"] = t.Abbreviation ?? "",
                        });
                    }
                    var curveTypes = new JArray();
                    if (withRouting)
                    {
                        var types = new List<MEPCurveType>();
                        if (domain != "piping") types.AddRange(new FilteredElementCollector(doc).OfClass(typeof(DuctType)).Cast<MEPCurveType>());
                        if (domain != "duct") types.AddRange(new FilteredElementCollector(doc).OfClass(typeof(PipeType)).Cast<MEPCurveType>());
                        foreach (MEPCurveType type in types) curveTypes.Add(RoutingRow(doc, type));
                    }
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["systems"] = systems;
                    Result["system_count"] = total;
                    Result["capped"] = total > Cap;
                    Result["system_types"] = systemTypes;
                    Result["curve_types"] = curveTypes;
                    Result["read_only"] = true;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject SystemRow(Document doc, MEPSystem s, string kind)
        {
            var row = new JObject { ["id"] = s.Id.Value, ["name"] = s.Name ?? "", ["kind"] = kind };
            try
            {
                var type = doc.GetElement(s.GetTypeId()) as MEPSystemType;
                row["system_type"] = type?.Name ?? "";
                row["classification"] = type?.SystemClassification.ToString() ?? "";
            }
            catch (Exception) { row["system_type"] = ""; }
            try
            {
                FamilyInstance equipment = s.BaseEquipment;
                row["base_equipment"] = equipment == null ? null : new JObject { ["id"] = equipment.Id.Value, ["name"] = (equipment.Symbol?.FamilyName ?? "") + " " + equipment.Name };
            }
            catch (Exception) { row["base_equipment"] = null; }
            try { row["elements"] = s.Elements?.Size ?? 0; } catch (Exception) { row["elements"] = null; }
            row["flow"] = ParamText(s, "Flow");
            row["static_pressure"] = ParamText(s, "Static Pressure");
            row["fixture_units"] = ParamText(s, "Fixture Units");
            return row;
        }

        private static JToken ParamText(Element e, string name)
        {
            try
            {
                Parameter p = e.LookupParameter(name);
                if (p == null || !p.HasValue) return null;
                return p.AsValueString() ?? p.AsString() ?? "";
            }
            catch (Exception) { return null; }
        }

        internal static JObject RoutingRow(Document doc, MEPCurveType type)
        {
            var row = new JObject { ["id"] = type.Id.Value, ["name"] = type.Name, ["kind"] = type is DuctType ? "duct" : "pipe" };
            var groups = new JObject();
            try
            {
                RoutingPreferenceManager rpm = type.RoutingPreferenceManager;
                row["preferred_junction"] = rpm.PreferredJunctionType.ToString();
                foreach (RoutingPreferenceRuleGroupType group in Groups)
                {
                    var rules = new JArray();
                    int n = 0;
                    try { n = rpm.GetNumberOfRules(group); } catch (Exception) { continue; }
                    for (int i = 0; i < n; i++)
                    {
                        try
                        {
                            RoutingPreferenceRule rule = rpm.GetRule(group, i);
                            Element part = doc.GetElement(rule.MEPPartId);
                            string label = part is FamilySymbol symbol ? (symbol.FamilyName + " " + symbol.Name).Trim() : part?.Name ?? "";
                            rules.Add(new JObject { ["index"] = i, ["part"] = label, ["part_id"] = rule.MEPPartId.Value, ["description"] = rule.Description ?? "" });
                        }
                        catch (Exception) { rules.Add(new JObject { ["index"] = i, ["error"] = "unreadable" }); }
                    }
                    if (n > 0) groups[group.ToString()] = rules;
                }
            }
            catch (Exception ex) { row["error"] = ex.Message; }
            row["routing"] = groups;
            return row;
        }
    }
}
