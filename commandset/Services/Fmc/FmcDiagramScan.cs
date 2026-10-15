using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_diagram_scan (track LD1): one system graph per diagram, read only from Revit's own connections (circuits,
    /// piping systems and connectors, locations), never guessed. The JSON is SCAN_RESULT in server/src/fmc/diagram/contract.ts.
    /// Rule 5: a value the model doesn't hold is null and is listed in gaps; nothing is sized, rated or loaded here.
    /// </summary>
    public static class FmcDiagramScan
    {
        /// <summary>
        /// The diagram kinds (DIAGRAM_KINDS). The parameter keys sent in node and edge params are the first names in the
        /// contract's PARAM_KEYS (panel_id, part_type, distribution_system, ways, circuit, rating, poles, cable, load_name,
        /// apparent_load, zone, loop, system, size); edges run upstream to downstream (supply to board, board to load,
        /// source to component).
        /// </summary>
        public static readonly string[] Kinds =
            { "e_sld", "e_power_riser", "e_fa_riser", "e_elv_riser", "fp_schematic", "p_water", "p_drainage", "m_refrigerant", "lp_schematic", "m_controls" };

        private const double FeetToMm = 304.8;
        private const int MaxGapsPerList = 25;
        private const int MaxSteps = 200000;

        private sealed class Ctx
        {
            public Document Doc;
            public readonly JArray Gaps = new JArray();
            public readonly Dictionary<string, int> NoKeynote = new Dictionary<string, int>();
            public void Gap(string kind, string elementId, string message) =>
                Gaps.Add(new JObject { ["kind"] = kind, ["element_id"] = Str(elementId), ["message"] = message });
        }

        private sealed class Graph
        {
            public readonly string Kind;
            public readonly string System;
            public readonly Dictionary<string, JObject> Nodes = new Dictionary<string, JObject>();
            public readonly List<JObject> Edges = new List<JObject>();
            private readonly Dictionary<string, JObject> _edgeByKey = new Dictionary<string, JObject>();
            private readonly Dictionary<string, int> _certainty = new Dictionary<string, int>();

            public Graph(string kind, string system) { Kind = kind; System = system; }

            public bool Has(string id) => Nodes.ContainsKey(id);

            public void Node(JObject n)
            {
                string id = n.Value<string>("id");
                if (!Nodes.ContainsKey(id)) Nodes[id] = n;
            }

            /// <summary>
            /// Adds an edge once, upstream (`from`) to downstream (`to`); `id` is the circuit, system or pipe element it comes
            /// from (SCAN_EDGE.id). An undirected edge (pipes, conductors) counts once for either direction; when it is found
            /// again with a surer direction (`certainty`: 2 from the connector's flow, 1 from the part kinds, 0 walk order),
            /// the surer direction wins.
            /// </summary>
            public void Edge(string from, string to, string kind, JObject prms, string id = null, bool undirected = false, int certainty = 2)
            {
                if (from == to) return;
                string key = undirected && string.CompareOrdinal(from, to) > 0 ? kind + "|" + to + "|" + from : kind + "|" + from + "|" + to;
                if (_edgeByKey.TryGetValue(key, out JObject old))
                {
                    if (undirected && certainty > _certainty[key])
                    {
                        old["from"] = from;
                        old["to"] = to;
                        _certainty[key] = certainty;
                    }
                    if (IsNull(old["id"]) && !string.IsNullOrWhiteSpace(id)) old["id"] = id;
                    return;
                }
                var e = new JObject { ["id"] = Str(id), ["from"] = from, ["to"] = to, ["kind"] = kind, ["params"] = prms ?? new JObject() };
                Edges.Add(e);
                _edgeByKey[key] = e;
                _certainty[key] = certainty;
            }

            public JObject ToJson() => new JObject
            {
                ["kind"] = Kind,
                ["system"] = System,
                ["nodes"] = new JArray(Nodes.Values),
                ["edges"] = new JArray(Edges),
            };
        }

        public static JObject Scan(Document doc, JObject p)
        {
            var asked = (p?["kinds"] as JArray)?.Select(x => x.ToString()).Where(x => x.Length > 0).ToList() ?? new List<string>();
            foreach (string k in asked)
                if (!Kinds.Contains(k)) throw new InvalidOperationException($"Unknown diagram kind '{k}'. Kinds: {string.Join(", ", Kinds)}.");
            var kinds = new HashSet<string>(asked.Count > 0 ? asked : Kinds.ToList());
            // The power riser is laid out on the server from the e_sld graph, so a request for it scans the SLDs.
            if (kinds.Remove("e_power_riser")) kinds.Add("e_sld");

            var c = new Ctx { Doc = doc };
            var diagrams = new List<Graph>();
            if (kinds.Contains("e_sld")) diagrams.AddRange(Sld(c));
            if (kinds.Contains("e_fa_riser")) diagrams.AddRange(FireAlarm(c));
            if (kinds.Contains("e_elv_riser")) diagrams.AddRange(Elv(c));
            var piping = kinds.Where(k => k == "fp_schematic" || k == "p_water" || k == "p_drainage" || k == "m_refrigerant").ToList();
            if (piping.Count > 0) diagrams.AddRange(Piping(c, new HashSet<string>(piping)));
            if (kinds.Contains("lp_schematic")) diagrams.AddRange(Lightning(c));
            if (kinds.Contains("m_controls")) diagrams.AddRange(Controls(c));

            foreach (string k in Kinds.Where(kinds.Contains))
                if (!diagrams.Any(g => g.Kind == k)) c.Gap(k, null, "Nothing in the model for this diagram yet.");
            foreach (var kv in c.NoKeynote.Where(kv => kv.Value > 0))
                c.Gap(kv.Key, null, $"{kv.Value} part(s) on this diagram have no FMC_Keynote_Code.");

            var levels = new JArray(new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation)
                .Select(l => new JObject { ["id"] = l.UniqueId, ["name"] = l.Name, ["elevation_mm"] = Math.Round(l.Elevation * FeetToMm, 1) }));

            return new JObject
            {
                ["model"] = doc.Title,
                ["levels"] = levels,
                ["diagrams"] = new JArray(diagrams.Select(g => g.ToJson())),
                ["gaps"] = c.Gaps,
            };
        }

        // ---------- helpers ----------

        private static JToken Str(string s) => string.IsNullOrWhiteSpace(s) ? JValue.CreateNull() : new JValue(s);

        /// <summary>A parameter as text: strings as they are, other storage as Revit shows them. Null when missing or empty.</summary>
        private static JToken Text(Parameter par)
        {
            if (par == null || !par.HasValue) return JValue.CreateNull();
            string s = par.StorageType == StorageType.String ? par.AsString() : par.AsValueString();
            return Str(s);
        }

        private static JToken Number(Parameter par, ForgeTypeId unit, int digits = 1)
        {
            if (par == null || !par.HasValue) return JValue.CreateNull();
            switch (par.StorageType)
            {
                case StorageType.Double:
                    double v = unit is null ? par.AsDouble() : UnitUtils.ConvertFromInternalUnits(par.AsDouble(), unit);
                    return new JValue(Math.Round(v, digits));
                case StorageType.Integer: return new JValue(par.AsInteger());
                default: return Text(par);
            }
        }

        private static bool IsNull(JToken t) => t == null || t.Type == JTokenType.Null;

        /// <summary>A shared parameter by name on the instance, else on its type.</summary>
        private static Parameter Shared(Document doc, Element e, string name) =>
            e.LookupParameter(name) ?? doc.GetElement(e.GetTypeId())?.LookupParameter(name);

        private static string CatKey(Element e)
        {
            if (e?.Category == null) return "";
            try { return ((BuiltInCategory)e.Category.Id.Value).ToString(); }
            catch (Exception) { return ""; }
        }

        private static string Family(Element e) => e is FamilyInstance fi && fi.Symbol != null ? fi.Symbol.FamilyName ?? "" : "";

        private static string TypeName(Document doc, Element e) =>
            e is FamilyInstance fi && fi.Symbol != null ? fi.Symbol.Name ?? "" : doc.GetElement(e.GetTypeId())?.Name ?? "";

        /// <summary>Family, type and instance name in lower case, for matching words such as "pump" or "outdoor".</summary>
        private static string Words(Document doc, Element e) => (Family(e) + " " + TypeName(doc, e) + " " + e.Name).ToLowerInvariant();

        private static bool Has(string s, params string[] keys) => keys.Any(k => s.IndexOf(k, StringComparison.Ordinal) >= 0);

        private static string PartType(Element e)
        {
            if (!(e is FamilyInstance fi) || fi.Symbol?.Family == null) return "";
            Parameter par = fi.Symbol.Family.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
            return par == null ? "" : par.AsValueString() ?? "";
        }

        /// <summary>The level of an element: its own, the level that hosts it, or its reference level. Null when it has none.</summary>
        private static string LevelOf(Document doc, Element e)
        {
            ElementId id = e.LevelId;
            if ((id == null || id == ElementId.InvalidElementId) && e is FamilyInstance fi && fi.Host is Level hl) id = hl.Id;
            if (id == null || id == ElementId.InvalidElementId)
                foreach (var bip in new[] { BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM, BuiltInParameter.FAMILY_LEVEL_PARAM,
                                            BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM, BuiltInParameter.RBS_START_LEVEL_PARAM })
                {
                    Parameter par = e.get_Parameter(bip);
                    if (par != null && par.StorageType == StorageType.ElementId && par.AsElementId() != ElementId.InvalidElementId) { id = par.AsElementId(); break; }
                }
            return id != null && doc.GetElement(id) is Level l ? l.UniqueId : null;
        }

        private static JObject NodeOf(Ctx c, string diagram, Element e, string kind, string name = null)
        {
            Parameter code = Shared(c.Doc, e, "FMC_Keynote_Code");
            if (code == null || !code.HasValue || string.IsNullOrWhiteSpace(code.AsString()))
                c.NoKeynote[diagram] = (c.NoKeynote.TryGetValue(diagram, out int n) ? n : 0) + 1;
            return new JObject
            {
                ["id"] = e.UniqueId,
                ["kind"] = kind,
                ["name"] = string.IsNullOrWhiteSpace(name) ? e.Name ?? "" : name,
                ["category"] = e.Category?.Name ?? "",
                ["family"] = Family(e),
                ["type"] = TypeName(c.Doc, e),
                ["level"] = Str(LevelOf(c.Doc, e)),
                ["params"] = new JObject(),
            };
        }

        private static void GapList(Ctx c, string kind, List<(string id, string message)> items, string summary)
        {
            foreach (var it in items.Take(MaxGapsPerList)) c.Gap(kind, it.id, it.message);
            if (items.Count > MaxGapsPerList) c.Gap(kind, null, $"…and {items.Count - MaxGapsPerList} more: {summary}");
        }

        private static IEnumerable<FamilyInstance> Instances(Document doc, BuiltInCategory cat) =>
            new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType().OfType<FamilyInstance>();

        private static IEnumerable<Element> Members(ElementSet set)
        {
            if (set == null) yield break;
            foreach (Element e in set) if (e != null) yield return e;
        }

        private static IEnumerable<Connector> Connectors(Element e)
        {
            ConnectorManager cm = null;
            if (e is MEPCurve mc) cm = mc.ConnectorManager;
            else if (e is FamilyInstance fi) cm = fi.MEPModel?.ConnectorManager;
            if (cm == null) yield break;
            foreach (Connector con in cm.Connectors) yield return con;
        }

        // ---------- E single-line ----------

        private static string BoardName(FamilyInstance b)
        {
            string n = b.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString();
            return string.IsNullOrWhiteSpace(n) ? b.Name : n;
        }

        private static string CircuitLabel(ElectricalSystem s)
        {
            string n = s.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_NUMBER)?.AsString();
            return string.IsNullOrWhiteSpace(n) ? s.Name : n;
        }

        private static (int, string) CircuitOrder(ElectricalSystem s)
        {
            string n = CircuitLabel(s) ?? "";
            string digits = new string(n.TakeWhile(char.IsDigit).ToArray());
            return (digits.Length > 0 && int.TryParse(digits, out int v) ? v : int.MaxValue, n);
        }

        private static List<Graph> Sld(Ctx c)
        {
            const string K = "e_sld";
            Document doc = c.Doc;
            var boards = Instances(doc, BuiltInCategory.OST_ElectricalEquipment).Where(b => b.MEPModel != null).ToList();
            var boardById = boards.ToDictionary(b => b.Id, b => b);
            var circuits = new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>()
                .Where(s => s.SystemType == ElectricalSystemType.PowerCircuit).ToList();

            var circuitsOf = new Dictionary<ElementId, List<ElectricalSystem>>();
            var noBoard = new List<(string, string)>();
            foreach (ElectricalSystem s in circuits)
            {
                FamilyInstance baseEq = s.BaseEquipment;
                if (baseEq == null || !boardById.ContainsKey(baseEq.Id))
                {
                    noBoard.Add(("circuit:" + s.Id, $"Circuit {CircuitLabel(s)} ({s.LoadName}) is on no board."));
                    continue;
                }
                if (!circuitsOf.TryGetValue(baseEq.Id, out var list)) circuitsOf[baseEq.Id] = list = new List<ElectricalSystem>();
                list.Add(s);
            }
            GapList(c, K, noBoard, "circuits on no board");

            // Feeders: a circuit whose loads include another board.
            var fedBy = new Dictionary<ElementId, ElementId>();
            foreach (var kv in circuitsOf)
                foreach (ElectricalSystem s in kv.Value)
                    foreach (Element e in Members(s.Elements))
                        if (e.Id != kv.Key && boardById.ContainsKey(e.Id) && !fedBy.ContainsKey(e.Id)) fedBy[e.Id] = kv.Key;

            var graphs = new List<Graph>();
            var drawn = new HashSet<ElementId>();
            var roots = boards.Where(b => !fedBy.ContainsKey(b.Id)).ToList();
            // Boards fed only in a loop have no root: each starts a tree of its own so nothing is left out.
            roots.AddRange(boards.Where(b => fedBy.ContainsKey(b.Id) && !roots.Contains(b)).ToList());
            foreach (FamilyInstance root in roots)
            {
                if (drawn.Contains(root.Id)) continue;
                var g = new Graph(K, BoardName(root));
                string supply = "supply:" + BoardName(root);
                g.Node(new JObject
                {
                    ["id"] = supply, ["kind"] = "supply", ["name"] = "Supply", ["category"] = "", ["family"] = "", ["type"] = "",
                    ["level"] = JValue.CreateNull(), ["params"] = new JObject(),
                });
                g.Edge(supply, root.UniqueId, "feeder", new JObject());

                var queue = new Queue<FamilyInstance>();
                queue.Enqueue(root);
                drawn.Add(root.Id);
                while (queue.Count > 0)
                {
                    FamilyInstance b = queue.Dequeue();
                    g.Node(BoardNode(c, b));
                    var list = circuitsOf.TryGetValue(b.Id, out var l) ? l.OrderBy(x => CircuitOrder(x)).ToList() : new List<ElectricalSystem>();
                    if (list.Count == 0) c.Gap(K, b.UniqueId, $"Board {BoardName(b)} has no circuits.");
                    foreach (ElectricalSystem s in list)
                    {
                        JObject prms = CircuitParams(c, b, s);
                        var members = Members(s.Elements).ToList();
                        var fed = members.Where(e => e.Id != b.Id && boardById.ContainsKey(e.Id)).Select(e => boardById[e.Id]).ToList();
                        if (fed.Count > 0)
                        {
                            foreach (FamilyInstance sub in fed)
                            {
                                g.Edge(b.UniqueId, sub.UniqueId, "feeder", (JObject)prms.DeepClone(), s.UniqueId);
                                if (drawn.Add(sub.Id)) queue.Enqueue(sub);
                            }
                            continue;
                        }
                        string loadId = "circuit:" + s.Id;
                        Element first = members.FirstOrDefault();
                        string loadName = prms.Value<string>("load_name");
                        g.Node(new JObject
                        {
                            ["id"] = loadId, ["kind"] = "load",
                            ["name"] = string.IsNullOrWhiteSpace(loadName) ? s.Name ?? "" : loadName,
                            ["category"] = first?.Category?.Name ?? "", ["family"] = first == null ? "" : Family(first),
                            ["type"] = first == null ? "" : TypeName(c.Doc, first),
                            ["level"] = Str(first == null ? null : LevelOf(c.Doc, first)),
                            ["params"] = new JObject { ["load_count"] = members.Count, ["apparent_load"] = prms["apparent_load"] },
                        });
                        g.Edge(b.UniqueId, loadId, "circuit", prms, s.UniqueId);
                    }
                }
                graphs.Add(g);
            }

            // Devices with a power connector on no circuit (counted, so the list stays short).
            foreach (var cat in new[] { BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_LightingDevices,
                                         BuiltInCategory.OST_MechanicalEquipment })
            {
                int none = 0;
                string firstId = null, catName = "";
                foreach (FamilyInstance fi in Instances(doc, cat))
                {
                    bool electric = Connectors(fi).Any(x => x.Domain == Domain.DomainElectrical);
                    if (!electric || (fi.MEPModel?.GetElectricalSystems()?.Count ?? 0) > 0) continue;
                    none++;
                    if (firstId == null) { firstId = fi.UniqueId; catName = fi.Category?.Name ?? cat.ToString(); }
                }
                if (none > 0) c.Gap(K, firstId, $"{none} {catName} with a power connector are on no circuit.");
            }
            return graphs;
        }

        private static JObject BoardNode(Ctx c, FamilyInstance b)
        {
            const string K = "e_sld";
            JObject n = NodeOf(c, K, b, "board", BoardName(b));
            JToken panelId = Text(Shared(c.Doc, b, "FMC_Panel_ID"));
            JToken mains = Text(b.get_Parameter(BuiltInParameter.RBS_ELEC_MAINS));
            n["params"] = new JObject
            {
                ["panel_id"] = panelId,
                ["part_type"] = Str(PartType(b)),
                ["distribution_system"] = Text(b.get_Parameter(BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM)),
                ["ways"] = Number(Shared(c.Doc, b, "FMC_Ways"), null, 0),
                ["mains"] = mains,
            };
            if (IsNull(n["params"]["ways"])) n["params"]["ways"] = Number(b.get_Parameter(BuiltInParameter.RBS_ELEC_MAX_POLE_BREAKERS), null, 0);
            if (IsNull(panelId)) c.Gap(K, b.UniqueId, $"Board {BoardName(b)} has no FMC_Panel_ID.");
            return n;
        }

        private static JObject CircuitParams(Ctx c, FamilyInstance board, ElectricalSystem s)
        {
            const string K = "e_sld";
            JToken cable = Text(Shared(c.Doc, s, "FMC_Cable_Spec"));
            if (IsNull(cable)) cable = Text(s.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_SIZE_PARAM));
            var prms = new JObject
            {
                ["circuit"] = Text(s.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_NUMBER)),
                ["rating"] = Number(s.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM), UnitTypeId.Amperes, 1),
                ["poles"] = Number(s.get_Parameter(BuiltInParameter.RBS_ELEC_NUMBER_OF_POLES), null, 0),
                ["cable"] = cable,
                ["load_name"] = Text(s.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_NAME)),
                ["apparent_load"] = Number(s.get_Parameter(BuiltInParameter.RBS_ELEC_APPARENT_LOAD), UnitTypeId.VoltAmperes, 0),
                ["voltage"] = Number(s.get_Parameter(BuiltInParameter.RBS_ELEC_VOLTAGE), UnitTypeId.Volts, 0),
            };
            string where = $"Circuit {CircuitLabel(s)} on {BoardName(board)}";
            string id = "circuit:" + s.Id;
            if (IsNull(prms["circuit"])) c.Gap(K, id, $"{where} has no circuit number.");
            if (IsNull(prms["rating"])) c.Gap(K, id, $"{where} has no rating.");
            if (IsNull(prms["cable"])) c.Gap(K, id, $"{where} has no cable (FMC_Cable_Spec or wire size).");
            if (IsNull(prms["load_name"])) c.Gap(K, id, $"{where} has no load name.");
            return prms;
        }

        // ---------- E fire alarm riser ----------

        private static bool IsPanel(Document doc, Element e)
        {
            string w = Words(doc, e);
            return Has(w, "panel", "facp") || PartType(e).ToLowerInvariant().Contains("panel");
        }

        private static List<Graph> FireAlarm(Ctx c)
        {
            const string K = "e_fa_riser";
            Document doc = c.Doc;
            var devices = Instances(doc, BuiltInCategory.OST_FireAlarmDevices).ToList();
            var systems = new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>()
                .Where(s => s.SystemType == ElectricalSystemType.FireAlarm).ToList();
            if (devices.Count == 0 && systems.Count == 0) return new List<Graph>();

            var loopOf = new Dictionary<ElementId, string>();
            foreach (ElectricalSystem s in systems)
                foreach (Element e in Members(s.Elements))
                    if (!loopOf.ContainsKey(e.Id)) loopOf[e.Id] = s.Name;

            var g = new Graph(K, "Fire alarm");
            JObject FaNode(Element e, string kind)
            {
                JObject n = NodeOf(c, K, e, kind);
                n["params"] = new JObject
                {
                    ["zone"] = Text(Shared(doc, e, "FMC_Fire_Compartment")),
                    ["loop"] = Str(loopOf.TryGetValue(e.Id, out string loop) ? loop : null),
                };
                return n;
            }

            var loose = new List<(string, string)>();
            foreach (FamilyInstance d in devices)
            {
                bool panel = IsPanel(doc, d);
                g.Node(FaNode(d, panel ? "panel" : "device"));
                if (!panel && !loopOf.ContainsKey(d.Id)) loose.Add((d.UniqueId, $"Fire alarm device {d.Name} is on no fire alarm system (no loop)."));
            }
            GapList(c, K, loose, "fire alarm devices on no loop");

            foreach (ElectricalSystem s in systems)
            {
                var members = Members(s.Elements).ToList();
                Element panel = (Element)s.BaseEquipment ?? members.FirstOrDefault(e => IsPanel(doc, e));
                if (panel == null) { c.Gap(K, null, $"Fire alarm system {s.Name} has no panel."); continue; }
                if (!g.Has(panel.UniqueId)) g.Node(FaNode(panel, "panel"));
                else g.Nodes[panel.UniqueId]["kind"] = "panel";
                foreach (Element e in members.Where(e => e.Id != panel.Id))
                {
                    if (!g.Has(e.UniqueId)) g.Node(FaNode(e, "device"));
                    g.Edge(panel.UniqueId, e.UniqueId, "loop", new JObject { ["loop"] = s.Name }, s.UniqueId);
                }
            }
            if (!g.Nodes.Values.Any(n => n.Value<string>("kind") == "panel")) c.Gap(K, null, "No fire alarm panel (FACP) found.");
            return new List<Graph> { g };
        }

        // ---------- E ELV / security riser ----------

        private static List<Graph> Elv(Ctx c)
        {
            const string K = "e_elv_riser";
            Document doc = c.Doc;
            var g = new Graph(K, "ELV and security");
            var cats = new[] { BuiltInCategory.OST_DataDevices, BuiltInCategory.OST_SecurityDevices, BuiltInCategory.OST_CommunicationDevices,
                               BuiltInCategory.OST_NurseCallDevices, BuiltInCategory.OST_TelephoneDevices };
            var inScope = new HashSet<ElementId>();
            foreach (var cat in cats)
                foreach (FamilyInstance d in Instances(doc, cat))
                {
                    JObject n = NodeOf(c, K, d, "device");
                    n["params"] = new JObject { ["system"] = d.Category?.Name ?? "" };
                    g.Node(n);
                    inScope.Add(d.Id);
                }
            foreach (FamilyInstance eq in Instances(doc, BuiltInCategory.OST_ElectricalEquipment))
            {
                if (!Has(Words(doc, eq), "rack", "nvr", "energiser", "energizer")) continue;
                JObject n = NodeOf(c, K, eq, "equipment");
                n["params"] = new JObject { ["system"] = eq.Category?.Name ?? "" };
                g.Node(n);
                inScope.Add(eq.Id);
            }
            if (g.Nodes.Count == 0) return new List<Graph>();

            // Low-voltage systems Revit holds (data, security, communication, nurse call, telephone, controls).
            var onSystem = new HashSet<ElementId>();
            foreach (ElectricalSystem s in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>()
                         .Where(s => s.SystemType != ElectricalSystemType.PowerCircuit && s.SystemType != ElectricalSystemType.FireAlarm))
            {
                var members = Members(s.Elements).Where(e => inScope.Contains(e.Id)).ToList();
                if (members.Count == 0) continue;
                FamilyInstance head = s.BaseEquipment;
                if (head == null) { c.Gap(K, null, $"System {s.Name} has no equipment it starts from."); continue; }
                if (!g.Has(head.UniqueId))
                {
                    JObject n = NodeOf(c, K, head, "equipment");
                    n["params"] = new JObject { ["system"] = head.Category?.Name ?? "" };
                    g.Node(n);
                }
                foreach (Element e in members.Where(e => e.Id != head.Id))
                {
                    onSystem.Add(e.Id);
                    g.Edge(head.UniqueId, e.UniqueId, "data", new JObject { ["system"] = s.Name }, s.UniqueId);
                }
            }
            int loose = inScope.Count(id => !onSystem.Contains(id) && !(doc.GetElement(id) is FamilyInstance fi && CatKey(fi) == "OST_ElectricalEquipment"));
            if (loose > 0) c.Gap(K, null, $"{loose} ELV device(s) are on no system in the model; they are shown by level only.");
            return new List<Graph> { g };
        }

        // ---------- Piping: FP, plumbing water and drainage, refrigerant ----------

        private static string PipeNodeKind(Document doc, FamilyInstance fi)
        {
            string w = Words(doc, fi);
            switch (CatKey(fi))
            {
                case "OST_MechanicalEquipment":
                    if (Has(w, "outdoor", "condensing", "odu")) return "outdoor_unit";
                    if (Has(w, "indoor", "fan coil", "fcu", "cassette", "idu", "split", "wall mounted", "ducted")) return "indoor_unit";
                    return Has(w, "pump") ? "pump" : Has(w, "tank") ? "tank" : "equipment";
                case "OST_PlumbingEquipment":
                    return Has(w, "pump") ? "pump" : Has(w, "tank") ? "tank" : "equipment";
                case "OST_PipeAccessory":
                    return Has(w, "meter") ? "meter" : "valve";
                case "OST_PlumbingFixtures":
                    return "fixture";
                case "OST_Sprinklers":
                    return "sprinkler";
                case "OST_SpecialityEquipment":
                    if (Has(w, "hose reel", "hosereel", "hose_reel")) return "hose_reel";
                    if (Has(w, "hydrant")) return "hydrant";
                    if (Has(w, "breeching", "inlet")) return "inlet";
                    return "equipment";
                default:
                    return "other";
            }
        }

        private static bool IsFitting(Element e) => CatKey(e) == "OST_PipeFitting";

        private static List<string> PipingKinds(Document doc, PipingSystem ps)
        {
            var type = doc.GetElement(ps.GetTypeId()) as PipingSystemType;
            string cls = type == null ? "" : type.SystemClassification.ToString();
            string names = ((type?.Name ?? "") + " " + (ps.Name ?? "")).ToLowerInvariant();
            var kinds = new List<string>();
            bool refrigerant = names.Contains("refrigerant");
            if (refrigerant) { kinds.Add("m_refrigerant"); return kinds; }
            if (cls.StartsWith("FireProtect", StringComparison.Ordinal)) kinds.Add("fp_schematic");
            if (cls == "DomesticColdWater" || cls == "DomesticHotWater") kinds.Add("p_water");
            if (cls == "Sanitary" || cls == "Vent" || cls == "Storm") kinds.Add("p_drainage");
            if (cls == "Sanitary" && Members(ps.Elements).Any(e => CatKey(e) == "OST_MechanicalEquipment")) kinds.Add("m_refrigerant");
            return kinds;
        }

        /// <summary>
        /// Where a part sits in the flow when the connectors don't say (lower is upstream): supply side first (meter, inlet,
        /// outdoor unit, tank, pump, valves), terminals last; in drainage the fixtures come first and the stacks follow.
        /// </summary>
        private static int FlowRank(string diagram, string nodeKind)
        {
            if (diagram == "p_drainage") return nodeKind == "fixture" ? 0 : nodeKind == "pump" || nodeKind == "tank" ? 4 : 2;
            switch (nodeKind)
            {
                case "meter": case "inlet": case "outdoor_unit": return 0;
                case "tank": return 1;
                case "pump": return 2;
                case "valve": case "equipment": return 3;
                case "fixture": case "sprinkler": case "hose_reel": case "hydrant": case "indoor_unit": return 6;
                default: return 4;
            }
        }

        private static List<Graph> Piping(Ctx c, HashSet<string> wanted)
        {
            Document doc = c.Doc;
            var graphs = new List<Graph>();
            foreach (PipingSystem ps in new FilteredElementCollector(doc).OfClass(typeof(PipingSystem)).Cast<PipingSystem>())
            {
                List<string> kinds;
                try { kinds = PipingKinds(doc, ps).Where(wanted.Contains).ToList(); }
                catch (Exception) { continue; }
                foreach (string kind in kinds)
                {
                    string edgeKind = kind != "m_refrigerant" ? "pipe"
                        : (((doc.GetElement(ps.GetTypeId())?.Name ?? "") + " " + ps.Name).ToLowerInvariant().Contains("refrigerant") ? "refrigerant" : "condensate");
                    graphs.Add(PipingGraph(c, ps, kind, edgeKind));
                }
            }
            return graphs;
        }

        private static Graph PipingGraph(Ctx c, PipingSystem ps, string kind, string edgeKind)
        {
            Document doc = c.Doc;
            var g = new Graph(kind, ps.Name ?? "");
            var comps = new Dictionary<ElementId, FamilyInstance>();
            foreach (Element e in Members(ps.Elements))
                if (e is FamilyInstance fi && !IsFitting(fi)) comps[fi.Id] = fi;

            int openEnds = 0;
            string firstOpen = null;
            ElementSet network = null;
            try { network = ps.PipingNetwork; } catch (Exception) { /* very large or broken systems */ }
            foreach (Element e in Members(network))
            {
                if (e is FamilyInstance fi && !IsFitting(fi)) comps[fi.Id] = fi;
                else if (e is MEPCurve)
                {
                    int open = Connectors(e).Count(x => x.ConnectorType == ConnectorType.End && !x.IsConnected);
                    if (open > 0) { openEnds += open; if (firstOpen == null) firstOpen = e.UniqueId; }
                }
            }
            if (openEnds > 0) c.Gap(kind, firstOpen, $"System {ps.Name}: {openEnds} pipe end(s) are not connected.");
            if (comps.Count == 0) { c.Gap(kind, null, $"System {ps.Name} has no equipment, valves or fixtures."); return g; }

            JObject PNode(FamilyInstance fi)
            {
                JObject n = NodeOf(c, kind, fi, PipeNodeKind(doc, fi));
                n["params"] = new JObject { ["system"] = ps.Name ?? "" };
                return n;
            }
            foreach (FamilyInstance fi in comps.Values) g.Node(PNode(fi));

            int steps = 0;
            bool capped = false;
            foreach (FamilyInstance start in comps.Values.ToList())
            {
                foreach (Connector con in Connectors(start).Where(x => x.Domain == Domain.DomainPiping && x.IsConnected))
                {
                    // Upstream to downstream: the connector's flow when Revit has one, else the part kinds (FlowRank).
                    FlowDirectionType flow = FlowDirectionType.Bidirectional;
                    try { flow = con.Direction; } catch (Exception) { /* no direction */ }
                    var visited = new HashSet<ElementId> { start.Id };
                    var stack = new Stack<(Element el, double dia, string pipe)>();
                    foreach (Connector r in con.AllRefs)
                        if (r.Owner != null && r.Owner.Id != start.Id && r.ConnectorType != ConnectorType.Logical) stack.Push((r.Owner, 0, null));
                    while (stack.Count > 0)
                    {
                        if (++steps > MaxSteps) { capped = true; break; }
                        var (el, dia, pipe) = stack.Pop();
                        if (!visited.Add(el.Id)) continue;
                        if (el is MEPCurve)
                        {
                            if (pipe == null) pipe = el.UniqueId;
                            Parameter d = el.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
                            if (d != null && d.StorageType == StorageType.Double) dia = Math.Max(dia, d.AsDouble());
                        }
                        else if (el is FamilyInstance other && !IsFitting(other))
                        {
                            if (!g.Has(other.UniqueId)) g.Node(PNode(other));
                            var prms = new JObject
                            {
                                ["size"] = dia > 0 ? new JValue(Math.Round(dia * FeetToMm).ToString(CultureInfo.InvariantCulture) + " mm") : JValue.CreateNull(),
                                ["system"] = ps.Name ?? "",
                            };
                            if (flow == FlowDirectionType.In)
                                g.Edge(other.UniqueId, start.UniqueId, edgeKind, prms, pipe, undirected: true, certainty: 2);
                            else if (flow == FlowDirectionType.Out)
                                g.Edge(start.UniqueId, other.UniqueId, edgeKind, prms, pipe, undirected: true, certainty: 2);
                            else
                            {
                                int rs = FlowRank(kind, g.Nodes[start.UniqueId].Value<string>("kind"));
                                int ro = FlowRank(kind, g.Nodes[other.UniqueId].Value<string>("kind"));
                                if (ro < rs) g.Edge(other.UniqueId, start.UniqueId, edgeKind, prms, pipe, undirected: true, certainty: 1);
                                else g.Edge(start.UniqueId, other.UniqueId, edgeKind, prms, pipe, undirected: true, certainty: rs < ro ? 1 : 0);
                            }
                            continue;
                        }
                        else if (!(el is FamilyInstance)) continue;
                        foreach (Connector x in Connectors(el).Where(x => x.IsConnected))
                            foreach (Connector r in x.AllRefs)
                                if (r.Owner != null && r.Owner.Id != el.Id && r.ConnectorType != ConnectorType.Logical && !visited.Contains(r.Owner.Id))
                                    stack.Push((r.Owner, dia, pipe));
                    }
                    if (capped) break;
                }
                if (capped) break;
            }
            if (capped) c.Gap(kind, null, $"System {ps.Name} is too large to follow completely; some connections are missing from this diagram.");
            return g;
        }

        // ---------- LP schematic ----------

        private static string LpKind(string part, string words)
        {
            string s = part + " " + words;
            if (Has(s, "test")) return "test_joint";
            if (Has(s, "spd", "surge")) return "spd";
            if (Has(s, "earth bar", "earthbar", "earth_bar", "bar")) return "earth_bar";
            if (part.StartsWith("air", StringComparison.Ordinal)) return "air_terminal";
            if (part.StartsWith("down", StringComparison.Ordinal)) return "down_conductor";
            if (part.StartsWith("earth", StringComparison.Ordinal)) return "earth_pit";
            if (part.StartsWith("bond", StringComparison.Ordinal)) return "bond";
            return "other";
        }

        private static int LpRank(string nodeKind)
        {
            switch (nodeKind)
            {
                case "air_terminal": return 0;
                case "down_conductor": return 1;
                case "test_joint": return 2;
                case "earth_bar": return 4;
                case "earth_pit": return 5;
                default: return 3; // spd, bond, other
            }
        }

        private static List<XYZ> Ends(Element e)
        {
            var pts = new List<XYZ>();
            if (e.Location is LocationPoint lp && lp.Point != null) pts.Add(lp.Point);
            else if (e.Location is LocationCurve lc && lc.Curve != null && lc.Curve.IsBound) { pts.Add(lc.Curve.GetEndPoint(0)); pts.Add(lc.Curve.GetEndPoint(1)); }
            return pts;
        }

        private static List<Graph> Lightning(Ctx c)
        {
            const string K = "lp_schematic";
            Document doc = c.Doc;
            var cats = new List<BuiltInCategory> { BuiltInCategory.OST_GenericModel, BuiltInCategory.OST_SpecialityEquipment };
            var parts = new List<(Element el, List<XYZ> pts)>();
            var g = new Graph(K, "Lightning protection and earthing");
            var noPart = new List<(string, string)>();
            foreach (Element e in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats)).WhereElementIsNotElementType())
            {
                Parameter par = Shared(doc, e, "FMC_LP_Part");
                if (par == null) continue;
                JToken partVal = Text(par);
                string part = IsNull(partVal) ? "" : partVal.ToString().ToLowerInvariant();
                if (part.Length == 0) noPart.Add((e.UniqueId, $"{e.Name} has FMC_LP_Part empty (Air, Down, Earth or Bond)."));
                JObject n = NodeOf(c, K, e, LpKind(part, Words(doc, e)));
                n["params"] = new JObject { ["part"] = partVal };
                g.Node(n);
                parts.Add((e, Ends(e)));
            }
            GapList(c, K, noPart, "LP parts with FMC_LP_Part empty");
            if (g.Nodes.Count == 0) return new List<Graph>();

            if (parts.Count > 4000)
                c.Gap(K, null, $"{parts.Count} LP parts: too many to join by location; conductors are not listed.");
            else
            {
                double tol = 100 / FeetToMm;
                for (int i = 0; i < parts.Count; i++)
                    for (int j = i + 1; j < parts.Count; j++)
                        if (parts[i].pts.Any(a => parts[j].pts.Any(b => a.DistanceTo(b) <= tol)))
                        {
                            // Air termination to earth: the part nearer the air terminals is upstream.
                            string ui = parts[i].el.UniqueId, uj = parts[j].el.UniqueId;
                            int ri = LpRank(g.Nodes[ui].Value<string>("kind")), rj = LpRank(g.Nodes[uj].Value<string>("kind"));
                            if (rj < ri) g.Edge(uj, ui, "conductor", new JObject(), null, undirected: true, certainty: 1);
                            else g.Edge(ui, uj, "conductor", new JObject(), null, undirected: true, certainty: ri < rj ? 1 : 0);
                        }
                foreach (var pt in parts.Where(x => x.pts.Count == 0))
                    c.Gap(K, pt.el.UniqueId, $"{pt.el.Name} has no location point or line, so it can't be joined.");
            }
            return new List<Graph> { g };
        }

        // ---------- M building automation and controls ----------

        private static readonly BuiltInCategory[] ControlsCats =
        {
            BuiltInCategory.OST_ElectricalEquipment, BuiltInCategory.OST_DataDevices, BuiltInCategory.OST_MechanicalEquipment,
            BuiltInCategory.OST_DuctAccessory, BuiltInCategory.OST_PipeAccessory, BuiltInCategory.OST_LightingDevices,
            BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_SecurityDevices, BuiltInCategory.OST_SpecialityEquipment,
        };

        /// <summary>
        /// Node kind from the category and the family, type and instance names: in Electrical Equipment a gateway, a drive
        /// (VFD, drive, starter) or a controller (controller, DDC, BMS, head end); elsewhere too an actuator (actuator,
        /// motorised, solenoid) or a sensor (sensor, detector, thermostat, switch, meter); else a device.
        /// </summary>
        private static string ControlsKind(Document doc, Element e)
        {
            string w = Words(doc, e);
            if (CatKey(e) == "OST_ElectricalEquipment")
            {
                if (Has(w, "gateway")) return "gateway";
                if (Has(w, "vfd", "drive", "starter")) return "drive";
                if (Has(w, "controller", "ddc", "bms", "headend", "head end", "head_end", "head-end")) return "controller";
            }
            if (Has(w, "actuator", "motorised", "motorized", "solenoid")) return "actuator";
            if (Has(w, "sensor", "detector", "thermostat", "switch", "meter")) return "sensor";
            return "device";
        }

        private static string Key(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().ToUpperInvariant();

        /// <summary>
        /// The controls network (m_controls): elements carrying FMC_Controller_ID (with FMC_Point_Type, FMC_Point_Signal,
        /// FMC_Protocol). A device's FMC_Controller_ID names its controller, matched on the controller's Mark, then its
        /// Panel Name, then its type name; a controller's FMC_Controller_ID names its supervisor (head end or gateway).
        /// Edges are "data": controller to device, supervisor to controller. An id that matches no controller is a gap,
        /// never a guess.
        /// </summary>
        private static List<Graph> Controls(Ctx c)
        {
            const string K = "m_controls";
            Document doc = c.Doc;
            var g = new Graph(K, "Building controls");
            var found = new List<(Element el, JObject node)>();
            foreach (Element e in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(ControlsCats.ToList()))
                         .WhereElementIsNotElementType().ToList().OrderBy(x => x.UniqueId, StringComparer.Ordinal))
            {
                Parameter cid = Shared(doc, e, "FMC_Controller_ID");
                if (cid == null) continue; // the kit parameter isn't on this element
                string kind = ControlsKind(doc, e);
                JToken id = Text(cid), pointType = Text(Shared(doc, e, "FMC_Point_Type"));
                bool network = kind == "controller" || kind == "gateway";
                if (!network && IsNull(id) && IsNull(pointType)) continue; // carries the parameter but takes no part
                JObject n = NodeOf(c, K, e, kind);
                string level = LevelOf(doc, e);
                n["params"] = new JObject
                {
                    ["controller_id"] = id,
                    ["point_type"] = pointType,
                    ["signal"] = Text(Shared(doc, e, "FMC_Point_Signal")),
                    ["protocol"] = Text(Shared(doc, e, "FMC_Protocol")),
                    ["mark"] = Text(e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)),
                    ["level"] = Str(level == null ? null : (doc.GetElement(level) as Level)?.Name),
                };
                g.Node(n);
                found.Add((e, n));
            }
            if (found.Count == 0) return new List<Graph>();

            // Controllers by Mark, then Panel Name, then type name (the first by UniqueId when two share a name).
            var byMark = new Dictionary<string, List<Element>>();
            var byPanel = new Dictionary<string, List<Element>>();
            var byType = new Dictionary<string, List<Element>>();
            void Add(Dictionary<string, List<Element>> d, string k, Element e)
            {
                if (k == null) return;
                if (!d.TryGetValue(k, out var l)) d[k] = l = new List<Element>();
                l.Add(e);
            }
            foreach (var (el, node) in found)
            {
                string kind = node.Value<string>("kind");
                if (kind != "controller" && kind != "gateway") continue;
                Add(byMark, Key(el.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()), el);
                Add(byPanel, Key(el.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString()), el);
                Add(byType, Key(TypeName(doc, el)), el);
            }
            Element Find(string id, out int count)
            {
                string k = Key(id);
                count = 0;
                if (k == null) return null;
                foreach (var d in new[] { byMark, byPanel, byType })
                    if (d.TryGetValue(k, out var l)) { count = l.Count; return l[0]; }
                return null;
            }

            var noId = new List<(string, string)>();
            var unknown = new List<(string, string)>();
            var noProtocol = new List<(string, string)>();
            foreach (var (el, node) in found)
            {
                var prms = (JObject)node["params"];
                string kind = node.Value<string>("kind");
                bool network = kind == "controller" || kind == "gateway";
                string label = IsNull(prms["mark"]) ? el.Name : prms.Value<string>("mark");
                if (network && IsNull(prms["protocol"])) noProtocol.Add((el.UniqueId, $"Controller {label} has no FMC_Protocol."));
                if (IsNull(prms["controller_id"]))
                {
                    if (!network && !IsNull(prms["point_type"]))
                        noId.Add((el.UniqueId, $"{label} has a point type ({prms.Value<string>("point_type")}) but no FMC_Controller_ID."));
                    continue;
                }
                string cid = prms.Value<string>("controller_id");
                Element ctl = Find(cid, out int count);
                if (ctl == null)
                {
                    unknown.Add((el.UniqueId, $"{label}: FMC_Controller_ID \"{cid}\" matches no controller (Mark, Panel Name or type name)."));
                    continue;
                }
                if (ctl.Id == el.Id) continue; // a controller naming itself is no link
                if (count > 1) c.Gap(K, ctl.UniqueId, $"FMC_Controller_ID \"{cid}\" matches {count} controllers; {label} is linked to the first.");
                var edge = new JObject();
                if (network) edge["protocol"] = prms["protocol"];
                else edge["signal"] = prms["signal"];
                g.Edge(ctl.UniqueId, el.UniqueId, "data", edge);
            }
            GapList(c, K, noId, "points with no FMC_Controller_ID");
            GapList(c, K, unknown, "controller ids that match no controller");
            GapList(c, K, noProtocol, "controllers with no FMC_Protocol");
            return new List<Graph> { g };
        }
    }
}
