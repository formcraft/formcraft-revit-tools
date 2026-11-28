using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.Filter
{
    /// <summary>Where a compiled plan runs: a host document, or a link seen from its host (spec 5.5).</summary>
    public sealed class FilterCtx
    {
        public Document Doc;            // the document whose elements are tested (host or link document)
        public Document Host;           // the host document (rooms, views, near ids live here)
        public RevitLinkInstance Link;  // null for the host
        public Transform T = Transform.Identity;   // Doc coordinates -> host coordinates
        public UIDocument Ui;           // the active UI document when the host is the active one
        public View Active;             // the active view when no UI document is given (modify_model / see_view select)
        public string Missing = "report";
        public bool IsLink => Link != null;
        public JArray Warnings = new JArray();
        public readonly Dictionary<ElementId, ElementType> Types = new Dictionary<ElementId, ElementType>();

        public ElementType TypeOf(Element e)
        {
            if (e is ElementType et) return et;
            ElementId t = e.GetTypeId();
            if (t == null || t == ElementId.InvalidElementId) return null;
            if (!Types.TryGetValue(t, out ElementType found)) Types[t] = found = Doc.GetElement(t) as ElementType;
            return found;
        }

        public void Warn(string w) { if (!Warnings.Any(x => x.ToString() == w)) Warnings.Add(w); }
    }

    /// <summary>A compiled leaf: a native Revit filter when it is exact and positive, and always a checked test.</summary>
    public sealed class CompiledLeaf
    {
        public Node Node;
        public string Label;
        public ElementFilter Native;          // exact native form (null: post-check only)
        public Outline Prefilter;             // a box in Doc coordinates around a spatial leaf (quick filter)
        public ICollection<ElementId> Start;  // ids leaf: start from these
        public View InView;                   // view leaf: collect in this view
        public Func<Element, Tri> Test;
        public bool IsParam;
        public string ParamName;
        public long Tested;
        public long Found;                    // elements on which the parameter existed
    }

    /// <summary>The compiled tree (spec 5.2): native filters for the collector, the rest checked per element.</summary>
    public sealed class Plan
    {
        public Node Root;
        public FilterCtx Ctx;
        public readonly Dictionary<Node, CompiledLeaf> Leaves = new Dictionary<Node, CompiledLeaf>();
        public readonly HashSet<Node> DoneNatively = new HashSet<Node>();
        public readonly List<ElementFilter> Collector = new List<ElementFilter>();
        public Outline Prefilter;
        public ICollection<ElementId> Start;
        public View InView;
        public bool NamesCategories;   // a category, class or ids leaf at the top: annotation categories are wanted
        public bool Empty;             // a leaf at the top can match nothing in this document (e.g. no such level in a link)
        public List<string> NativeLabels = new List<string>();
        public List<string> PostLabels = new List<string>();
        public bool MixedOr;

        public Tri Eval(Element e) => Eval(Root, e);

        private Tri Eval(Node n, Element e)
        {
            switch (n.Kind)
            {
                case Node.NodeKind.All: return Tri.And(n.Children.Select(c => (Func<Tri>)(() => Eval(c, e))));
                case Node.NodeKind.Any: return Tri.Or(n.Children.Select(c => (Func<Tri>)(() => Eval(c, e))));
                default:
                {
                    if (DoneNatively.Contains(n)) return Tri.T;
                    CompiledLeaf l = Leaves[n];
                    Tri t;
                    try { t = l.Test(e); }
                    catch (FilterException) { throw; }
                    catch (Exception x) { t = Tri.Unknown(l.IsParam ? "PARAM_UNREADABLE" : "INFO_FAILED", $"{l.Label}: {x.GetType().Name} {x.Message}"); }
                    if (l.IsParam) { l.Tested++; if (!(t.IsUnknown && t.Reason == "PARAM_MISSING")) l.Found++; }
                    t = t.Resolve(Ctx.Missing);
                    return n.Negate ? t.Not() : t;
                }
            }
        }

        public JObject Explain() => new JObject
        {
            ["tree"] = Root.ToString(),
            ["native"] = new JArray(NativeLabels),
            ["post"] = new JArray(PostLabels),
            ["prefilter_box"] = Prefilter != null,
            ["start_ids"] = Start?.Count,
            ["in_view"] = InView?.Name,
            ["cost"] = MixedOr ? "OR with a post-check: scans the whole scope" : PostLabels.Count == 0 ? "native only: counted without reading elements" : "native first, then post-checks on what is left",
        };
    }

    /// <summary>Compiles a normalised criteria tree for one document (names resolve in that document, spec 5.2).</summary>
    public static class FilterCompiler
    {
        private const double Pad = 1.0;   // a foot of slack around quick boxes; the exact tests decide
        private static double Ft(double mm) => mm / 304.8;
        private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        public static Plan Compile(FilterCtx ctx, Node root)
        {
            var plan = new Plan { Root = root, Ctx = ctx };
            foreach (Node leaf in root.Leaves()) plan.Leaves[leaf] = CompileLeaf(ctx, leaf);
            // the top AND (or a single leaf): positive native leaves go to the collector, spatial boxes to the quick box
            var top = root.Kind == Node.NodeKind.All ? root.Children : root.Kind == Node.NodeKind.Leaf ? new List<Node> { root } : new List<Node>();
            foreach (Node n in top.Where(x => x.Kind == Node.NodeKind.Leaf && !x.Negate))
            {
                CompiledLeaf l = plan.Leaves[n];
                if (l.Native != null) { plan.Collector.Add(l.Native); plan.DoneNatively.Add(n); plan.NativeLabels.Add(l.Label); }
                if (l.Prefilter != null) plan.Prefilter = plan.Prefilter == null ? l.Prefilter : Intersect(plan.Prefilter, l.Prefilter);
                if (l.Start != null) { plan.Start = plan.Start == null ? l.Start : plan.Start.Intersect(l.Start).ToList(); plan.DoneNatively.Add(n); plan.NativeLabels.Add(l.Label); }
                if (l.InView != null && plan.InView == null) { plan.InView = l.InView; plan.DoneNatively.Add(n); plan.NativeLabels.Add(l.Label); }
                if (n.LeafKind == "category" || n.LeafKind == "class" || n.LeafKind == "ids") plan.NamesCategories = true;
            }
            foreach (var kv in plan.Leaves.Where(kv => !plan.DoneNatively.Contains(kv.Key)))
                plan.PostLabels.Add((kv.Key.Negate ? "not " : "") + kv.Value.Label);
            plan.MixedOr = HasMixedOr(root, plan);
            return plan;
        }

        private static bool HasMixedOr(Node n, Plan p)
        {
            if (n.Kind == Node.NodeKind.Leaf) return false;
            if (n.Kind == Node.NodeKind.Any && n.Children.Any(c => c.Kind != Node.NodeKind.Leaf || p.Leaves[c].Native == null || c.Negate)) return true;
            return n.Children.Any(c => HasMixedOr(c, p));
        }

        private static Outline Intersect(Outline a, Outline b)
        {
            var lo = new XYZ(Math.Max(a.MinimumPoint.X, b.MinimumPoint.X), Math.Max(a.MinimumPoint.Y, b.MinimumPoint.Y), Math.Max(a.MinimumPoint.Z, b.MinimumPoint.Z));
            var hi = new XYZ(Math.Min(a.MaximumPoint.X, b.MaximumPoint.X), Math.Min(a.MaximumPoint.Y, b.MaximumPoint.Y), Math.Min(a.MaximumPoint.Z, b.MaximumPoint.Z));
            if (lo.X > hi.X || lo.Y > hi.Y || lo.Z > hi.Z) lo = hi = new XYZ(1e9, 1e9, 1e9);   // disjoint: nothing passes
            return new Outline(lo, hi);
        }

        /// <summary>A host-coordinate box as a box in the tested document's coordinates (8 corners moved, then re-boxed).</summary>
        public static Outline ToDoc(FilterCtx ctx, XYZ min, XYZ max)
        {
            if (!ctx.IsLink) return new Outline(min, max);
            Transform inv = ctx.T.Inverse;
            var pts = Corners(min, max).Select(inv.OfPoint).ToList();
            return new Outline(new XYZ(pts.Min(p => p.X), pts.Min(p => p.Y), pts.Min(p => p.Z)), new XYZ(pts.Max(p => p.X), pts.Max(p => p.Y), pts.Max(p => p.Z)));
        }

        public static IEnumerable<XYZ> Corners(XYZ a, XYZ b)
        {
            foreach (double x in new[] { a.X, b.X }) foreach (double y in new[] { a.Y, b.Y }) foreach (double z in new[] { a.Z, b.Z }) yield return new XYZ(x, y, z);
        }

        private static CompiledLeaf CompileLeaf(FilterCtx ctx, Node n)
        {
            JObject o = n.Leaf;
            var l = new CompiledLeaf { Node = n, Label = Criteria.Describe(o, n.LeafKind) };
            Document doc = ctx.Doc;
            switch (n.LeafKind)
            {
                case "category":
                {
                    var bics = Categories(doc, o["category"]);
                    var set = new HashSet<BuiltInCategory>(bics);
                    l.Native = new ElementMulticategoryFilter(bics);
                    l.Test = e => Tri.Of(e.Category != null && set.Contains(e.Category.BuiltInCategory));
                    break;
                }
                case "class":
                {
                    var types = (o["class"] is JArray ca ? ca.Select(x => x.ToString()) : new[] { o.Value<string>("class") }).Select(ClassOf).ToList();
                    try
                    {
                        var filters = types.Select(t => (ElementFilter)new ElementClassFilter(t)).ToList();
                        l.Native = filters.Count == 1 ? filters[0] : new LogicalOrFilter(filters);
                    }
                    catch (Exception) { l.Native = null; /* a class Revit's quick filter refuses (Room...): checked per element */ }
                    l.Test = e => Tri.Of(types.Any(t => t.IsInstanceOfType(e)));
                    break;
                }
                case "family":
                {
                    string match = o.Value<string>("match") ?? "equals";
                    l.Test = e =>
                    {
                        ElementType t = ctx.TypeOf(e);
                        string fam = t?.FamilyName ?? (e as FamilyInstance)?.Symbol?.FamilyName ?? (e is Family f ? f.Name : null);
                        return Tri.Of(fam != null && Compare.Name(fam, o["family"], match));
                    };
                    break;
                }
                case "type":
                {
                    string match = o.Value<string>("match") ?? "equals";
                    l.Test = e => { ElementType t = ctx.TypeOf(e); return Tri.Of(t != null && Compare.Name(t.Name, o["type"], match)); };
                    break;
                }
                case "type_id":
                {
                    var ids = (o["type_id"] is JArray ta ? ta.ToList() : new List<JToken> { o["type_id"] }).Select(t => new ElementId(t.Value<long>())).ToList();
                    var set = new HashSet<long>(ids.Select(x => x.Value));
                    var rules = ids.Select(id => (ElementFilter)new ElementParameterFilter(ParameterFilterRuleFactory.CreateEqualsRule(new ElementId(BuiltInParameter.ELEM_TYPE_PARAM), id))).ToList();
                    l.Native = rules.Count == 1 ? rules[0] : new LogicalOrFilter(rules);
                    l.Test = e => Tri.Of(set.Contains(e.GetTypeId().Value) || (e is ElementType && set.Contains(e.Id.Value)));
                    if (ctx.IsLink) ctx.Warn("type_id is an id in one document: in links it matches only types with that id in the link");
                    break;
                }
                case "ids":
                {
                    IEnumerable<ElementId> ids;
                    if (o.Value<string>("ids") == "selection" || (o["ids"] is JArray sa && sa.Count == 1 && sa[0].ToString() == "selection"))
                    {
                        if (ctx.Ui == null) throw new FilterException("FMC-FILTER-UI-NEEDS-ACTIVE", $"ids \"selection\" reads the person's selection, so {ctx.Host.Title} must be the active document", "ask the person to activate the model, or pass ids");
                        ids = ctx.IsLink ? Enumerable.Empty<ElementId>() : ctx.Ui.Selection.GetElementIds();
                    }
                    else ids = ((JArray)o["ids"]).Select(t => IdOf(doc, t)).Where(x => x != ElementId.InvalidElementId);
                    var list = ids.Where(x => doc.GetElement(x) != null).ToList();
                    var set = new HashSet<long>(list.Select(x => x.Value));
                    l.Start = list;
                    l.Test = e => Tri.Of(set.Contains(e.Id.Value));
                    if (ctx.IsLink) ctx.Warn("ids are ids in one document: in links they match only elements with those ids in the link");
                    break;
                }
                case "level":
                {
                    var levels = LevelsOf(doc, o["level"]);
                    if (levels.Count == 0)
                    {
                        if (!ctx.IsLink) throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"no level \"{o["level"]}\" in {doc.Title}", "use a level name or id", new JArray(new FilteredElementCollector(doc).OfClass(typeof(Level)).Select(x => x.Name).Take(20)));
                        ctx.Warn($"link {doc.Title} has no level \"{o["level"]}\": nothing in it matches that leaf");
                    }
                    var set = new HashSet<long>(levels.Select(x => x.Value));
                    var parts = new List<ElementFilter>();
                    foreach (ElementId lv in levels)
                    {
                        parts.Add(new ElementLevelFilter(lv));
                        parts.Add(new ElementParameterFilter(ParameterFilterRuleFactory.CreateEqualsRule(new ElementId(BuiltInParameter.WALL_BASE_CONSTRAINT), lv)));
                        parts.Add(new ElementParameterFilter(ParameterFilterRuleFactory.CreateEqualsRule(new ElementId(BuiltInParameter.FAMILY_LEVEL_PARAM), lv)));
                    }
                    l.Native = parts.Count == 0 ? null : parts.Count == 1 ? parts[0] : new LogicalOrFilter(parts);
                    bool On(Parameter p) => p != null && p.StorageType == StorageType.ElementId && set.Contains(p.AsElementId().Value);
                    l.Test = e => Tri.Of(set.Contains(e.LevelId.Value) || On(e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)) || On(e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)));
                    if (levels.Count == 0) { l.Native = null; l.Test = e => Tri.F; }
                    break;
                }
                case "workset":
                {
                    if (!doc.IsWorkshared)
                    {
                        ctx.Warn($"{doc.Title} is not workshared: the workset leaf matches nothing in it");
                        l.Test = e => Tri.F;
                        break;
                    }
                    string name = o.Value<string>("workset");
                    Workset ws = new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).FirstOrDefault(w => Same(w.Name, name));
                    if (ws == null)
                    {
                        if (!ctx.IsLink) throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"no workset \"{name}\" in {doc.Title}", "use a user workset name", new JArray(new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).Select(w => w.Name).Take(20)));
                        ctx.Warn($"link {doc.Title} has no workset \"{name}\"");
                        l.Test = e => Tri.F;
                        break;
                    }
                    l.Native = new ElementWorksetFilter(ws.Id);
                    l.Test = e => Tri.Of(e.WorksetId == ws.Id);
                    break;
                }
                case "phase_created":
                {
                    string name = o.Value<string>("phase_created");
                    var ph = new HashSet<long>(doc.Phases.Cast<Phase>().Where(x => Same(x.Name, name)).Select(x => x.Id.Value));
                    if (ph.Count == 0 && !ctx.IsLink) throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"no phase \"{name}\" in {doc.Title}", "use a phase name", new JArray(doc.Phases.Cast<Phase>().Select(x => x.Name)));
                    l.Test = e => e.get_Parameter(BuiltInParameter.PHASE_CREATED) is Parameter p ? Tri.Of(ph.Contains(p.AsElementId().Value)) : Tri.Unknown("PARAM_MISSING", "Phase Created");
                    break;
                }
                case "design_option":
                {
                    string name = o.Value<string>("design_option");
                    l.Test = e =>
                    {
                        DesignOption d = e.DesignOption;
                        if (Same(name, "main")) return Tri.Of(d == null);
                        return Tri.Of(d != null && (Same(d.Name, name) || d.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0));
                    };
                    break;
                }
                case "view":
                {
                    View v = ViewOf(ctx, o.Value<string>("view"));
                    l.InView = ctx.IsLink ? null : v;
                    HashSet<long> visible = null;
                    l.Test = e =>
                    {
                        visible = visible ?? new HashSet<long>(ViewCollector(ctx, v).ToElementIds().Select(x => x.Value));
                        return Tri.Of(visible.Contains(e.Id.Value));
                    };
                    if (ctx.IsLink) { l.Start = ViewCollector(ctx, v).ToElementIds(); }
                    break;
                }
                case "tagged_in_view":
                {
                    View v = ViewOf(ctx, o.Value<string>("tagged_in_view"));
                    bool want = o.Value<bool?>("is") ?? true;
                    HashSet<long> tagged = null;
                    l.Label = $"tagged_in_view:{v.Name} is {want}";
                    l.Test = e =>
                    {
                        tagged = tagged ?? TaggedIn(ctx, v);
                        return Tri.Of(tagged.Contains(e.Id.Value) == want);
                    };
                    break;
                }
                case "param":
                    CompileParam(ctx, o, l);
                    break;
                case "in_room":
                    CompileRoom(ctx, (JObject)o["in_room"], l);
                    break;
                case "in_boundary":
                    CompileBoundary(ctx, (JObject)o["in_boundary"], l);
                    break;
                case "in_box":
                {
                    var spec = (JObject)o["in_box"];
                    var a = (JArray)spec["min_mm"]; var b = (JArray)spec["max_mm"];
                    double F(JToken t) => Ft(t.Value<double>());
                    var min = new XYZ(Math.Min(F(a[0]), F(b[0])), Math.Min(F(a[1]), F(b[1])), a.Count > 2 && b.Count > 2 ? Math.Min(F(a[2]), F(b[2])) : -1e6);
                    var max = new XYZ(Math.Max(F(a[0]), F(b[0])), Math.Max(F(a[1]), F(b[1])), a.Count > 2 && b.Count > 2 ? Math.Max(F(a[2]), F(b[2])) : 1e6);
                    bool inside = spec.Value<bool?>("inside") == true;
                    l.Prefilter = ToDoc(ctx, min - new XYZ(Pad, Pad, Pad), max + new XYZ(Pad, Pad, Pad));
                    l.Test = e =>
                    {
                        var bb = HostBox(ctx, e);
                        if (bb == null) return Tri.Unknown("NO_LOCATION", "in_box needs a bounding box");
                        var (lo, hi) = bb.Value;
                        return Tri.Of(inside ? lo.X >= min.X && hi.X <= max.X && lo.Y >= min.Y && hi.Y <= max.Y && lo.Z >= min.Z && hi.Z <= max.Z
                            : hi.X >= min.X && lo.X <= max.X && hi.Y >= min.Y && lo.Y <= max.Y && hi.Z >= min.Z && lo.Z <= max.Z);
                    };
                    break;
                }
                case "box":
                {
                    // a section-box spec (FmcBox, turned boxes too), in host coordinates
                    var spec = (JObject)o["box"];
                    BoundingBoxXYZ bx = FmcBox.Resolve(ctx.Host, spec, t => FmcBox.Id(ctx.Host, t), null, out _);
                    Transform inv = bx.Transform.Inverse;
                    bool inside = spec.Value<bool?>("inside") == true;
                    var wc = FmcBox.Corners(bx);
                    l.Prefilter = ToDoc(ctx, new XYZ(wc.Min(v => v.X) - Pad, wc.Min(v => v.Y) - Pad, wc.Min(v => v.Z) - Pad), new XYZ(wc.Max(v => v.X) + Pad, wc.Max(v => v.Y) + Pad, wc.Max(v => v.Z) + Pad));
                    l.Test = e =>
                    {
                        if (!(e.get_BoundingBox(null) is BoundingBoxXYZ bb)) return Tri.Unknown("NO_LOCATION", "box needs a bounding box");
                        var c = Corners(bb.Min, bb.Max).Select(ctx.T.OfPoint).Select(inv.OfPoint).ToList();
                        double x0 = c.Min(v => v.X), x1 = c.Max(v => v.X), y0 = c.Min(v => v.Y), y1 = c.Max(v => v.Y), z0 = c.Min(v => v.Z), z1 = c.Max(v => v.Z);
                        return Tri.Of(inside ? x0 >= bx.Min.X && x1 <= bx.Max.X && y0 >= bx.Min.Y && y1 <= bx.Max.Y && z0 >= bx.Min.Z && z1 <= bx.Max.Z
                            : x1 >= bx.Min.X && x0 <= bx.Max.X && y1 >= bx.Min.Y && y0 <= bx.Max.Y && z1 >= bx.Min.Z && z0 <= bx.Max.Z);
                    };
                    break;
                }
                case "near":
                {
                    var near = (JObject)o["near"];
                    XYZ at;
                    bool flat = false;
                    if (near["point_mm"] is JArray pt) { at = new XYZ(Ft(pt[0].Value<double>()), Ft(pt[1].Value<double>()), pt.Count > 2 ? Ft(pt[2].Value<double>()) : 0); flat = pt.Count < 3; }
                    else
                    {
                        Element of = ctx.Host.GetElement(IdOf(ctx.Host, near["id"]));
                        at = (of == null ? null : Centre(of)) ?? throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"near: no element {near["id"]} with a place in {ctx.Host.Title}", "give an element id with a location, or point_mm");
                    }
                    double within = Ft(near.Value<double?>("within_mm") ?? 1000);
                    l.Prefilter = ToDoc(ctx, new XYZ(at.X - within - Pad, at.Y - within - Pad, flat ? -1e6 : at.Z - within - Pad), new XYZ(at.X + within + Pad, at.Y + within + Pad, flat ? 1e6 : at.Z + within + Pad));
                    l.Test = e =>
                    {
                        var bb = HostBox(ctx, e);
                        if (bb == null) return Tri.Unknown("NO_LOCATION", "near needs a bounding box");
                        var (lo, hi) = bb.Value;
                        double dx = Math.Max(0, Math.Max(lo.X - at.X, at.X - hi.X)), dy = Math.Max(0, Math.Max(lo.Y - at.Y, at.Y - hi.Y));
                        double dz = flat ? 0 : Math.Max(0, Math.Max(lo.Z - at.Z, at.Z - hi.Z));
                        return Tri.Of(Math.Sqrt((dx * dx) + (dy * dy) + (dz * dz)) <= within);
                    };
                    break;
                }
                case "hosted_by":
                {
                    ElementId h = IdOf(doc, o["hosted_by"]);
                    l.Test = e => Tri.Of(e is FamilyInstance fi && (fi.Host?.Id == h || fi.SuperComponent?.Id == h));
                    break;
                }
                case "host_of":
                {
                    Element child = doc.GetElement(IdOf(doc, o["host_of"]));
                    ElementId h = (child as FamilyInstance)?.Host?.Id ?? ElementId.InvalidElementId;
                    l.Test = e => Tri.Of(e.Id == h);
                    break;
                }
                default:
                    throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"unknown leaf {l.Label}");
            }
            return l;
        }

        // ---- parameters (spec 5.3) -----------------------------------------------------------------------------------

        private static void CompileParam(FilterCtx ctx, JObject o, CompiledLeaf l)
        {
            l.IsParam = true;
            string of = o.Value<string>("of") ?? "either";
            string op = o.Value<string>("op") ?? "=";
            string unit = o.Value<string>("unit");
            JToken want = o["value"];
            BuiltInParameter bip = BuiltInParameter.INVALID;
            Guid guid = Guid.Empty;
            string name = o.Value<string>("param");
            if (o["bip"] != null)
            {
                string b = o.Value<string>("bip");
                if (!Enum.TryParse(b, true, out bip) || bip == BuiltInParameter.INVALID)
                    throw new FilterException("FMC-FILTER-UNKNOWN-PARAM", $"no built-in parameter {b}", "check the BuiltInParameter name, or use param with the display name");
                name = b;
            }
            else if (o["guid"] != null)
            {
                if (!Guid.TryParse(o.Value<string>("guid"), out guid)) throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"guid {o["guid"]} is not a GUID");
                name = name ?? o.Value<string>("guid");
            }
            else if (!ctx.IsLink)
            {
                // the same name on several project or shared parameter definitions is refused: the agent picks one
                var defs = new FilteredElementCollector(ctx.Doc).OfClass(typeof(ParameterElement)).Cast<ParameterElement>()
                    .Where(pe => Same(pe.GetDefinition()?.Name, name)).ToList();
                if (defs.Count > 1)
                    throw new FilterException("FMC-FILTER-PARAM-AMBIGUOUS", $"{defs.Count} parameter definitions are named \"{name}\"", "pass bip or guid, or of",
                        new JArray(defs.Select(d => new JObject { ["id"] = d.Id.Value, ["guid"] = (d as SharedParameterElement)?.GuidValue.ToString() ?? "", ["kind"] = d is SharedParameterElement ? "shared" : "project" })));
            }
            l.ParamName = name;
            l.Label = Criteria.Describe(o, "param") + (of != "either" ? $" (of {of})" : "");
            Parameter Get(Element x) => bip != BuiltInParameter.INVALID ? x.get_Parameter(bip) : guid != Guid.Empty ? x.get_Parameter(guid) : x.LookupParameter(name);
            l.Test = e =>
            {
                Parameter p = null;
                if (of != "type") p = Get(e);
                if (p == null && of != "instance") { ElementType t = ctx.TypeOf(e); if (t != null) p = Get(t); }
                if (p == null) return Tri.Unknown("PARAM_MISSING", name);
                return Test(ctx, p, op, want, unit, name);
            };
        }

        public static Units.Spec SpecOf(Parameter p)
        {
            try
            {
                ForgeTypeId t = p.Definition.GetDataType();
                if (t == SpecTypeId.Length) return Units.Spec.Length;
                if (t == SpecTypeId.Area) return Units.Spec.Area;
                if (t == SpecTypeId.Volume) return Units.Spec.Volume;
                if (t == SpecTypeId.Angle) return Units.Spec.Angle;
            }
            catch (Exception) { }
            return Units.Spec.Other;
        }

        public static bool IsYesNo(Parameter p)
        {
            try { return p.Definition.GetDataType() == SpecTypeId.Boolean.YesNo; } catch (Exception) { return false; }
        }

        private static Tri Test(FilterCtx ctx, Parameter p, string op, JToken want, string unit, string name)
        {
            if (op == "empty" || op == "not_empty")
            {
                bool empty = !p.HasValue
                    || (p.StorageType == StorageType.String && string.IsNullOrEmpty(p.AsString()))
                    || (p.StorageType == StorageType.ElementId && (p.AsElementId() == null || p.AsElementId() == ElementId.InvalidElementId));
                return Tri.Of(op == "empty" ? empty : !empty);
            }
            switch (p.StorageType)
            {
                case StorageType.Double:
                {
                    if (!p.HasValue) return Tri.Unknown("PARAM_UNREADABLE", $"{name} has no value");
                    Units.Spec spec = SpecOf(p);
                    if (Compare.IsNumber(want))
                    {
                        if (spec == Units.Spec.Other && unit != null) ctx.Warn($"{name} is not a length, area, volume or angle: {unit} is ignored and the value passed unchanged");
                        else if (spec == Units.Spec.Other) ctx.Warn($"{name} is compared in Revit's internal units ({p.Definition.GetDataType()?.TypeId})");
                        Func<double, double> conv = v => spec == Units.Spec.Other ? v : Units.ToInternal(v, spec, unit);
                        double tol = spec == Units.Spec.Length ? Units.Tolerance(spec, 0) : -1;
                        return Tri.Of(Compare.Number(op, p.AsDouble(), want, conv, tol));
                    }
                    return Tri.Of(Compare.Text(op, p.AsValueString() ?? "", want));
                }
                case StorageType.Integer:
                {
                    if (!p.HasValue) return Tri.Unknown("PARAM_UNREADABLE", $"{name} has no value");
                    int v = p.AsInteger();
                    if (IsYesNo(p))
                    {
                        if (op == "in") return Tri.Of(((JArray)want).Any(w => Compare.YesNo(w) == v));
                        int? w1 = Compare.YesNo(want);
                        if (w1 == null) throw new FilterException("FMC-FILTER-UNIT", $"{name} is Yes/No: give true/false or yes/no, not {want}");
                        return Tri.Of(op == "!=" ? v != w1 : v == w1);
                    }
                    if (Compare.IsNumber(want)) return Tri.Of(Compare.Number(op, v, want, x => x, 1e-9));
                    // an enum-backed integer (Function: Exterior...) compared by its display text
                    return Tri.Of(Compare.Text(op, p.AsValueString() ?? v.ToString(), want));
                }
                case StorageType.String:
                    return Tri.Of(Compare.Text(op, p.AsString() ?? "", want));
                case StorageType.ElementId:
                {
                    ElementId id = p.AsElementId();
                    if (Compare.IsNumber(want)) return Tri.Of(Compare.Number(op, id?.Value ?? -1, want, x => x, 0.1));
                    string s = id == null || id == ElementId.InvalidElementId ? "" : p.Element?.Document?.GetElement(id)?.Name ?? p.AsValueString() ?? "";
                    return Tri.Of(Compare.Text(op, s, want));
                }
                default:
                    return Tri.Unknown("PARAM_UNREADABLE", $"{name} has no readable storage");
            }
        }

        // ---- spatial (spec 5.4) --------------------------------------------------------------------------------------

        /// <summary>An element's test point in host coordinates: location point, curve middle, else box centre.</summary>
        public static XYZ Centre(Element e)
        {
            if (e?.Location is LocationPoint lp) return lp.Point;
            if (e?.Location is LocationCurve lc) return lc.Curve.Evaluate(0.5, true);
            var b = e?.get_BoundingBox(null);
            return b == null ? null : (b.Min + b.Max) / 2;
        }

        private static XYZ HostCentre(FilterCtx ctx, Element e) { XYZ c = Centre(e); return c == null ? null : ctx.T.OfPoint(c); }

        /// <summary>Box corners and curve end points, in host coordinates (any_point mode).</summary>
        private static List<XYZ> HostPoints(FilterCtx ctx, Element e)
        {
            var pts = new List<XYZ>();
            if (e.Location is LocationCurve lc) { pts.Add(lc.Curve.GetEndPoint(0)); pts.Add(lc.Curve.GetEndPoint(1)); }
            if (e.get_BoundingBox(null) is BoundingBoxXYZ bb) pts.AddRange(Corners(bb.Min, bb.Max));
            XYZ c = Centre(e); if (c != null) pts.Add(c);
            return pts.Select(ctx.T.OfPoint).ToList();
        }

        /// <summary>The element's box in host coordinates (re-boxed after the link transform).</summary>
        private static (XYZ, XYZ)? HostBox(FilterCtx ctx, Element e)
        {
            if (!(e.get_BoundingBox(null) is BoundingBoxXYZ bb)) return null;
            if (!ctx.IsLink) return (bb.Min, bb.Max);
            var c = Corners(bb.Min, bb.Max).Select(ctx.T.OfPoint).ToList();
            return (new XYZ(c.Min(v => v.X), c.Min(v => v.Y), c.Min(v => v.Z)), new XYZ(c.Max(v => v.X), c.Max(v => v.Y), c.Max(v => v.Z)));
        }

        /// <summary>A room by id, number or name among the host's rooms (or a link's, room_link). Not enclosed is refused.</summary>
        public static Room RoomOf(Document doc, JToken t, UIDocument ui)
        {
            string s = t?.ToString() ?? "";
            if (Same(s, "selected"))
            {
                if (ui == null) throw new FilterException("FMC-FILTER-UI-NEEDS-ACTIVE", $"room \"selected\" reads the person's selection, so {doc.Title} must be the active document", "ask the person to activate the model, or give the room's id, number or name");
                var picked = ui.Selection.GetElementIds().Select(doc.GetElement).OfType<Room>().ToList();
                if (picked.Count != 1) throw new FilterException("FMC-FILTER-ROOM-NOT-FOUND", $"room \"selected\" needs exactly one selected room ({picked.Count} selected)", "ask the person to select one room");
                return Enclosed(picked[0]);
            }
            var rooms = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().OfType<Room>().ToList();
            Room r = null;
            if (long.TryParse(s, out long n)) r = rooms.FirstOrDefault(x => x.Id.Value == n);
            r = r ?? rooms.Where(x => Same(x.Number, s)).OrderByDescending(x => x.Area).FirstOrDefault()
                  ?? rooms.Where(x => Same(x.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(), s)).OrderByDescending(x => x.Area).FirstOrDefault();
            if (r == null)
                throw new FilterException("FMC-FILTER-ROOM-NOT-FOUND", $"no room \"{s}\" in {doc.Title}", "give the room's id, number or name",
                    new JArray(rooms.Where(x => (x.Number ?? "").IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0 || (x.Name ?? "").IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0).Take(5).Select(x => $"{x.Number} {x.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString()} (id {x.Id.Value})")));
            return Enclosed(r);
        }

        private static Room Enclosed(Room r)
        {
            if (r.Location == null || r.Area <= 0)
                throw new FilterException("FMC-FILTER-ROOM-NOT-ENCLOSED", $"room {r.Number} (id {r.Id.Value}) is not placed or not enclosed (area 0)", "fix the room bounding, or pick another room", new JObject { ["room_id"] = r.Id.Value });
            return r;
        }

        private static void CompileRoom(FilterCtx ctx, JObject spec, CompiledLeaf l)
        {
            string mode = spec.Value<string>("mode") ?? "center";
            string z = spec.Value<string>("z") ?? "room";
            // the room lives in the host, or in a named link (room_link): its points map host -> room document
            Document roomDoc = ctx.Host;
            Transform hostToRoom = Transform.Identity;
            if (spec["room_link"] != null)
            {
                string ln = spec.Value<string>("room_link");
                var inst = new FilteredElementCollector(ctx.Host).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>()
                    .FirstOrDefault(i => i.GetLinkDocument() != null && (Same(i.GetLinkDocument().Title, ln) || i.Name.IndexOf(ln, StringComparison.OrdinalIgnoreCase) >= 0))
                    ?? throw new FilterException("FMC-FILTER-ROOM-NOT-FOUND", $"no loaded link \"{ln}\" holds rooms for room_link", "name a loaded link");
                roomDoc = inst.GetLinkDocument();
                hostToRoom = inst.GetTotalTransform().Inverse;
            }
            Room r = RoomOf(roomDoc, spec["room"], roomDoc == ctx.Host ? ctx.Ui : null);
            l.Label = $"in_room:{r.Number} {r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString()} ({mode})";
            double lvl = r.Level?.Elevation ?? 0;
            double next = NextLevel(roomDoc, lvl);
            if (r.get_BoundingBox(null) is BoundingBoxXYZ rb)
            {
                var hc = Corners(rb.Min, rb.Max).Select(hostToRoom.Inverse.OfPoint).ToList();
                l.Prefilter = ToDoc(ctx, new XYZ(hc.Min(v => v.X) - Pad, hc.Min(v => v.Y) - Pad, -1e6), new XYZ(hc.Max(v => v.X) + Pad, hc.Max(v => v.Y) + Pad, 1e6));
            }
            Solid solid = null;
            ElementFilter solidFilter = null;
            l.Test = e =>
            {
                if (e.Id == r.Id && ctx.Doc.Equals(roomDoc)) return Tri.F;
                try
                {
                    if (mode == "solid")
                    {
                        if (solidFilter == null)
                        {
                            solid = new SpatialElementGeometryCalculator(roomDoc).CalculateSpatialElementGeometry(r).GetGeometry();
                            Transform toDoc = ctx.T.Inverse.Multiply(hostToRoom.Inverse);   // room doc -> host -> tested doc
                            if (!toDoc.IsIdentity) solid = SolidUtils.CreateTransformed(solid, toDoc);
                            solidFilter = new ElementIntersectsSolidFilter(solid);
                        }
                        return Tri.Of(solidFilter.PassesFilter(e));
                    }
                    if (e is FamilyInstance fi && ctx.Doc.Equals(roomDoc) && (fi.Room?.Id == r.Id || fi.FromRoom?.Id == r.Id || fi.ToRoom?.Id == r.Id)) return Tri.T;
                    var pts = mode == "any_point" ? HostPoints(ctx, e) : new List<XYZ> { HostCentre(ctx, e) };
                    if (pts.Count == 0 || pts[0] == null) return Tri.Unknown("NO_LOCATION", "in_room needs a point or a box");
                    foreach (XYZ hp in pts)
                    {
                        XYZ p = hostToRoom.OfPoint(hp);
                        if (z == "level_band" && (p.Z < lvl - 1e-6 || p.Z >= next)) continue;
                        double test = z == "room" ? Math.Max(p.Z, lvl + 1.0) : lvl + 1.0;
                        if (r.IsPointInRoom(new XYZ(p.X, p.Y, test)) || (z == "room" && r.IsPointInRoom(new XYZ(p.X, p.Y, lvl + 1.0)))) return Tri.T;
                    }
                    return Tri.F;
                }
                catch (Exception x) { return Tri.Unknown("ROOM_TEST_FAILED", $"{x.GetType().Name}: {x.Message}"); }
            };
        }

        private static double NextLevel(Document doc, double elev)
        {
            var above = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().Select(x => x.Elevation).Where(v => v > elev + 1e-6).ToList();
            return above.Count > 0 ? above.Min() : 1e6;
        }

        private static void CompileBoundary(FilterCtx ctx, JObject spec, CompiledLeaf l)
        {
            var mm = Polygon.Read(spec["polygon_mm"]);
            var pts = mm.Select(p => (Ft(p.X), Ft(p.Y))).ToList();
            string mode = spec.Value<string>("mode") ?? "center";
            double z0 = -1e6, z1 = 1e6;
            if (spec["z_mm"] is JArray zz && zz.Count == 2) { z0 = Ft(Math.Min(zz[0].Value<double>(), zz[1].Value<double>())); z1 = Ft(Math.Max(zz[0].Value<double>(), zz[1].Value<double>())); }
            else if (spec["level"] != null)
            {
                var lv = LevelsOf(ctx.Host, spec["level"]).Select(id => ctx.Host.GetElement(id) as Level).FirstOrDefault(x => x != null)
                    ?? throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"in_boundary: no level \"{spec["level"]}\" in {ctx.Host.Title}");
                z0 = lv.Elevation; z1 = NextLevel(ctx.Host, lv.Elevation);
            }
            var bnd = Polygon.Bounds(pts);
            l.Label = $"in_boundary:{pts.Count} points ({mode})";
            l.Prefilter = ToDoc(ctx, new XYZ(bnd.MinX - Pad, bnd.MinY - Pad, z0 <= -1e5 ? -1e6 : z0 - Pad), new XYZ(bnd.MaxX + Pad, bnd.MaxY + Pad, z1 >= 1e5 ? 1e6 : z1 + Pad));
            ElementFilter solidFilter = null;
            l.Test = e =>
            {
                if (mode == "solid")
                {
                    if (solidFilter == null)
                    {
                        double lo = z0 <= -1e5 ? -1000 : z0, hi = z1 >= 1e5 ? 1000 : z1;
                        var loop = new CurveLoop();
                        for (int i = 0; i < pts.Count; i++)
                        {
                            var a = pts[i]; var b = pts[(i + 1) % pts.Count];
                            loop.Append(Line.CreateBound(new XYZ(a.Item1, a.Item2, lo), new XYZ(b.Item1, b.Item2, lo)));
                        }
                        Solid s = GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop> { loop }, XYZ.BasisZ, hi - lo);
                        if (ctx.IsLink) s = SolidUtils.CreateTransformed(s, ctx.T.Inverse);
                        solidFilter = new ElementIntersectsSolidFilter(s);
                    }
                    return Tri.Of(solidFilter.PassesFilter(e));
                }
                var hp = mode == "any_point" ? HostPoints(ctx, e) : new List<XYZ> { HostCentre(ctx, e) };
                if (hp.Count == 0 || hp[0] == null) return Tri.Unknown("NO_LOCATION", "in_boundary needs a point or a box");
                return Tri.Of(hp.Any(p => p.Z >= z0 - 1e-6 && p.Z <= z1 + 1e-6 && Polygon.Contains(pts, p.X, p.Y)));
            };
        }

        // ---- names --------------------------------------------------------------------------------------------------

        private static readonly Dictionary<string, BuiltInCategory> RoleWords = new Dictionary<string, BuiltInCategory>(StringComparer.OrdinalIgnoreCase)
        {
            ["door"] = BuiltInCategory.OST_Doors, ["window"] = BuiltInCategory.OST_Windows, ["wall"] = BuiltInCategory.OST_Walls,
            ["room"] = BuiltInCategory.OST_Rooms, ["floor"] = BuiltInCategory.OST_Floors, ["ceiling"] = BuiltInCategory.OST_Ceilings,
            ["roof"] = BuiltInCategory.OST_Roofs, ["column"] = BuiltInCategory.OST_Columns, ["pipe"] = BuiltInCategory.OST_PipeCurves,
            ["duct"] = BuiltInCategory.OST_DuctCurves, ["stair"] = BuiltInCategory.OST_Stairs, ["furniture"] = BuiltInCategory.OST_Furniture,
            ["space"] = BuiltInCategory.OST_MEPSpaces, ["beam"] = BuiltInCategory.OST_StructuralFraming,
        };

        /// <summary>Category names: OST_ names, short names, display names, Formcraft role words. Unknown is refused with candidates.</summary>
        public static List<BuiltInCategory> Categories(Document doc, JToken c)
        {
            var list = new List<BuiltInCategory>();
            foreach (string raw in c is JArray a ? a.Select(x => x.ToString()) : new[] { c.ToString() })
            {
                string n = raw.Trim();
                if (n.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) && Enum.TryParse(n, true, out BuiltInCategory b) && b != BuiltInCategory.INVALID) { list.Add(b); continue; }
                if (RoleWords.TryGetValue(n, out b) || RoleWords.TryGetValue(n.TrimEnd('s'), out b)) { list.Add(b); continue; }
                if (Enum.TryParse("OST_" + n.Replace(" ", ""), true, out b) && b != BuiltInCategory.INVALID) { list.Add(b); continue; }
                Category byName = doc.Settings.Categories.Cast<Category>().FirstOrDefault(x => Same(x.Name, n));
                if (byName != null && byName.BuiltInCategory != BuiltInCategory.INVALID) { list.Add(byName.BuiltInCategory); continue; }
                var near = doc.Settings.Categories.Cast<Category>().Select(x => x.Name).Where(x => x.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0 || n.IndexOf(x, StringComparison.OrdinalIgnoreCase) >= 0).Take(5);
                throw new FilterException("FMC-FILTER-UNKNOWN-CATEGORY", $"no category \"{n}\"", "use one of the candidates, or an OST_ name", new JArray(near));
            }
            return list.Distinct().ToList();
        }

        private static readonly string[] ClassSpaces =
        {
            "Autodesk.Revit.DB.", "Autodesk.Revit.DB.Architecture.", "Autodesk.Revit.DB.Mechanical.", "Autodesk.Revit.DB.Plumbing.",
            "Autodesk.Revit.DB.Electrical.", "Autodesk.Revit.DB.Structure.",
        };

        public static Type ClassOf(string name)
        {
            var asm = typeof(Element).Assembly;
            foreach (string ns in ClassSpaces)
            {
                Type t = asm.GetType(ns + name, false, true);
                if (t != null && typeof(Element).IsAssignableFrom(t)) return t;
            }
            throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"no Revit class \"{name}\"", "use a Revit class name: Wall, Floor, FamilyInstance, Pipe, Duct, Room...");
        }

        public static List<ElementId> LevelsOf(Document doc, JToken t)
        {
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).ToList();
            var names = t is JArray a ? a.Select(x => x.ToString()).ToList() : new List<string> { t?.ToString() ?? "" };
            return levels.Where(x => names.Any(n => Same(x.Name, n) || (long.TryParse(n, out long id) && x.Id.Value == id))).Select(x => x.Id).ToList();
        }

        public static ElementId IdOf(Document doc, JToken t)
        {
            if (t == null) return ElementId.InvalidElementId;
            if (t.Type == JTokenType.Integer) return new ElementId(t.Value<long>());
            string s = t.ToString();
            if (long.TryParse(s, out long n)) return new ElementId(n);
            return doc.GetElement(s)?.Id ?? ElementId.InvalidElementId;   // a UniqueId
        }

        public static View ViewOf(FilterCtx ctx, string v)
        {
            if (Same(v, "active"))
            {
                if (ctx.Ui == null && ctx.Active != null) return ctx.Active;
                if (ctx.Ui == null) throw new FilterException("FMC-FILTER-UI-NEEDS-ACTIVE", $"view \"active\" needs {ctx.Host.Title} to be the active document", "name the view, or ask the person to activate the model");
                return ctx.Ui.ActiveView;
            }
            View view = long.TryParse(v, out long n) ? ctx.Host.GetElement(new ElementId(n)) as View : null;
            view = view ?? new FilteredElementCollector(ctx.Host).OfClass(typeof(View)).Cast<View>().FirstOrDefault(x => !x.IsTemplate && Same(x.Name, v));
            return view ?? throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"no view \"{v}\" in {ctx.Host.Title}", "give the view name or id, or \"active\"");
        }

        /// <summary>Elements visible in a host view: the host's own, or a link's through the view (Revit 2024+).</summary>
        public static FilteredElementCollector ViewCollector(FilterCtx ctx, View v) =>
            ctx.IsLink ? new FilteredElementCollector(ctx.Host, v.Id, ctx.Link.Id) : new FilteredElementCollector(ctx.Doc, v.Id);

        private static HashSet<long> TaggedIn(FilterCtx ctx, View v)
        {
            var set = new HashSet<long>();
            foreach (Element t in new FilteredElementCollector(ctx.Host, v.Id).WhereElementIsNotElementType())
            {
                try
                {
                    if (t is IndependentTag it)
                    {
                        foreach (LinkElementId le in it.GetTaggedElementIds())
                        {
                            if (ctx.IsLink) { if (le.LinkInstanceId == ctx.Link.Id) set.Add(le.LinkedElementId.Value); }
                            else if (le.HostElementId != ElementId.InvalidElementId) set.Add(le.HostElementId.Value);
                        }
                    }
                    else if (t is SpatialElementTag st)
                    {
                        LinkElementId le = st is RoomTag rt ? rt.TaggedRoomId : st is Autodesk.Revit.DB.Mechanical.SpaceTag sp ? new LinkElementId(sp.Space?.Id ?? ElementId.InvalidElementId) : null;
                        if (le == null) continue;
                        if (ctx.IsLink) { if (le.LinkInstanceId == ctx.Link.Id) set.Add(le.LinkedElementId.Value); }
                        else if (le.HostElementId != ElementId.InvalidElementId) set.Add(le.HostElementId.Value);
                    }
                }
                catch (Exception) { /* a tag Revit can't read: its host stays untagged, which is the safe side for "find untagged" */ }
            }
            return set;
        }
    }
}
