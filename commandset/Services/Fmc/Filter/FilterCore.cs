using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.Filter
{
    // Build plan item 32 (FILTER_TOOL_SPEC.md): the parts of the select_by filter engine that need no Revit, so they are
    // unit tested offline (tests/filter). The Revit side is FilterEngine.cs.

    /// <summary>An [FMC-FILTER-…] refusal with a code, a hint and, where useful, candidates (spec 10).</summary>
    public sealed class FilterException : Exception
    {
        public string Code { get; }
        public string Hint { get; }
        public JToken Extra { get; }
        public FilterException(string code, string message, string hint = null, JToken extra = null)
            : base($"[{code}] {message}") { Code = code; Hint = hint ?? ""; Extra = extra; }

        public JObject ToJson()
        {
            var o = new JObject { ["ok"] = false, ["code"] = Code, ["message"] = Message, ["hint"] = Hint };
            if (Extra is JObject x)
                foreach (var p in x.Properties())
                    if (p.Name != "ok" && p.Name != "code" && p.Name != "message" && p.Name != "hint") o[p.Name] = p.Value;
            else if (Extra != null) o["candidates"] = Extra;
            return o;
        }
    }

    /// <summary>Caps and limits (spec 9; Emlyn 28 Nov decision 6: as specified, tuned later on HEBERT-sized models).</summary>
    public static class FilterLimits
    {
        public const int MaxDepth = 6;
        public const int MaxLeaves = 64;
        public const int MaxAnyChildren = 16;
        public const int MaxListValues = 200;
        public const int MaxPolygonVertices = 500;
        public const int PageDefault = 100;
        public const int PageMax = 500;
        public const int PageBytes = 256 * 1024;
        public const int SnapshotMax = 50000;
        public const int SnapshotsPerRevit = 8;
        public static readonly TimeSpan SnapshotIdle = TimeSpan.FromMinutes(15);
        public const int ShowDefault = 2000;
        public const int ShowMax = 5000;
        public const int WriteMax = 5000;
        public const int ExportRows = 100000;
        public const int ScanCapDefault = 20000;
        public const int ScanCapMin = 1000;
        public const int ScanCapMax = 200000;
        public const int DocsMax = 8;
        public const int LinksPerDoc = 50;
        public const int ReasonRowsPerPage = 50;
        public const int WorkMs = 90000;
        public const int BatchIds = 1000;

        public static int Clamp(int v, int lo, int hi) => v < lo ? lo : v > hi ? hi : v;
        public static int PageSize(int? asked)
        {
            int n = asked ?? PageDefault;
            if (n < 1 || n > PageMax) throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"page_size {n} is outside 1..{PageMax}", "use 1 to 500 (default 100)");
            return n;
        }
        public static int ScanCap(int? asked) => Clamp(asked ?? ScanCapDefault, ScanCapMin, ScanCapMax);
    }

    /// <summary>Three-valued result of a criterion (spec 4.4): unknown is never a silent no-match.</summary>
    public enum TriState { False = 0, True = 1, Unknown = 2 }

    public struct Tri
    {
        public TriState State;
        public string Reason;   // PARAM_MISSING, PARAM_UNREADABLE, NO_LOCATION, ROOM_TEST_FAILED, INFO_FAILED
        public string Detail;   // the parameter, or what threw

        public static readonly Tri T = new Tri { State = TriState.True };
        public static readonly Tri F = new Tri { State = TriState.False };
        public static Tri Of(bool b) => b ? T : F;
        public static Tri Unknown(string reason, string detail = null) => new Tri { State = TriState.Unknown, Reason = reason, Detail = detail };
        public bool IsTrue => State == TriState.True;
        public bool IsFalse => State == TriState.False;
        public bool IsUnknown => State == TriState.Unknown;

        public Tri Not() => State == TriState.Unknown ? this : Of(State == TriState.False);

        /// <summary>missing: "report" keeps unknown; "no_match" makes it false; "match" makes it true (spec 4.4).</summary>
        public Tri Resolve(string missing)
        {
            if (State != TriState.Unknown) return this;
            if (Reason != "PARAM_MISSING" && Reason != "PARAM_UNREADABLE") return this;   // a failed test is never guessed
            if (missing == "no_match") return F;
            if (missing == "match") return T;
            return this;
        }

        public static Tri And(IEnumerable<Func<Tri>> parts)
        {
            Tri unknown = default; bool any = false;
            foreach (var f in parts)
            {
                Tri t = f();
                if (t.IsFalse) return F;
                if (t.IsUnknown && !any) { unknown = t; any = true; }
            }
            return any ? unknown : T;
        }

        public static Tri Or(IEnumerable<Func<Tri>> parts)
        {
            Tri unknown = default; bool any = false;
            foreach (var f in parts)
            {
                Tri t = f();
                if (t.IsTrue) return T;
                if (t.IsUnknown && !any) { unknown = t; any = true; }
            }
            return any ? unknown : F;
        }

        /// <summary>Undetermined (a criterion parameter absent or unreadable) vs skipped (the test itself could not run).</summary>
        public static bool IsUndeterminedReason(string reason) => reason == "PARAM_MISSING" || reason == "PARAM_UNREADABLE";
    }

    /// <summary>A normalised criteria node: NOT pushed to the leaves (De Morgan), nested all/any flattened.</summary>
    public sealed class Node
    {
        public enum NodeKind { All, Any, Leaf }
        public NodeKind Kind;
        public List<Node> Children = new List<Node>();
        public JObject Leaf;
        public string LeafKind;
        public bool Negate;

        public override string ToString()
        {
            if (Kind == NodeKind.Leaf) return (Negate ? "not " : "") + Criteria.Describe(Leaf, LeafKind);
            return (Kind == NodeKind.All ? "all(" : "any(") + string.Join(", ", Children.Select(c => c.ToString())) + ")";
        }

        public IEnumerable<Node> Leaves()
        {
            if (Kind == NodeKind.Leaf) { yield return this; yield break; }
            foreach (var c in Children) foreach (var l in c.Leaves()) yield return l;
        }
    }

    /// <summary>The criteria tree (spec 3.2): validation, limits, NOT push-down, and the flat select_by shorthand.</summary>
    public static class Criteria
    {
        /// <summary>Leaf keys, in the order a leaf is recognised.</summary>
        public static readonly string[] LeafKinds =
        {
            "category", "class", "family", "type", "type_id", "ids", "level", "workset", "phase_created", "design_option",
            "view", "param", "bip", "in_room", "in_boundary", "in_box", "box", "near", "hosted_by", "host_of", "tagged_in_view",
        };

        public static readonly string[] ParamOps = { "=", "!=", ">", ">=", "<", "<=", "contains", "starts", "ends", "empty", "not_empty", "in", "between" };

        /// <summary>Leaves that narrow a scan (an unscoped scan over scan_cap is refused, spec 9).</summary>
        public static readonly HashSet<string> Narrowing = new HashSet<string> { "category", "class", "ids", "view", "in_room", "in_boundary", "in_box", "box", "near", "type_id", "hosted_by", "host_of", "family", "type" };

        public static string KindOf(JObject leaf)
        {
            if (leaf["param"] != null || leaf["bip"] != null || leaf["guid"] != null) return "param";
            foreach (string k in LeafKinds) if (leaf[k] != null) return k;
            return null;
        }

        public static string Describe(JObject leaf, string kind)
        {
            if (kind == "param")
            {
                string name = leaf.Value<string>("bip") ?? leaf.Value<string>("param") ?? leaf.Value<string>("guid");
                string op = leaf.Value<string>("op") ?? "=";
                string v = leaf["value"] == null ? "" : " " + leaf["value"].ToString(Formatting.None);
                return $"param:{name} {op}{v}";
            }
            JToken t = leaf[kind];
            return t == null ? kind : $"{kind}:{(t.Type == JTokenType.String ? t.ToString() : t.ToString(Formatting.None))}";
        }

        /// <summary>Checks the tree against spec 3.2 limits; throws FMC-FILTER-BAD-CRITERIA with the path that failed.</summary>
        public static void Validate(JToken node)
        {
            int leaves = 0;
            Walk(node, 1, "criteria", ref leaves);
            if (leaves > FilterLimits.MaxLeaves) Bad($"{leaves} leaves, over the limit {FilterLimits.MaxLeaves}", "criteria");
        }

        private static void Bad(string what, string path) =>
            throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"{what} (at {path})", "fix the tree; explain shows how it compiles");

        private static void Walk(JToken node, int depth, string path, ref int leaves)
        {
            if (depth > FilterLimits.MaxDepth) Bad($"the tree is deeper than {FilterLimits.MaxDepth}", path);
            if (!(node is JObject o) || o.Count == 0) { Bad("a node must be a non-empty object", path); return; }
            if (o["all"] != null || o["any"] != null)
            {
                string k = o["all"] != null ? "all" : "any";
                if (o.Count != 1) Bad($"\"{k}\" must be alone in its node", path);
                if (!(o[k] is JArray kids) || kids.Count == 0) { Bad($"empty \"{k}\"", path); return; }
                if (k == "any" && kids.Count > FilterLimits.MaxAnyChildren) Bad($"\"any\" has {kids.Count} children, over {FilterLimits.MaxAnyChildren}", path);
                for (int i = 0; i < kids.Count; i++) Walk(kids[i], depth + 1, $"{path}.{k}[{i}]", ref leaves);
                return;
            }
            if (o["not"] != null)
            {
                if (o.Count != 1) Bad("\"not\" must be alone in its node", path);
                Walk(o["not"], depth + 1, path + ".not", ref leaves);
                return;
            }
            string kind = KindOf(o);
            if (kind == null) Bad($"unknown leaf {{{string.Join(", ", o.Properties().Select(p => p.Name))}}}", path);
            leaves++;
            ValidateLeaf(o, kind, path);
        }

        private static void ValidateLeaf(JObject o, string kind, string path)
        {
            foreach (var p in o.Properties())
                if (p.Value is JArray a && a.Count > FilterLimits.MaxListValues && p.Name != "polygon_mm")
                    Bad($"\"{p.Name}\" has {a.Count} values, over {FilterLimits.MaxListValues}", path);
            switch (kind)
            {
                case "param":
                {
                    string op = o.Value<string>("op") ?? "=";
                    if (!ParamOps.Contains(op)) Bad($"unknown op \"{op}\" (use {string.Join(" ", ParamOps)})", path);
                    string of = o.Value<string>("of") ?? "either";
                    if (of != "instance" && of != "type" && of != "either") Bad($"of must be instance, type or either, not \"{of}\"", path);
                    if (op != "empty" && op != "not_empty" && o["value"] == null) Bad($"op \"{op}\" needs a value", path);
                    if (op == "between" && !(o["value"] is JArray b && b.Count == 2)) Bad("between needs [low, high]", path);
                    if (op == "in" && !(o["value"] is JArray ia && ia.Count > 0)) Bad("in needs a non-empty list", path);
                    if (o["unit"] != null && Units.Parse(o.Value<string>("unit")) == null)
                        throw new FilterException("FMC-FILTER-UNIT", $"unknown unit \"{o.Value<string>("unit")}\" (at {path})", "give mm, cm, m, ft, in, m2, mm2, ft2, m3, ft3, deg or rad");
                    break;
                }
                case "in_boundary":
                {
                    var spec = o["in_boundary"] as JObject;
                    if (spec == null) Bad("in_boundary must be an object", path);
                    var pts = Polygon.Read(spec?["polygon_mm"]);
                    string problem = Polygon.Problem(pts);
                    if (problem != null) throw new FilterException("FMC-FILTER-BOUNDARY-INVALID", $"{problem} (at {path})", "redraw the polygon: at least 3 points in mm, not crossing itself");
                    break;
                }
                case "in_room":
                    if (!(o["in_room"] is JObject r) || r["room"] == null) Bad("in_room needs {room: id, number, name or \"selected\"}", path);
                    break;
                case "in_box":
                    if (!(o["in_box"] is JObject bx) || !(bx["min_mm"] is JArray mn) || !(bx["max_mm"] is JArray mx) || mn.Count < 2 || mx.Count < 2) Bad("in_box needs min_mm and max_mm [x, y, z?]", path);
                    break;
                case "near":
                    if (!(o["near"] is JObject nr) || (nr["id"] == null && nr["point_mm"] == null)) Bad("near needs id or point_mm", path);
                    break;
                case "ids":
                    if (!(o["ids"] is JArray) && o.Value<string>("ids") != "selection") Bad("ids must be a list or \"selection\"", path);
                    break;
            }
        }

        /// <summary>Push NOT down to the leaves and flatten nested all/any.</summary>
        public static Node Normalize(JToken node, bool negate = false)
        {
            var o = (JObject)node;
            if (o["not"] != null) return Normalize(o["not"], !negate);
            if (o["all"] != null || o["any"] != null)
            {
                bool isAll = o["all"] != null;
                var kids = (JArray)(o["all"] ?? o["any"]);
                // De Morgan: not(all) = any(not), not(any) = all(not)
                var kind = isAll ^ negate ? Node.NodeKind.All : Node.NodeKind.Any;
                var n = new Node { Kind = kind };
                foreach (var k in kids)
                {
                    Node c = Normalize(k, negate);
                    if (c.Kind == kind) n.Children.AddRange(c.Children); else n.Children.Add(c);
                }
                return n.Children.Count == 1 ? n.Children[0] : n;
            }
            return new Node { Kind = Node.NodeKind.Leaf, Leaf = o, LeafKind = KindOf(o), Negate = negate };
        }

        /// <summary>True when the tree names something that narrows the scan.</summary>
        public static bool IsNarrowed(Node n)
        {
            if (n.Kind == Node.NodeKind.All) return n.Children.Any(IsNarrowed);
            if (n.Kind == Node.NodeKind.Any) return n.Children.All(IsNarrowed);
            return !n.Negate && Narrowing.Contains(n.LeafKind);
        }

        /// <summary>Categories named by positive category leaves at the top of the tree (the default invert universe).</summary>
        public static List<JToken> TopCategories(Node n)
        {
            var list = new List<JToken>();
            if (n.Kind == Node.NodeKind.Leaf && !n.Negate && n.LeafKind == "category") list.Add(n.Leaf["category"]);
            if (n.Kind == Node.NodeKind.All) foreach (var c in n.Children) list.AddRange(TopCategories(c));
            return list;
        }

        /// <summary>The flat select_by keys (the hub's revit_select_by shape) as leaves of one all node (spec 12).</summary>
        public static JObject FromFlat(JObject p)
        {
            var leaves = new JArray();
            void Add(JObject leaf) => leaves.Add(leaf);
            if (p["ids"] is JArray ids && ids.Count > 0) Add(new JObject { ["ids"] = ids });
            if (p["category"] != null) Add(new JObject { ["category"] = p["category"] });
            if (p["level"] != null) Add(new JObject { ["level"] = p["level"] });
            if (p["type_name"] != null) Add(new JObject { ["type"] = p["type_name"], ["match"] = "contains" });
            if (p["family"] != null) Add(new JObject { ["family"] = p["family"], ["match"] = "contains" });
            if (p["comment"] != null) Add(new JObject { ["bip"] = "ALL_MODEL_INSTANCE_COMMENTS", ["of"] = "instance", ["op"] = "contains", ["value"] = p["comment"] });
            if (p["mark"] != null) Add(new JObject { ["bip"] = "ALL_MODEL_MARK", ["of"] = "instance", ["op"] = "=", ["value"] = p["mark"] });
            if (p["workset"] != null) Add(new JObject { ["workset"] = p["workset"] });
            if (p["phase"] != null) Add(new JObject { ["phase_created"] = p["phase"] });
            if (p["view"] != null) Add(new JObject { ["view"] = p["view"] });
            if (p["room"] != null) Add(new JObject { ["in_room"] = new JObject { ["room"] = p["room"], ["mode"] = "center" } });
            if (p["box"] is JObject box) Add(new JObject { ["box"] = box });
            if (p["box_mm"] is JArray bm && bm.Count == 2)
                Add(new JObject { ["in_box"] = new JObject { ["min_mm"] = bm[0], ["max_mm"] = bm[1] } });
            if (p["near"] is JObject near) Add(new JObject { ["near"] = near });
            if (p["hosted_by"] != null) Add(new JObject { ["hosted_by"] = p["hosted_by"] });
            if (p["host_of"] != null) Add(new JObject { ["host_of"] = p["host_of"] });
            foreach (JObject rule in p["param"] is JArray pa ? pa.OfType<JObject>() : p["param"] is JObject po ? new[] { po } : Enumerable.Empty<JObject>())
            {
                string how = rule.Value<string>("is") ?? "equals";
                string op = how == "equals" ? "=" : how == "gt" ? ">" : how == "lt" ? "<" : how;
                var leaf = new JObject { ["param"] = rule["name"], ["op"] = op };
                if (rule["value"] != null) leaf["value"] = rule["value"];
                Add(leaf);
            }
            if (p["exclude"] is JArray ex && ex.Count > 0) Add(new JObject { ["not"] = new JObject { ["ids"] = ex } });
            if (p["not"] is JObject not && not.Count > 0)
            {
                JObject inner = FromFlat(not);
                if (inner != null) Add(new JObject { ["not"] = inner });
            }
            if (leaves.Count == 0) return null;
            return leaves.Count == 1 ? (JObject)leaves[0] : new JObject { ["all"] = leaves };
        }

        /// <summary>The flat keys select_by takes (anything else at the top is a filter-engine argument).</summary>
        public static readonly string[] FlatKeys =
        {
            "ids", "category", "level", "type_name", "family", "comment", "mark", "workset", "phase", "view", "room", "box", "box_mm",
            "near", "hosted_by", "host_of", "param", "exclude", "not",
        };
    }

    /// <summary>Units in and out (spec 5.3, 4.3): lengths mm, areas m², volumes m³, angles degrees.</summary>
    public static class Units
    {
        public enum Spec { Length, Area, Volume, Angle, Other }

        private static readonly Dictionary<string, (Spec spec, double toInternal)> Known = new Dictionary<string, (Spec, double)>(StringComparer.OrdinalIgnoreCase)
        {
            ["mm"] = (Spec.Length, 1 / 304.8), ["cm"] = (Spec.Length, 10 / 304.8), ["m"] = (Spec.Length, 1000 / 304.8),
            ["ft"] = (Spec.Length, 1), ["in"] = (Spec.Length, 1 / 12.0),
            ["mm2"] = (Spec.Area, 1 / (304.8 * 304.8)), ["m2"] = (Spec.Area, 1e6 / (304.8 * 304.8)), ["m²"] = (Spec.Area, 1e6 / (304.8 * 304.8)), ["ft2"] = (Spec.Area, 1),
            ["m3"] = (Spec.Volume, 1e9 / (304.8 * 304.8 * 304.8)), ["m³"] = (Spec.Volume, 1e9 / (304.8 * 304.8 * 304.8)), ["ft3"] = (Spec.Volume, 1),
            ["deg"] = (Spec.Angle, Math.PI / 180), ["rad"] = (Spec.Angle, 1),
        };

        public static (Spec spec, double toInternal)? Parse(string unit)
        {
            if (string.IsNullOrWhiteSpace(unit)) return null;
            return Known.TryGetValue(unit.Trim(), out var u) ? u : ((Spec, double)?)null;
        }

        public static string DefaultUnit(Spec s) => s == Spec.Length ? "mm" : s == Spec.Area ? "m2" : s == Spec.Volume ? "m3" : s == Spec.Angle ? "deg" : null;
        public static string Label(Spec s) => s == Spec.Length ? "mm" : s == Spec.Area ? "m²" : s == Spec.Volume ? "m³" : s == Spec.Angle ? "deg" : null;

        /// <summary>A value given by the agent in the parameter's units (or <paramref name="unit"/>) to Revit's internal units.</summary>
        public static double ToInternal(double v, Spec spec, string unit)
        {
            if (spec == Spec.Other) return v;
            var u = Parse(unit ?? DefaultUnit(spec));
            if (u == null) throw new FilterException("FMC-FILTER-UNIT", $"unknown unit \"{unit}\"", "give mm, m², m³ or degrees, or set unit");
            if (u.Value.spec != spec) throw new FilterException("FMC-FILTER-UNIT", $"unit {unit} is a {u.Value.spec} unit but the parameter is a {spec}", "give mm, m², m³ or degrees, or set unit");
            return v * u.Value.toInternal;
        }

        /// <summary>An internal value out in mm / m² / m³ / degrees (rounded as the replies show it).</summary>
        public static double FromInternal(double v, Spec spec)
        {
            switch (spec)
            {
                case Spec.Length: return Math.Round(v * 304.8, 1);
                case Spec.Area: return Math.Round(v * 304.8 * 304.8 / 1e6, 3);
                case Spec.Volume: return Math.Round(v * 304.8 * 304.8 * 304.8 / 1e9, 3);
                case Spec.Angle: return Math.Round(v * 180 / Math.PI, 3);
                default: return Math.Round(v, 6);
            }
        }

        /// <summary>Tolerance in internal units: 0.5 mm for a length, 1e-6 relative otherwise.</summary>
        public static double Tolerance(Spec spec, double want) => spec == Spec.Length ? 0.5 / 304.8 : Math.Max(1e-9, Math.Abs(want) * 1e-6);
    }

    /// <summary>Comparisons for param leaves (spec 3.2 ops). Numbers already in internal units.</summary>
    public static class Compare
    {
        public static bool Number(string op, double v, JToken want, Func<double, double> toInternal, double tol)
        {
            double W(JToken t) => toInternal(Num(t));
            switch (op)
            {
                case "=": return Math.Abs(v - W(want)) <= Tol(W(want));
                case "!=": return Math.Abs(v - W(want)) > Tol(W(want));
                case ">": return v > W(want) + Tol(W(want));
                case ">=": return v >= W(want) - Tol(W(want));
                case "<": return v < W(want) - Tol(W(want));
                case "<=": return v <= W(want) + Tol(W(want));
                case "between": { double a = W(want[0]), b = W(want[1]); double lo = Math.Min(a, b), hi = Math.Max(a, b); return v >= lo - Tol(lo) && v <= hi + Tol(hi); }
                case "in": return ((JArray)want).Any(t => Math.Abs(v - W(t)) <= Tol(W(t)));
                case "contains": case "starts": case "ends":
                    return Text(op, v.ToString(CultureInfo.InvariantCulture), want);
            }
            return false;
            double Tol(double w) => tol >= 0 ? tol : Math.Max(1e-9, Math.Abs(w) * 1e-6);
        }

        public static bool IsNumber(JToken t)
        {
            if (t == null) return false;
            if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) return true;
            if (t is JArray a) return a.Count > 0 && a.All(IsNumber);
            return t.Type == JTokenType.String && double.TryParse(t.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out _);
        }

        public static double Num(JToken t)
        {
            if (t == null) throw new FilterException("FMC-FILTER-BAD-CRITERIA", "a number is needed");
            if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) return t.Value<double>();
            if (double.TryParse(t.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double d)) return d;
            throw new FilterException("FMC-FILTER-UNIT", $"\"{t}\" is not a number", "give a number in mm, m², m³ or degrees");
        }

        /// <summary>Text ops, case-insensitive (Revit 2023+ string rules are case-insensitive too).</summary>
        public static bool Text(string op, string s, JToken want)
        {
            s = s ?? "";
            string w = want?.Type == JTokenType.Array ? null : want?.ToString() ?? "";
            switch (op)
            {
                case "=": return string.Equals(s, w, StringComparison.OrdinalIgnoreCase);
                case "!=": return !string.Equals(s, w, StringComparison.OrdinalIgnoreCase);
                case "contains": return s.IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0;
                case "starts": return s.StartsWith(w, StringComparison.OrdinalIgnoreCase);
                case "ends": return s.EndsWith(w, StringComparison.OrdinalIgnoreCase);
                case "in": return ((JArray)want).Any(t => string.Equals(s, t.ToString(), StringComparison.OrdinalIgnoreCase));
                case ">": case ">=": case "<": case "<=":
                {
                    int c = string.Compare(s, w, StringComparison.OrdinalIgnoreCase);
                    return op == ">" ? c > 0 : op == ">=" ? c >= 0 : op == "<" ? c < 0 : c <= 0;
                }
                case "between":
                {
                    string a = want[0].ToString(), b = want[1].ToString();
                    return string.Compare(s, a, StringComparison.OrdinalIgnoreCase) >= 0 && string.Compare(s, b, StringComparison.OrdinalIgnoreCase) <= 0;
                }
            }
            return false;
        }

        /// <summary>Matching a name leaf (family, type): equals (default for type_id-like), contains or starts.</summary>
        public static bool Name(string actual, JToken want, string match)
        {
            var wants = want is JArray a ? a.Select(x => x.ToString()) : new[] { want?.ToString() ?? "" };
            string m = match ?? "equals";
            return wants.Any(w => m == "contains" ? (actual ?? "").IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0
                : m == "starts" ? (actual ?? "").StartsWith(w, StringComparison.OrdinalIgnoreCase)
                : string.Equals(actual ?? "", w, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>A Yes/No given as true/false, yes/no, 1/0.</summary>
        public static int? YesNo(JToken t)
        {
            if (t == null) return null;
            if (t.Type == JTokenType.Boolean) return t.Value<bool>() ? 1 : 0;
            string s = t.ToString().Trim().ToLowerInvariant();
            if (s == "yes" || s == "true" || s == "1") return 1;
            if (s == "no" || s == "false" || s == "0") return 0;
            return null;
        }
    }

    /// <summary>Plan polygons (in_boundary, spec 5.4): validation and even-odd point-in-polygon in XY.</summary>
    public static class Polygon
    {
        public static List<(double X, double Y)> Read(JToken t)
        {
            var list = new List<(double, double)>();
            if (!(t is JArray a)) return list;
            foreach (JToken p in a)
                if (p is JArray xy && xy.Count >= 2) list.Add((Compare.Num(xy[0]), Compare.Num(xy[1])));
            // closed automatically: a repeated first point at the end is dropped
            if (list.Count > 1 && Math.Abs(list[0].Item1 - list[list.Count - 1].Item1) < 1e-9 && Math.Abs(list[0].Item2 - list[list.Count - 1].Item2) < 1e-9) list.RemoveAt(list.Count - 1);
            return list;
        }

        public static double Area(IList<(double X, double Y)> p)
        {
            double s = 0;
            for (int i = 0, j = p.Count - 1; i < p.Count; j = i++) s += (p[j].X * p[i].Y) - (p[i].X * p[j].Y);
            return Math.Abs(s) / 2;
        }

        /// <summary>Why this polygon can't be used, or null.</summary>
        public static string Problem(IList<(double X, double Y)> p)
        {
            if (p == null || p.Count < 3) return "a boundary needs at least 3 points";
            if (p.Count > FilterLimits.MaxPolygonVertices) return $"a boundary has at most {FilterLimits.MaxPolygonVertices} points (got {p.Count})";
            if (Area(p) < 1e-6) return "the boundary has zero area";
            int n = p.Count;
            for (int i = 0; i < n; i++)
                for (int j = i + 1; j < n; j++)
                {
                    if (j == i + 1 || (i == 0 && j == n - 1)) continue;   // neighbours share a point
                    if (Cross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return $"the boundary crosses itself (edges {i} and {j}); holes and figure-eights are refused";
                }
            return null;
        }

        private static bool Cross((double X, double Y) a, (double X, double Y) b, (double X, double Y) c, (double X, double Y) d)
        {
            double O((double X, double Y) p, (double X, double Y) q, (double X, double Y) r) => ((q.X - p.X) * (r.Y - p.Y)) - ((q.Y - p.Y) * (r.X - p.X));
            double o1 = O(a, b, c), o2 = O(a, b, d), o3 = O(c, d, a), o4 = O(c, d, b);
            if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
            bool On((double X, double Y) p, (double X, double Y) q, (double X, double Y) r, double o) =>
                Math.Abs(o) < 1e-9 && Math.Min(p.X, q.X) - 1e-9 <= r.X && r.X <= Math.Max(p.X, q.X) + 1e-9 && Math.Min(p.Y, q.Y) - 1e-9 <= r.Y && r.Y <= Math.Max(p.Y, q.Y) + 1e-9;
            return On(a, b, c, o1) || On(a, b, d, o2) || On(c, d, a, o3) || On(c, d, b, o4);
        }

        /// <summary>Even-odd test. A point on an edge counts as inside (the on-edge rule).</summary>
        public static bool Contains(IList<(double X, double Y)> p, double x, double y, double eps = 1e-6)
        {
            int n = p.Count;
            for (int i = 0, j = n - 1; i < n; j = i++)
            {
                var a = p[j]; var b = p[i];
                double cross = ((b.X - a.X) * (y - a.Y)) - ((b.Y - a.Y) * (x - a.X));
                double len = Math.Sqrt(((b.X - a.X) * (b.X - a.X)) + ((b.Y - a.Y) * (b.Y - a.Y)));
                if (len > 0 && Math.Abs(cross) / len <= eps && x >= Math.Min(a.X, b.X) - eps && x <= Math.Max(a.X, b.X) + eps && y >= Math.Min(a.Y, b.Y) - eps && y <= Math.Max(a.Y, b.Y) + eps)
                    return true;
            }
            bool inside = false;
            for (int i = 0, j = n - 1; i < n; j = i++)
            {
                if ((p[i].Y > y) != (p[j].Y > y) && x < ((p[j].X - p[i].X) * (y - p[i].Y) / (p[j].Y - p[i].Y)) + p[i].X) inside = !inside;
            }
            return inside;
        }

        public static (double MinX, double MinY, double MaxX, double MaxY) Bounds(IList<(double X, double Y)> p) =>
            (p.Min(v => v.X), p.Min(v => v.Y), p.Max(v => v.X), p.Max(v => v.Y));
    }

    /// <summary>One matched element in a snapshot: document index, link instance id (0 = host), element id.</summary>
    public struct SnapEntry : IComparable<SnapEntry>
    {
        public int D; public long L; public long Id;
        public SnapEntry(int d, long l, long id) { D = d; L = l; Id = id; }
        public int CompareTo(SnapEntry o) => D != o.D ? D.CompareTo(o.D) : L != o.L ? L.CompareTo(o.L) : Id.CompareTo(o.Id);
    }

    /// <summary>A stored result (spec 5.6): ids only, sorted, with the document version vector it was taken at.</summary>
    public sealed class Snapshot
    {
        public string Id;
        public string QueryHash;
        public JObject Query;
        public DateTime Created;
        public DateTime LastUsed;
        public List<string> DocKeys = new List<string>();
        public Dictionary<string, string> DocVersions = new Dictionary<string, string>();
        public JArray Docs = new JArray();          // [{index, title, path}]
        public JArray Links = new JArray();         // [{doc, instance_id, name, link_doc, link_path}]
        public List<SnapEntry> Entries = new List<SnapEntry>();
        public JArray Undetermined = new JArray();
        public JArray Skipped = new JArray();

        /// <summary>The index of the first entry after (d, l, a); 0 when the cursor is at the start.</summary>
        public int After(int d, long l, long a)
        {
            var key = new SnapEntry(d, l, a);
            int lo = 0, hi = Entries.Count;
            while (lo < hi) { int mid = (lo + hi) / 2; if (Entries[mid].CompareTo(key) <= 0) lo = mid + 1; else hi = mid; }
            return lo;
        }
    }

    /// <summary>The add-in's snapshot memory: at most 8, each kept 15 minutes after its last use (LRU), spec 5.6.</summary>
    public sealed class SnapshotCache
    {
        private readonly object _l = new object();
        private readonly LinkedList<Snapshot> _items = new LinkedList<Snapshot>();
        private readonly int _max;
        private readonly TimeSpan _idle;
        public Func<DateTime> Now = () => DateTime.UtcNow;

        public SnapshotCache(int max = FilterLimits.SnapshotsPerRevit, TimeSpan? idle = null) { _max = max; _idle = idle ?? FilterLimits.SnapshotIdle; }

        public static string NewId(string prefix = "rs_")
        {
            var b = new byte[6];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            return prefix + Hex(b);
        }

        public static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        public void Put(Snapshot s)
        {
            lock (_l)
            {
                Sweep();
                s.LastUsed = Now();
                _items.AddFirst(s);
                while (_items.Count > _max) _items.RemoveLast();
            }
        }

        public Snapshot Get(string id)
        {
            lock (_l)
            {
                Sweep();
                for (var n = _items.First; n != null; n = n.Next)
                    if (n.Value.Id == id)
                    {
                        _items.Remove(n); _items.AddFirst(n); n.Value.LastUsed = Now();
                        return n.Value;
                    }
                return null;
            }
        }

        public int Count { get { lock (_l) { Sweep(); return _items.Count; } } }

        /// <summary>A closed document drops every snapshot that read it.</summary>
        public int DropDocument(string docKey)
        {
            lock (_l)
            {
                int n = 0;
                for (var x = _items.First; x != null;)
                {
                    var next = x.Next;
                    if (x.Value.DocKeys.Contains(docKey)) { _items.Remove(x); n++; }
                    x = next;
                }
                return n;
            }
        }

        private void Sweep()
        {
            DateTime now = Now();
            for (var x = _items.First; x != null;)
            {
                var next = x.Next;
                if (now - x.Value.LastUsed > _idle) _items.Remove(x);
                x = next;
            }
        }
    }

    /// <summary>The opaque page cursor (spec 5.6): c1. + base64url JSON {rs, d, l, a, v, h}.</summary>
    public sealed class Cursor
    {
        public string Rs; public int D; public long L; public long A; public string V; public string H;

        public string Encode()
        {
            var o = new JObject { ["rs"] = Rs, ["d"] = D, ["l"] = L, ["a"] = A, ["v"] = V, ["h"] = H };
            string b = Convert.ToBase64String(Encoding.UTF8.GetBytes(o.ToString(Formatting.None))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            return "c1." + b;
        }

        public static Cursor Decode(string token)
        {
            if (string.IsNullOrWhiteSpace(token) || !token.StartsWith("c1.", StringComparison.Ordinal))
                throw Invalid("the cursor is not a c1. token");
            try
            {
                string b = token.Substring(3).Replace('-', '+').Replace('_', '/');
                b = b.PadRight(b.Length + ((4 - (b.Length % 4)) % 4), '=');
                var o = JObject.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(b)));
                var c = new Cursor { Rs = o.Value<string>("rs"), D = o.Value<int>("d"), L = o.Value<long>("l"), A = o.Value<long>("a"), V = o.Value<string>("v"), H = o.Value<string>("h") };
                if (string.IsNullOrEmpty(c.Rs) || string.IsNullOrEmpty(c.H) || !c.Rs.StartsWith("rs_", StringComparison.Ordinal) || !c.H.StartsWith("q_", StringComparison.Ordinal))
                    throw Invalid("the cursor is missing its result set or query hash");
                return c;
            }
            catch (FilterException) { throw; }
            catch (Exception) { throw Invalid("the cursor does not decode"); }
        }

        private static FilterException Invalid(string why) => new FilterException("FMC-FILTER-CURSOR-INVALID", why, "pass the cursor unchanged, or start again with run");
    }

    /// <summary>Stable hashes: the query (criteria, scope, invert, missing) and the version vector.</summary>
    public static class Hashes
    {
        public static JToken Canonical(JToken t)
        {
            if (t is JObject o)
            {
                var c = new JObject();
                foreach (var p in o.Properties().OrderBy(p => p.Name, StringComparer.Ordinal)) c[p.Name] = Canonical(p.Value);
                return c;
            }
            if (t is JArray a) return new JArray(a.Select(Canonical));
            return t?.DeepClone() ?? JValue.CreateNull();
        }

        public static string Sha(string s, int hex)
        {
            using (var sha = SHA256.Create()) return SnapshotCache.Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(s))).Substring(0, hex);
        }

        public static JObject QueryOf(JToken criteria, JToken scope, bool invert, string missing, string kind) => new JObject
        {
            ["criteria"] = criteria?.DeepClone(), ["scope"] = scope?.DeepClone() ?? new JObject(), ["invert"] = invert,
            ["missing"] = missing ?? "report", ["kind"] = kind ?? "instances",
        };

        public static string Query(JObject query) => "q_" + Sha(Canonical(query).ToString(Formatting.None), 12);

        public static string Versions(IDictionary<string, string> v) =>
            Sha(string.Join("|", v.OrderBy(k => k.Key, StringComparer.Ordinal).Select(k => k.Key + "=" + k.Value)), 12);

        /// <summary>Documents whose version differs between the snapshot and now (a closed one counts as changed).</summary>
        public static List<string> Changed(IDictionary<string, string> then, IDictionary<string, string> now) =>
            then.Where(k => !now.TryGetValue(k.Key, out string v) || v != k.Value).Select(k => k.Key).ToList();
    }

    /// <summary>The 256 KB page cap (spec 4.5): long values cut first, then extra params dropped from the rest of the page.</summary>
    public static class ByteCap
    {
        public static readonly string[] Keep = { "id", "name", "category", "doc", "link" };

        public static (bool truncated, List<string> dropped) Apply(JArray rows, int maxBytes = FilterLimits.PageBytes)
        {
            var dropped = new List<string>();
            if (Size(rows) <= maxBytes) return (false, dropped);
            foreach (JObject r in rows.OfType<JObject>())
                if (r["params"] is JObject ps)
                    foreach (var p in ps.Properties().ToList())
                        if (p.Value.Type == JTokenType.String && p.Value.ToString().Length > 200) p.Value = p.Value.ToString().Substring(0, 200) + "…";
            if (Size(rows) <= maxBytes) return (true, dropped);
            // drop params from the end of the page backwards until it fits
            for (int i = rows.Count - 1; i >= 0 && Size(rows) > maxBytes; i--)
            {
                if (!(rows[i] is JObject r) || !(r["params"] is JObject ps) || ps.Count == 0) continue;
                foreach (var p in ps.Properties()) if (!dropped.Contains(p.Name)) dropped.Add(p.Name);
                r["params"] = new JObject(); r["params_dropped"] = true;
            }
            // still too big: drop everything but the kept fields
            for (int i = rows.Count - 1; i >= 0 && Size(rows) > maxBytes; i--)
                if (rows[i] is JObject r)
                    foreach (var p in r.Properties().ToList()) if (!Keep.Contains(p.Name)) p.Remove();
            return (true, dropped);
        }

        public static int Size(JToken t) => Encoding.UTF8.GetByteCount(t.ToString(Formatting.None));
    }

    /// <summary>Key parameters per category (spec 4.3); the kit's filter.key_params overrides, passed in as key_params.</summary>
    public static class KeyParams
    {
        public static readonly Dictionary<string, string[]> Builtin = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["OST_Walls"] = new[] { "Type", "Base Constraint", "Unconnected Height", "Length", "Width", "Function", "Fire Rating", "Mark" },
            ["OST_Doors"] = new[] { "Mark", "Width", "Height", "Sill Height", "Fire Rating", "Host id", "From Room", "To Room" },
            ["OST_Windows"] = new[] { "Mark", "Width", "Height", "Sill Height", "Fire Rating", "Host id", "From Room", "To Room" },
            ["OST_Rooms"] = new[] { "Number", "Name", "Area", "Level", "Upper Limit", "Department" },
            ["OST_PipeCurves"] = new[] { "System Type", "Size", "Length", "Level" },
            ["OST_DuctCurves"] = new[] { "System Type", "Size", "Length", "Level" },
            ["*"] = new[] { "Mark", "Comments", "Type Mark" },
        };

        /// <summary>The list for a category, and where it came from ("kit" or "built-in default").</summary>
        public static (string[] names, string source) For(string bic, JObject kit)
        {
            if (kit != null)
            {
                if (kit[bic] is JArray k) return (k.Select(x => x.ToString()).ToArray(), "kit");
                string shortName = bic.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) ? bic.Substring(4) : bic;
                if (kit[shortName] is JArray k2) return (k2.Select(x => x.ToString()).ToArray(), "kit");
                if (kit["*"] is JArray k3) return (k3.Select(x => x.ToString()).ToArray(), "kit");
            }
            return (Builtin.TryGetValue(bic ?? "", out var b) ? b : Builtin["*"], "built-in default");
        }
    }
}
