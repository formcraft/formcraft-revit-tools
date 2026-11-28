using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.SystemTypes
{
    /// <summary>
    /// The system-type editor's Revit-free rules (modify_model duplicate_type, edit_type, delete_type and the plan-only
    /// dry run). Everything here is pure: it reads JSON and plain rows and says what an edit would do, or why it is
    /// refused. The Revit side (FmcModelTypes.cs, FmcModelTypesMep.cs) reads the type, asks this class, and writes only
    /// in a real run. Tested offline by tests/systypes.
    /// Scope (coordination note 28 Nov): type definitions only. Nothing here sizes, routes or changes a pipe, duct or
    /// tray run; that is the MEP tools' work.
    /// </summary>
    public static class TypeEditCore
    {
        public const string CodeNeedsPerson = "FMC-NEEDS-PERSON";
        public const string CodeUnknownKey = "FMC-TYPE-UNKNOWN-KEY";
        public const string CodeWrongKind = "FMC-TYPE-EDIT-NOT-FOR-KIND";
        public const string CodeBadValue = "FMC-TYPE-BAD-VALUE";
        public const string CodeReadOnly = "FMC-API-READONLY";
        public const string CodeNameTaken = "FMC-TYPE-NAME-TAKEN";
        public const string CodeRuleExists = "FMC-RULE-EXISTS";
        public const string CodeSizeExists = "FMC-SIZE-EXISTS";
        public const string CodePlanOnlyTypes = "FMC-PLAN-ONLY-TYPES";
        public const string CodeTypeRequired = "FMC-TYPE-REQUIRED";
        public const string CodeTypeNotFound = "FMC-TYPE-NOT-FOUND";
        public const string CodeThicknessMismatch = "FMC-TYPE-THICKNESS-MISMATCH";
        public const string CodeNoThicknessMatch = "FMC-TYPE-NO-THICKNESS-MATCH";
        public const string CodeAmbiguous = "FMC-TYPE-AMBIGUOUS";

        /// <summary>Revit's own limit on stair lengths (ArgumentOutOfRangeException above 30000 ft).</summary>
        public const double MaxStairMm = 30000 * 304.8;

        /// <summary>Keys an edit_type / duplicate_type op may carry besides its edit groups.</summary>
        public static readonly HashSet<string> CommonKeys = new HashSet<string>(StringComparer.Ordinal)
        { "op", "type", "type_name", "kind", "new_name", "partial", "why", "comment", "select", "ids", "for_each" };

        /// <summary>Edit groups, and the Revit type classes each one applies to.</summary>
        public static readonly Dictionary<string, string[]> Groups = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["layers"] = new[] { "WallType", "FloorType", "RoofType", "CeilingType" },
            ["layer_edits"] = new[] { "WallType", "FloorType", "RoofType", "CeilingType" },
            ["core"] = new[] { "WallType", "FloorType", "RoofType", "CeilingType" },
            ["structural_layer"] = new[] { "WallType", "FloorType", "RoofType", "CeilingType" },
            ["wrapping"] = new[] { "WallType" },
            ["params"] = null, // every type
            ["stair"] = new[] { "StairsType" },
            ["stair_run"] = new[] { "StairsType", "StairsRunType" },
            ["stair_landing"] = new[] { "StairsType", "StairsLandingType" },
            ["routing"] = new[] { "PipeType", "DuctType" },
            ["segment_sizes"] = new[] { "PipeType" },
            ["fittings"] = new[] { "CableTrayType" },
            ["fitting_params"] = new[] { "CableTrayType" },
        };

        /// <summary>kind (what a person calls it) to the Revit class name.</summary>
        public static readonly Dictionary<string, string> Kinds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["wall"] = "WallType", ["floor"] = "FloorType", ["roof"] = "RoofType", ["ceiling"] = "CeilingType",
            ["stair"] = "StairsType", ["stair_run"] = "StairsRunType", ["stair_landing"] = "StairsLandingType",
            ["pipe"] = "PipeType", ["duct"] = "DuctType", ["cable_tray"] = "CableTrayType", ["conduit"] = "ConduitType",
        };

        public static readonly string[] LayerFunctions = { "Structure", "Substrate", "Insulation", "Finish1", "Finish2", "Membrane", "StructuralDeck" };

        public static JObject Item(string item, bool ok, string code = null, string reason = null)
        {
            var r = new JObject { ["item"] = item, ["ok"] = ok };
            if (code != null) r["code"] = code;
            if (reason != null) r["reason"] = reason;
            return r;
        }

        /// <summary>Which edit groups the op asks for, in order, and a refusal row for every key no group or common key knows.</summary>
        public static List<string> RequestedGroups(JObject op, JArray items)
        {
            var groups = new List<string>();
            foreach (var kv in op)
            {
                if (CommonKeys.Contains(kv.Key) || kv.Key.StartsWith("_", StringComparison.Ordinal)) continue;
                if (Groups.ContainsKey(kv.Key)) groups.Add(kv.Key);
                else items.Add(Item(kv.Key, false, CodeUnknownKey,
                    $"{kv.Key} isn't a type edit (groups: {string.Join(", ", Groups.Keys)}); nothing was applied for it"));
            }
            return groups;
        }

        /// <summary>Null when the group applies to this kind of type; otherwise why not, with the right path.</summary>
        public static string WrongKind(string group, string typeClass)
        {
            if (!Groups.TryGetValue(group, out string[] kinds) || kinds == null || kinds.Contains(typeClass)) return null;
            if (typeClass == "ConduitType" && (group == "fittings" || group == "fitting_params" || group == "routing"))
                return "conduit types are edited by fmc_conduit apply (fittings and sizes); this op leaves them to it";
            if ((typeClass == "PipeType" || typeClass == "DuctType") && (group == "fittings" || group == "fitting_params"))
                return "pipe and duct fittings live in the type's routing preferences: use routing {add: [{group: elbows, part, ...}]}";
            return $"{group} applies to {string.Join(", ", kinds)}, not {typeClass}";
        }

        // ---------------- compound layers ----------------

        public sealed class LayerRow
        {
            public double WidthMm;
            public string Function = "Structure";
            /// <summary>A material name to look up; null keeps MaterialId.</summary>
            public string Material;
            /// <summary>The current material's id (-1 none) when Material is null.</summary>
            public long MaterialId = -1;
            public bool? Wraps;
            public LayerRow Clone() => (LayerRow)MemberwiseClone();
            public JObject ToJson(Func<long, string> materialName = null) => new JObject
            {
                ["function"] = Function, ["width_mm"] = Math.Round(WidthMm, 1),
                ["material"] = Material ?? (MaterialId > 0 ? (materialName?.Invoke(MaterialId) ?? MaterialId.ToString(CultureInfo.InvariantCulture)) : null),
                ["wraps"] = Wraps,
            };
        }

        public sealed class LayerPlan
        {
            public List<LayerRow> Layers = new List<LayerRow>();
            public int ExteriorShell;
            public int InteriorShell;
            public int StructuralIndex = -1;
            public bool Ok = true;
            public bool Changed;
            public double TotalMm => Layers.Sum(l => l.WidthMm);
        }

        public static string NormaliseFunction(string f)
        {
            if (string.IsNullOrWhiteSpace(f)) return null;
            string s = f.Replace(" ", "").Replace("_", "");
            return LayerFunctions.FirstOrDefault(x => string.Equals(x, s, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// The layers after layers (replace all), layer_edits (in place, by index, exterior or top first), core and
        /// structural_layer. One row per requested edit. Layer rules checked here: a membrane is 0 mm, any other layer is
        /// over 0 mm, at least one layer, the core boundaries leave a core. Revit's own IsValid runs on top on the Revit side.
        /// </summary>
        public static LayerPlan PlanLayers(IList<LayerRow> current, int exteriorShell, int interiorShell, int structuralIndex, JObject op, JArray items)
        {
            var plan = new LayerPlan
            {
                Layers = current.Select(l => l.Clone()).ToList(),
                ExteriorShell = exteriorShell, InteriorShell = interiorShell, StructuralIndex = structuralIndex,
            };
            void Fail(string item, string code, string reason) { plan.Ok = false; items.Add(Item(item, false, code, reason)); }

            if (op["layers"] != null)
            {
                if (!(op["layers"] is JArray arr) || arr.Count == 0) Fail("layers", CodeBadValue, "layers is a non-empty list of {function, width_mm, material?}");
                else
                {
                    var list = new List<LayerRow>();
                    bool bad = false;
                    for (int i = 0; i < arr.Count; i++)
                    {
                        if (!(arr[i] is JObject l)) { Fail($"layers[{i}]", CodeBadValue, "each layer is an object"); bad = true; continue; }
                        string fn = NormaliseFunction(l.Value<string>("function") ?? "Structure");
                        double? w = Num(l["width_mm"]);
                        if (fn == null) { Fail($"layers[{i}]", CodeBadValue, $"function {l.Value<string>("function")} isn't one of {string.Join(", ", LayerFunctions)}"); bad = true; continue; }
                        if (w == null) { Fail($"layers[{i}]", CodeBadValue, "width_mm is required"); bad = true; continue; }
                        list.Add(new LayerRow { Function = fn, WidthMm = w.Value, Material = l.Value<string>("material"), MaterialId = -1, Wraps = l.Value<bool?>("wraps") });
                        items.Add(Item($"layers[{i}]", true));
                    }
                    if (!bad)
                    {
                        plan.Layers = list; plan.Changed = true;
                        // A new list: the first structure layer carries the structural material (as duplicate_type always did)
                        if (op["structural_layer"] == null) plan.StructuralIndex = list.FindIndex(x => x.Function == "Structure");
                        if (plan.ExteriorShell + plan.InteriorShell >= list.Count)
                        {
                            items.Add(Item("core", true, null, $"core boundaries reset to 0/0: the old {plan.ExteriorShell}/{plan.InteriorShell} shell layers don't fit {list.Count} layers"));
                            plan.ExteriorShell = 0; plan.InteriorShell = 0;
                        }
                    }
                }
            }

            if (op["layer_edits"] != null)
            {
                if (!(op["layer_edits"] is JArray edits)) Fail("layer_edits", CodeBadValue, "layer_edits is a list of {index, width_mm?, function?, material?, wraps?} or {insert_at, ...} or {index, remove: true}");
                else
                {
                    // Removals go last, highest index first, so the indexes a person wrote stay the layers they meant
                    var removals = new List<int>();
                    for (int i = 0; i < edits.Count; i++)
                    {
                        string label = $"layer_edits[{i}]";
                        if (!(edits[i] is JObject e)) { Fail(label, CodeBadValue, "each edit is an object"); continue; }
                        if (e["insert_at"] != null)
                        {
                            int at = e.Value<int>("insert_at");
                            string fn = NormaliseFunction(e.Value<string>("function") ?? "Structure");
                            double? w = Num(e["width_mm"]);
                            if (at < 0 || at > plan.Layers.Count) { Fail(label, CodeBadValue, $"insert_at {at} is outside 0..{plan.Layers.Count}"); continue; }
                            if (fn == null || w == null) { Fail(label, CodeBadValue, "an inserted layer needs function and width_mm"); continue; }
                            plan.Layers.Insert(at, new LayerRow { Function = fn, WidthMm = w.Value, Material = e.Value<string>("material"), Wraps = e.Value<bool?>("wraps") });
                            if (plan.StructuralIndex >= at) plan.StructuralIndex++;
                            plan.Changed = true; items.Add(Item(label, true, null, $"layer inserted at {at}"));
                            continue;
                        }
                        int? idx = e.Value<int?>("index");
                        if (idx == null || idx < 0 || idx >= plan.Layers.Count) { Fail(label, CodeBadValue, $"index {idx?.ToString() ?? "(missing)"} is outside 0..{plan.Layers.Count - 1} (0 is the exterior or top layer)"); continue; }
                        if (e.Value<bool?>("remove") == true) { removals.Add(idx.Value); items.Add(Item(label, true, null, $"layer {idx} removed")); continue; }
                        LayerRow row = plan.Layers[idx.Value];
                        var before = row.ToJson();
                        bool any = false;
                        if (e["width_mm"] != null) { double? w = Num(e["width_mm"]); if (w == null) { Fail(label, CodeBadValue, "width_mm is a number"); continue; } row.WidthMm = w.Value; any = true; }
                        if (e["function"] != null) { string fn = NormaliseFunction(e.Value<string>("function")); if (fn == null) { Fail(label, CodeBadValue, $"function {e.Value<string>("function")} isn't one of {string.Join(", ", LayerFunctions)}"); continue; } row.Function = fn; any = true; }
                        if (e["material"] != null) { row.Material = e.Value<string>("material"); row.MaterialId = -1; any = true; }
                        if (e["wraps"] != null) { row.Wraps = e.Value<bool>("wraps"); any = true; }
                        if (!any) { Fail(label, CodeBadValue, "the edit changes nothing: give width_mm, function, material, wraps or remove"); continue; }
                        plan.Changed = true;
                        var ok = Item(label, true); ok["before"] = before; ok["after"] = row.ToJson(); items.Add(ok);
                    }
                    foreach (int r in removals.Distinct().OrderByDescending(x => x))
                    {
                        plan.Layers.RemoveAt(r);
                        if (plan.StructuralIndex == r) plan.StructuralIndex = -1;
                        else if (plan.StructuralIndex > r) plan.StructuralIndex--;
                        plan.Changed = true;
                    }
                }
            }

            if (op["core"] is JToken core)
            {
                int? ext = core.Value<int?>("exterior_shell_layers") ?? core.Value<int?>("exterior");
                int? inn = core.Value<int?>("interior_shell_layers") ?? core.Value<int?>("interior");
                if (ext == null && inn == null) Fail("core", CodeBadValue, "core needs exterior_shell_layers and/or interior_shell_layers");
                else
                {
                    int e2 = ext ?? plan.ExteriorShell, i2 = inn ?? plan.InteriorShell;
                    if (e2 < 0 || i2 < 0 || e2 + i2 >= plan.Layers.Count) Fail("core", CodeBadValue, $"shell layers {e2} + {i2} must leave at least one core layer of {plan.Layers.Count}");
                    else
                    {
                        var r = Item("core", true); r["before"] = $"{plan.ExteriorShell}/{plan.InteriorShell}"; r["after"] = $"{e2}/{i2}"; items.Add(r);
                        plan.ExteriorShell = e2; plan.InteriorShell = i2; plan.Changed = true;
                    }
                }
            }

            if (op["structural_layer"] != null)
            {
                int? s = op.Value<int?>("structural_layer");
                if (s == null || s < 0 || s >= plan.Layers.Count) Fail("structural_layer", CodeBadValue, $"structural_layer {s?.ToString() ?? "(missing)"} is outside 0..{plan.Layers.Count - 1}");
                else { plan.StructuralIndex = s.Value; plan.Changed = true; items.Add(Item("structural_layer", true)); }
            }

            // Layer rules on the final list (Revit checks the rest)
            if (plan.Layers.Count == 0) Fail("layers", CodeBadValue, "a type needs at least one layer");
            for (int i = 0; i < plan.Layers.Count; i++)
            {
                LayerRow l = plan.Layers[i];
                if (l.Function == "Membrane" && Math.Abs(l.WidthMm) > 1e-6) Fail($"layer {i}", CodeBadValue, "a membrane layer is 0 mm thick");
                else if (l.Function != "Membrane" && l.WidthMm <= 0) Fail($"layer {i}", CodeBadValue, $"a {l.Function} layer needs width_mm over 0");
            }
            if (plan.ExteriorShell + plan.InteriorShell >= Math.Max(1, plan.Layers.Count) && plan.Layers.Count > 0)
            {
                items.Add(Item("core", true, null, $"core boundaries reset to 0/0: {plan.ExteriorShell}/{plan.InteriorShell} shell layers don't fit {plan.Layers.Count} layers"));
                plan.ExteriorShell = 0; plan.InteriorShell = 0;
            }
            return plan;
        }

        // ---------------- stairs ----------------

        public static readonly Dictionary<string, string> StairLengths = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["max_riser_mm"] = "MaxRiserHeight", ["min_tread_mm"] = "MinTreadDepth", ["min_run_width_mm"] = "MinRunWidth",
            ["left_lateral_offset_mm"] = "LeftLateralOffset", ["right_lateral_offset_mm"] = "RightLateralOffset",
        };
        public static readonly Dictionary<string, string> StairRefs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["run_type"] = "RunType", ["landing_type"] = "LandingType",
            ["left_support"] = "LeftSideSupportType", ["right_support"] = "RightSideSupportType", ["middle_support"] = "MiddleSupportType",
        };
        public static readonly Dictionary<string, string> RunLengths = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["riser_thickness_mm"] = "RiserThickness", ["tread_thickness_mm"] = "TreadThickness",
            ["nosing_length_mm"] = "NosingLength", ["structural_depth_mm"] = "StructuralDepth",
        };
        public static readonly Dictionary<string, string> LandingLengths = new Dictionary<string, string>(StringComparer.Ordinal)
        { ["thickness_mm"] = "Thickness" };

        /// <summary>Read-only in the Revit 2025 API (no setter): refused by name, never silently dropped.</summary>
        public static readonly Dictionary<string, string> StairReadOnly = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["construction_method"] = "StairsType.ConstructionMethod has no setter (assembled, cast-in-place or precast is the family's)",
            ["has_middle_supports"] = "StairsType.HasMiddleSupports has no setter: set middle_support and middle_supports_number",
            ["has_risers"] = "StairsRunType.HasRisers has no setter in the API",
            ["has_treads"] = "StairsRunType.HasTreads has no setter in the API",
            ["is_monolithic"] = "IsMonolithic comes from the stair family (monolithic or not), it has no setter",
            ["total_depth_mm"] = "StairsRunType.TotalDepth has no setter; structural_depth_mm sets the monolithic depth",
            ["is_slanted"] = "StairsRunType.IsSlanted has no setter",
        };

        /// <summary>One row per key of a stair, stair_run or stair_landing block: lengths checked against Revit's limits.</summary>
        public static Dictionary<string, double> PlanStairLengths(string group, JObject block, Dictionary<string, string> lengths, IEnumerable<string> otherKeys, JArray items, ref bool ok)
        {
            var outv = new Dictionary<string, double>(StringComparer.Ordinal);
            var other = new HashSet<string>(otherKeys ?? Enumerable.Empty<string>(), StringComparer.Ordinal);
            foreach (var kv in block)
            {
                string label = $"{group}.{kv.Key}";
                if (lengths.ContainsKey(kv.Key))
                {
                    double? v = Num(kv.Value);
                    if (v == null || v <= 0 || v > MaxStairMm) { ok = false; items.Add(Item(label, false, CodeBadValue, $"{kv.Key} is a length over 0 and up to 30000 ft (Revit's limit)")); continue; }
                    if (group == "stair_run" && kv.Key == "structural_depth_mm") { /* zero is not allowed; monolithic only, checked on the Revit side */ }
                    outv[kv.Key] = v.Value;
                }
                else if (StairReadOnly.TryGetValue(kv.Key, out string why)) { ok = false; items.Add(Item(label, false, CodeReadOnly, why)); }
                else if (!other.Contains(kv.Key)) { ok = false; items.Add(Item(label, false, CodeUnknownKey, $"{kv.Key} isn't a {group} setting (lengths: {string.Join(", ", lengths.Keys)}{(other.Count > 0 ? "; also " + string.Join(", ", other) : "")})")); }
            }
            return outv;
        }

        // ---------------- routing preferences (type definition only) ----------------

        public static readonly Dictionary<string, string> RoutingGroups = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["segments"] = "Segments", ["elbows"] = "Elbows", ["junctions"] = "Junctions", ["crosses"] = "Crosses",
            ["transitions"] = "Transitions", ["unions"] = "Unions", ["mechanical_joints"] = "MechanicalJoints", ["caps"] = "Caps",
            ["transitions_rect_round"] = "TransitionsRectangularToRound", ["transitions_rect_oval"] = "TransitionsRectangularToOval",
            ["transitions_oval_round"] = "TransitionsOvalToRound",
        };

        public sealed class RuleRow
        {
            public string Group;    // RoutingPreferenceRuleGroupType name
            public string Part;     // id or name, resolved on the Revit side
            public double? MinMm;
            public double? MaxMm;
            public int? Index;
            public string Description = "";
            public string Label;
        }

        public sealed class RuleRemoval { public string Group; public int Index; public string Label; }

        /// <summary>Why a group is not on this MEP type, or null.</summary>
        public static string GroupNotForType(string group, string typeClass)
        {
            if (typeClass == "DuctType" && group == "Segments") return "duct types have no segment rows in their routing preferences (segments are for pipes)";
            if (typeClass == "DuctType" && (group == "MechanicalJoints" || group == "Caps")) return $"{group} is a pipe routing group";
            if (typeClass == "PipeType" && group.StartsWith("TransitionsRectangular", StringComparison.Ordinal)) return "pipes are round: rectangular transitions are duct groups";
            if (typeClass == "PipeType" && group == "TransitionsOvalToRound") return "pipes are round: oval transitions are duct groups";
            return null;
        }

        /// <summary>routing {add: [{group, part, min_mm?, max_mm?, index?, description?}], remove: [{group, index}], preferred_junction?: tee|tap}.</summary>
        public static void ParseRouting(JToken routing, string typeClass, List<RuleRow> adds, List<RuleRemoval> removes, out string junction, JArray items, ref bool ok)
        {
            junction = null;
            if (!(routing is JObject r)) { ok = false; items.Add(Item("routing", false, CodeBadValue, "routing is {add?, remove?, preferred_junction?}")); return; }
            foreach (var kv in r)
            {
                if (kv.Key != "add" && kv.Key != "remove" && kv.Key != "preferred_junction")
                { ok = false; items.Add(Item($"routing.{kv.Key}", false, CodeUnknownKey, "routing takes add, remove and preferred_junction")); }
            }
            if (r["preferred_junction"] != null)
            {
                string j = r.Value<string>("preferred_junction") ?? "";
                if (string.Equals(j, "tee", StringComparison.OrdinalIgnoreCase)) junction = "Tee";
                else if (string.Equals(j, "tap", StringComparison.OrdinalIgnoreCase)) junction = "Tap";
                else { ok = false; items.Add(Item("routing.preferred_junction", false, CodeBadValue, "preferred_junction is tee or tap")); }
            }
            int n = 0;
            foreach (JToken t in r["remove"] as JArray ?? new JArray())
            {
                string label = $"routing.remove[{n++}]";
                string g = t.Value<string>("group"); int? idx = t.Value<int?>("index");
                if (g == null || !RoutingGroups.TryGetValue(g, out string gname)) { ok = false; items.Add(Item(label, false, CodeBadValue, $"group {g} isn't one of {string.Join(", ", RoutingGroups.Keys)}")); continue; }
                if (idx == null || idx < 0) { ok = false; items.Add(Item(label, false, CodeBadValue, "remove needs index (0 is the first rule of the group)")); continue; }
                removes.Add(new RuleRemoval { Group = gname, Index = idx.Value, Label = label });
            }
            n = 0;
            foreach (JToken t in r["add"] as JArray ?? new JArray())
            {
                string label = $"routing.add[{n++}]";
                if (!(t is JObject a)) { ok = false; items.Add(Item(label, false, CodeBadValue, "each rule is {group, part, min_mm?, max_mm?}")); continue; }
                string g = a.Value<string>("group");
                if (g == null || !RoutingGroups.TryGetValue(g, out string gname)) { ok = false; items.Add(Item(label, false, CodeBadValue, $"group {g} isn't one of {string.Join(", ", RoutingGroups.Keys)}")); continue; }
                string not = GroupNotForType(gname, typeClass);
                if (not != null) { ok = false; items.Add(Item(label, false, CodeWrongKind, not)); continue; }
                string part = a["part"]?.ToString();
                if (string.IsNullOrWhiteSpace(part)) { ok = false; items.Add(Item(label, false, CodeBadValue, "part is the segment or fitting type (id, or \"Family : Type\", or the segment's name)")); continue; }
                double? min = Num(a["min_mm"]), max = Num(a["max_mm"]);
                if (min != null && min < 0 || max != null && max < 0 || min != null && max != null && min > max)
                { ok = false; items.Add(Item(label, false, CodeBadValue, "min_mm and max_mm are sizes from 0, min up to max")); continue; }
                adds.Add(new RuleRow { Group = gname, Part = part, MinMm = min, MaxMm = max, Index = a.Value<int?>("index"), Description = a.Value<string>("description") ?? "", Label = label });
            }
            if (adds.Count == 0 && removes.Count == 0 && junction == null && ok) { ok = false; items.Add(Item("routing", false, CodeBadValue, "routing changes nothing")); }
        }

        /// <summary>The same rule twice in a group (same part, same size range) is refused, never silently added.</summary>
        public static bool SameRule(string groupA, long partA, double? minA, double? maxA, string groupB, long partB, double? minB, double? maxB)
        {
            bool Eq(double? x, double? y) => x == null && y == null || x != null && y != null && Math.Abs(x.Value - y.Value) < 0.05;
            return groupA == groupB && partA == partB && Eq(minA, minB) && Eq(maxA, maxB);
        }

        // ---------------- pipe segment sizes (part of the segment definition) ----------------

        public sealed class SizeRow { public double NominalMm, InnerMm, OuterMm; public bool Lists = true, Sizing = true; public string Label; }

        /// <summary>segment_sizes {segment?, add: [{nominal_mm, id_mm, od_mm, lists?, sizing?}], remove: [nominal_mm]}.</summary>
        public static void ParseSegmentSizes(JToken spec, ICollection<double> existingNominalMm, List<SizeRow> adds, List<double> removes, JArray items, ref bool ok)
        {
            if (!(spec is JObject s)) { ok = false; items.Add(Item("segment_sizes", false, CodeBadValue, "segment_sizes is {segment?, add?, remove?}")); return; }
            foreach (var kv in s)
                if (kv.Key != "segment" && kv.Key != "add" && kv.Key != "remove") { ok = false; items.Add(Item($"segment_sizes.{kv.Key}", false, CodeUnknownKey, "segment_sizes takes segment, add and remove")); }
            bool Has(double mm) => existingNominalMm.Any(x => Math.Abs(x - mm) < 0.05);
            int n = 0;
            foreach (JToken t in s["add"] as JArray ?? new JArray())
            {
                string label = $"segment_sizes.add[{n++}]";
                double? nom = Num(t["nominal_mm"]), id = Num(t["id_mm"]), od = Num(t["od_mm"]);
                if (nom == null || id == null || od == null || nom <= 0 || id <= 0 || od <= id) { ok = false; items.Add(Item(label, false, CodeBadValue, "a size needs nominal_mm, id_mm and od_mm, with od over id")); continue; }
                if (Has(nom.Value) || adds.Any(a => Math.Abs(a.NominalMm - nom.Value) < 0.05)) { ok = false; items.Add(Item(label, false, CodeSizeExists, $"nominal {nom} mm is already in the segment: remove it first to change it")); continue; }
                adds.Add(new SizeRow { NominalMm = nom.Value, InnerMm = id.Value, OuterMm = od.Value, Lists = t.Value<bool?>("lists") ?? true, Sizing = t.Value<bool?>("sizing") ?? true, Label = label });
            }
            n = 0;
            foreach (JToken t in s["remove"] as JArray ?? new JArray())
            {
                string label = $"segment_sizes.remove[{n++}]";
                double? nom = Num(t);
                if (nom == null || !Has(nom.Value)) { ok = false; items.Add(Item(label, false, CodeBadValue, $"nominal {t} mm isn't in the segment")); continue; }
                removes.Add(nom.Value);
            }
            if (adds.Count == 0 && removes.Count == 0 && ok) { ok = false; items.Add(Item("segment_sizes", false, CodeBadValue, "segment_sizes changes nothing")); }
        }

        // ---------------- create_line_based_element / create_surface_based_element type pick ----------------

        public sealed class TypeCandidate { public long Id; public string Name; public double? WidthMm; }
        public sealed class Pick { public long? Id; public string Code; public string Reason; public string Note; public bool Ok => Id != null; }

        /// <summary>
        /// The type an element is made with. No silent first type (review gap 11): a typeId that is missing or doesn't fit
        /// is refused; with no typeId a layered type (wall, floor, roof, ceiling) is the one existing type whose total
        /// thickness is the asked thickness; a type of another category needs its typeId. A thickness that doesn't match the
        /// given type is refused too. Nothing is created here: modify_model duplicate_type makes a new thickness.
        /// </summary>
        public static Pick PickType(string category, long requestedId, bool requestedExists, bool requestedFits, double thicknessMm, bool layered, IList<TypeCandidate> candidates)
        {
            const double tol = 0.5;
            string list = string.Join(", ", candidates.Take(12).Select(c => c.WidthMm != null ? $"{c.Name} ({Math.Round(c.WidthMm.Value, 1)} mm, id {c.Id})" : $"{c.Name} (id {c.Id})"));
            bool asked = requestedId != -1 && requestedId != 0;
            if (asked)
            {
                if (!requestedExists) return new Pick { Code = CodeTypeNotFound, Reason = $"typeId {requestedId} isn't in this model; no other type is used in its place. Types: {list}" };
                if (!requestedFits) return new Pick { Code = CodeTypeNotFound, Reason = $"typeId {requestedId} isn't a {category} type; no other type is used in its place. Types: {list}" };
                var c = candidates.FirstOrDefault(x => x.Id == requestedId);
                if (layered && thicknessMm > 0 && c?.WidthMm != null && Math.Abs(c.WidthMm.Value - thicknessMm) > tol)
                    return new Pick { Code = CodeThicknessMismatch, Reason = $"{c.Name} is {Math.Round(c.WidthMm.Value, 1)} mm, not the {thicknessMm} mm asked: pick the type with that thickness, leave thickness at the type's, or make one with modify_model duplicate_type" };
                return new Pick { Id = requestedId, Note = !layered && thicknessMm > 0 ? $"thickness {thicknessMm} mm doesn't apply to {category}: its type sets the size" : null };
            }
            if (!layered)
                return new Pick { Code = CodeTypeRequired, Reason = $"{category} needs typeId (the first type is no longer used in its place). Types: {list}" };
            if (thicknessMm <= 0)
                return new Pick { Code = CodeTypeRequired, Reason = $"{category} needs typeId or thickness over 0. Types: {list}" };
            var hits = candidates.Where(x => x.WidthMm != null && Math.Abs(x.WidthMm.Value - thicknessMm) <= tol).ToList();
            if (hits.Count == 1) return new Pick { Id = hits[0].Id, Note = $"thickness {thicknessMm} mm: {hits[0].Name}" };
            if (hits.Count > 1) return new Pick { Code = CodeAmbiguous, Reason = $"{hits.Count} {category} types are {thicknessMm} mm ({string.Join(", ", hits.Take(8).Select(h => $"{h.Name} id {h.Id}"))}): give typeId" };
            return new Pick { Code = CodeNoThicknessMatch, Reason = $"no {category} type is {thicknessMm} mm thick; nothing was made. Make one with modify_model duplicate_type (layers) or give typeId. Types: {list}" };
        }

        public static double? Num(JToken t)
        {
            if (t == null || t.Type == JTokenType.Null) return null;
            if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) return t.Value<double>();
            return double.TryParse(t.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double v) ? v : (double?)null;
        }
    }
}
