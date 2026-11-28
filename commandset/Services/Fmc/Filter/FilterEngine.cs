using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.Filter
{
    /// <summary>
    /// The select_by filter engine (build plan item 32, FILTER_TOOL_SPEC.md; Emlyn 28 Nov: select_by upgraded in place
    /// to line up with the hub's revit_select_by, ai_element_filter retires). Read-only: no transaction anywhere.
    /// Actions: preview (counts), run (counts + first page), page (cursor), explain (the compiled plan), rows (export
    /// chunks), doc (the target document). Every element looked at ends up matched, not matched, undetermined or skipped.
    /// </summary>
    public static class FilterEngine
    {
        public static readonly SnapshotCache Cache = new SnapshotCache();

        private sealed class Group
        {
            public int Index;
            public int DocIndex;
            public Document Host;
            public Document Doc;
            public RevitLinkInstance Link;
            public string Kind = "instances";
            public JObject Tag;      // {doc, doc_path, link}
        }

        private sealed class Scan
        {
            public Snapshot Snap = new Snapshot();
            public List<Group> Groups = new List<Group>();
            public Dictionary<string, int> ByCategory = new Dictionary<string, int>();
            public Dictionary<string, int> SkippedBy = new Dictionary<string, int>();
            public Dictionary<string, int> UndeterminedBy = new Dictionary<string, int>();
            public int Total;            // matches (may pass the snapshot cap)
            public bool Exact = true;
            public bool OverCap;
            public JArray Warnings = new JArray();
            public JArray Sample = new JArray();
            public JObject Plan;
            public List<CompiledLeaf> ParamLeaves = new List<CompiledLeaf>();
        }

        public static JObject Run(UIApplication app, JObject p)
        {
            FilterVersions.Hook(app.Application);
            RevitMCPCommandSet.Bridge.FmcAiJob.Enter(app, RevitMCPCommandSet.Bridge.FmcAiJob.JobOf(p));
            var sw = Stopwatch.StartNew();
            string action = p.Value<string>("action") ?? "preview";
            JObject result;
            try
            {
                switch (action)
                {
                    case "preview": result = Preview(app, p, withPage: false); break;
                    case "run": result = Preview(app, p, withPage: true); break;
                    case "page": result = Page(app, p); break;
                    case "explain": result = Explain(app, p); break;
                    case "rows": result = Rows(app, p); break;
                    case "doc": result = DocInfo(app, p); break;
                    default: throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"unknown action \"{action}\" for the add-in", "preview, run, page, explain, rows or doc");
                }
            }
            catch (FilterException fx) { result = fx.ToJson(); }
            result["action"] = action;
            result["elapsed_ms"] = sw.ElapsedMilliseconds;
            return result;
        }

        // ---- the query --------------------------------------------------------------------------------------------

        private static (JObject query, Node root, Node universe) Query(JObject p)
        {
            JToken criteria = p["criteria"];
            if (criteria == null)
            {
                JObject flat = Criteria.FromFlat(p);
                if (flat != null) criteria = flat;
            }
            if (criteria == null) throw new FilterException("FMC-FILTER-BAD-CRITERIA", "no criteria (give criteria, a set, history_id or result_set)", "add a criteria tree, e.g. {\"category\":\"OST_Walls\"}");
            Criteria.Validate(criteria);
            JObject scope = p["scope"] as JObject ?? new JObject();
            bool invert = p.Value<bool?>("invert") == true;
            string missing = p.Value<string>("missing") ?? "report";
            if (missing != "report" && missing != "no_match" && missing != "match") throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"missing must be report, no_match or match, not {missing}");
            string kind = scope.Value<string>("kind") ?? (p.Value<bool?>("types") == true ? "types" : "instances");
            Node root = Criteria.Normalize(criteria);
            Node universe = null;
            if (scope["universe"] is JObject u) { Criteria.Validate(u); universe = Criteria.Normalize(u); }
            if (invert && universe == null)
            {
                var cats = Criteria.TopCategories(root);
                if (cats.Count == 0) throw new FilterException("FMC-FILTER-TOO-BROAD", "invert needs a universe (scope.universe) or a category leaf, or \"everything that is not\" is most of the model", "add scope.universe, e.g. {\"category\":\"OST_Rooms\",\"level\":\"Level 1\"}");
                universe = Criteria.Normalize(new JObject { ["all"] = new JArray(cats.Select(c => new JObject { ["category"] = c })) });
            }
            // a negated whole tree with no universe is the same trap as invert without one
            if (!invert && universe == null && !Criteria.IsNarrowed(root) && root.Kind == Node.NodeKind.Leaf && root.Negate)
                throw new FilterException("FMC-FILTER-TOO-BROAD", $"\"{root}\" alone is most of the model", "add a category (all: [category, not ...]) or use invert with scope.universe");
            var q = Hashes.QueryOf(criteria, scope, invert, missing, kind);
            return (q, root, universe);
        }

        private static List<Document> Documents(UIApplication app, JObject p, out Document target, JArray skipped)
        {
            JObject scope = p["scope"] as JObject ?? new JObject();
            JToken want = scope["documents"] ?? "target";
            bool families = scope.Value<bool?>("family_documents") == true;
            var open = new List<Document>();
            foreach (Document d in app.Application.Documents) if (!d.IsLinked) open.Add(d);
            target = null;
            if (want.Type == JTokenType.String && want.ToString() == "target")
            {
                using (FmcTarget t = FmcTarget.Resolve(app, p, mayOpen: false)) target = t.Doc;
                return new List<Document> { target };
            }
            List<Document> docs;
            if (want.Type == JTokenType.String && want.ToString() == "all_open") docs = open;
            else
            {
                docs = new List<Document>();
                foreach (string key in (want as JArray ?? new JArray(want)).Select(x => x.ToString()))
                {
                    var hit = open.Where(d => string.Equals(d.Title, key, StringComparison.OrdinalIgnoreCase) || string.Equals(d.PathName, key, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(System.IO.Path.GetFileNameWithoutExtension(d.PathName ?? ""), key, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (hit.Count == 0) throw new FilterException("FMC-DOC-NOT-FOUND", $"no open document \"{key}\"", "pass the title or full path of an open model", new JArray(open.Select(d => d.Title)));
                    if (hit.Count > 1) throw new FilterException("FMC-DOC-AMBIGUOUS", $"\"{key}\" matches {hit.Count} open documents", "pass the full path", new JArray(hit.Select(d => d.PathName)));
                    if (!docs.Contains(hit[0])) docs.Add(hit[0]);
                }
            }
            var kept = new List<Document>();
            foreach (Document d in docs)
            {
                if (d.IsFamilyDocument && !families) { skipped.Add(new JObject { ["doc"] = d.Title, ["reason"] = "DOC_SKIPPED", ["detail"] = "a family document (scope.family_documents is false)" }); continue; }
                if (kept.Count >= FilterLimits.DocsMax) { skipped.Add(new JObject { ["doc"] = d.Title, ["reason"] = "DOC_SKIPPED", ["detail"] = $"over {FilterLimits.DocsMax} documents" }); continue; }
                kept.Add(d);
            }
            target = kept.FirstOrDefault();
            return kept;
        }

        private static UIDocument UiFor(UIApplication app, Document d) =>
            app.ActiveUIDocument != null && app.ActiveUIDocument.Document.Equals(d) ? app.ActiveUIDocument : null;

        private static Scan Execute(UIApplication app, JObject p, JObject query, Node root, Node universe, int? limitOverride = null)
        {
            var scan = new Scan();
            var sw = Stopwatch.StartNew();
            JObject scope = query["scope"] as JObject ?? new JObject();
            string linksMode = scope.Value<string>("links") ?? "host";
            if (linksMode != "host" && linksMode != "links" && linksMode != "both") throw new FilterException("FMC-FILTER-BAD-CRITERIA", $"scope.links must be host, links or both, not {linksMode}");
            var linkNames = (scope["link_names"] as JArray)?.Select(x => x.ToString()).ToList();
            string kind = query.Value<string>("kind");
            bool includeViewSpecific = scope.Value<bool?>("include_view_specific") == true;
            bool dedupe = scope.Value<string>("dedupe") == "by_unique_id";
            if (scope.Value<bool?>("nested_links") == true) scan.Warnings.Add("nested_links: only the first level of links is read in this build");
            bool invert = query.Value<bool>("invert");
            string missing = query.Value<string>("missing");
            int scanCap = FilterLimits.ScanCap(p.Value<int?>("scan_cap"));
            int snapMax = limitOverride ?? FilterLimits.SnapshotMax;
            var seenUnique = new HashSet<string>();

            var docs = Documents(app, p, out Document target, scan.Snap.Skipped);
            var kinds = kind == "both" ? new[] { "instances", "types" } : new[] { kind };
            for (int di = 0; di < docs.Count; di++)
            {
                Document d = docs[di];
                scan.Snap.Docs.Add(new JObject { ["index"] = di, ["title"] = d.Title, ["path"] = d.PathName ?? "", ["key"] = FilterVersions.Key(d) });
                scan.Snap.DocKeys.Add(FilterVersions.Key(d));
                scan.Snap.DocVersions[FilterVersions.Key(d)] = FilterVersions.Version(d);
                var tagHost = new JObject { ["doc"] = d.Title, ["doc_path"] = d.PathName ?? "", ["link"] = null };
                if (linksMode != "links")
                    foreach (string k in kinds) scan.Groups.Add(new Group { Index = scan.Groups.Count, DocIndex = di, Host = d, Doc = d, Kind = k, Tag = tagHost });
                if (linksMode == "host") continue;
                int n = 0;
                foreach (RevitLinkInstance inst in new FilteredElementCollector(d).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>().OrderBy(i => i.Id.Value))
                {
                    Document ld = inst.GetLinkDocument();
                    if (ld == null)
                    {
                        scan.Snap.Skipped.Add(new JObject { ["doc"] = d.Title, ["reason"] = "LINK_NOT_LOADED", ["link"] = new JObject { ["instance_id"] = inst.Id.Value, ["name"] = inst.Name } });
                        Count(scan.SkippedBy, "LINK_NOT_LOADED");
                        continue;
                    }
                    if (linkNames != null && !linkNames.Any(ln => ld.Title.IndexOf(ln, StringComparison.OrdinalIgnoreCase) >= 0 || inst.Name.IndexOf(ln, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                    if (++n > FilterLimits.LinksPerDoc)
                    {
                        scan.Snap.Skipped.Add(new JObject { ["doc"] = d.Title, ["reason"] = "DOC_SKIPPED", ["detail"] = $"over {FilterLimits.LinksPerDoc} link instances", ["link"] = new JObject { ["instance_id"] = inst.Id.Value, ["name"] = inst.Name } });
                        Count(scan.SkippedBy, "DOC_SKIPPED");
                        continue;
                    }
                    string lk = "link:" + inst.Id.Value + ":" + FilterVersions.Key(d);
                    scan.Snap.DocVersions[lk] = FilterVersions.Version(ld);
                    var tag = new JObject { ["doc"] = d.Title, ["doc_path"] = d.PathName ?? "", ["link"] = new JObject { ["instance_id"] = inst.Id.Value, ["name"] = inst.Name, ["doc"] = ld.Title, ["doc_path"] = ld.PathName ?? "" } };
                    foreach (string k in kinds) scan.Groups.Add(new Group { Index = scan.Groups.Count, DocIndex = di, Host = d, Doc = ld, Link = inst, Kind = k, Tag = tag });
                }
            }
            foreach (Group g in scan.Groups)
                scan.Snap.Links.Add(new JObject { ["group"] = g.Index, ["doc_index"] = g.DocIndex, ["kind"] = g.Kind, ["link_id"] = g.Link?.Id.Value ?? 0, ["tag"] = g.Tag });

            foreach (Group g in scan.Groups)
            {
                var ctx = new FilterCtx { Doc = g.Doc, Host = g.Host, Link = g.Link, T = g.Link?.GetTotalTransform() ?? Transform.Identity, Ui = UiFor(app, g.Host), Missing = missing, Warnings = scan.Warnings };
                Plan plan = FilterCompiler.Compile(ctx, root);
                Plan uplan = universe != null ? FilterCompiler.Compile(ctx, universe) : null;
                scan.ParamLeaves.AddRange(plan.Leaves.Values.Where(l => l.IsParam));
                if (scan.Plan == null) scan.Plan = plan.Explain();
                Plan source = invert ? uplan : plan;
                FilteredElementCollector col = Collector(ctx, source, g.Kind);
                if (col == null) continue;
                bool narrowed = Criteria.IsNarrowed(source.Root) || source.InView != null;
                if (!narrowed)
                {
                    int count = col.GetElementCount();
                    if (count > scanCap) throw new FilterException("FMC-FILTER-TOO-BROAD", $"an unscoped scan of {count} elements in {g.Doc.Title} (over filter.scan_cap {scanCap})", "add a category, class, ids, view or a spatial leaf");
                }
                bool namesCats = source.NamesCategories;
                long looked = 0;
                foreach (ElementId id in col.ToElementIds())
                {
                    // a Revit event can't be cancelled: the clock is checked between batches of 1000 ids and the scan stops cleanly
                    if ((++looked % FilterLimits.BatchIds) == 0 && sw.ElapsedMilliseconds > FilterLimits.WorkMs) { scan.Exact = false; break; }
                    Element e = g.Doc.GetElement(id);
                    if (e == null || e.Category == null && g.Kind == "instances" && !(e is ElementType)) continue;   // outside the universe: not an element a person sees
                    if (g.Kind == "instances" && !namesCats && !(e.Category.CategoryType == CategoryType.Model || e is SpatialElement || (e.ViewSpecific && (includeViewSpecific || source.InView != null)))) continue;
                    Tri t;
                    try
                    {
                        if (invert)
                        {
                            Tri u = uplan.Eval(e);
                            if (u.IsFalse) continue;
                            Tri m = plan.Eval(e);
                            t = u.IsUnknown ? u : m.IsUnknown ? m : Tri.Of(m.IsFalse);
                        }
                        else t = plan.Eval(e);
                    }
                    catch (FilterException) { throw; }
                    catch (Exception x) { t = Tri.Unknown("INFO_FAILED", $"{x.GetType().Name}: {x.Message}"); }
                    if (t.IsFalse) continue;
                    if (t.IsUnknown)
                    {
                        var row = new JObject { ["id"] = id.Value, ["doc"] = g.Host.Title, ["link"] = g.Tag["link"], ["category"] = e.Category?.Name, ["reason"] = t.Reason };
                        if (Tri.IsUndeterminedReason(t.Reason)) { row["param"] = t.Detail; scan.Snap.Undetermined.Add(row); Count(scan.UndeterminedBy, t.Reason); }
                        else { row["detail"] = t.Detail; scan.Snap.Skipped.Add(row); Count(scan.SkippedBy, t.Reason); }
                        continue;
                    }
                    if (g.Kind == "instances" && e.ViewSpecific && !includeViewSpecific && source.InView == null)
                    {
                        scan.Snap.Skipped.Add(new JObject { ["id"] = id.Value, ["doc"] = g.Host.Title, ["link"] = g.Tag["link"], ["category"] = e.Category?.Name, ["reason"] = "VIEW_SPECIFIC_EXCLUDED" });
                        Count(scan.SkippedBy, "VIEW_SPECIFIC_EXCLUDED");
                        continue;
                    }
                    if (dedupe && !seenUnique.Add(e.UniqueId)) continue;
                    scan.Total++;
                    Count(scan.ByCategory, e.Category?.Name ?? (e is ElementType ? "(types)" : "(none)"));
                    if (scan.Snap.Entries.Count < snapMax) scan.Snap.Entries.Add(new SnapEntry(g.Index, g.Link?.Id.Value ?? 0, id.Value));
                    else scan.OverCap = true;
                    if (scan.Sample.Count < 10) scan.Sample.Add(new JObject { ["id"] = id.Value, ["name"] = e.Name, ["category"] = e.Category?.Name, ["doc"] = g.Host.Title, ["link"] = g.Tag["link"]?.Type == JTokenType.Object ? g.Tag["link"]["name"] : null });
                }
                if (!scan.Exact) break;
            }
            scan.Snap.Entries.Sort();
            // a parameter no element in scope has: said once, with every element it left undetermined listed
            foreach (var g in scan.ParamLeaves.GroupBy(l => l.ParamName).Where(g => g.Sum(l => l.Tested) > 0 && g.Sum(l => l.Found) == 0))
                scan.Warnings.Add($"FMC-FILTER-UNKNOWN-PARAM: no element tested has a parameter \"{g.Key}\"; they are listed as undetermined (check the spelling, use bip, or read the params of a sample row)");
            return scan;
        }

        private static FilteredElementCollector Collector(FilterCtx ctx, Plan plan, string kind)
        {
            FilteredElementCollector col;
            if (plan.Start != null)
            {
                var ids = plan.Start.Where(x => ctx.Doc.GetElement(x) != null).ToList();
                if (ids.Count == 0) return null;
                col = new FilteredElementCollector(ctx.Doc, ids);
            }
            else if (plan.InView != null) col = FilterCompiler.ViewCollector(ctx, plan.InView);
            else col = new FilteredElementCollector(ctx.Doc);
            col = kind == "types" ? col.WhereElementIsElementType() : col.WhereElementIsNotElementType();
            foreach (ElementFilter f in plan.Collector) col = col.WherePasses(f);
            if (plan.Prefilter != null && kind != "types") col = col.WherePasses(new BoundingBoxIntersectsFilter(plan.Prefilter));
            return col;
        }

        private static void Count(Dictionary<string, int> d, string k) => d[k] = (d.TryGetValue(k, out int n) ? n : 0) + 1;

        // ---- actions --------------------------------------------------------------------------------------------------

        private static JObject Preview(UIApplication app, JObject p, bool withPage)
        {
            if (p["result_set"] != null && p["criteria"] == null)
            {
                Snapshot s = Cache.Get(p.Value<string>("result_set")) ?? throw new FilterException("FMC-FILTER-CURSOR-EXPIRED", $"result set {p["result_set"]} is gone (15 minutes idle, or more than 8 kept)", "run the query again");
                return withPage ? PageOf(app, p, s, 0, false) : Counts(s, null);
            }
            var (query, root, universe) = Query(p);
            Scan scan = Execute(app, p, query, root, universe);
            Snapshot snap = scan.Snap;
            snap.Id = SnapshotCache.NewId();
            snap.Query = query;
            snap.QueryHash = Hashes.Query(query);
            snap.Created = DateTime.UtcNow;
            var counts = Summary(scan);
            if (scan.OverCap)
            {
                if (withPage) throw new FilterException("FMC-FILTER-TOO-BROAD", $"{scan.Total} matches, over the snapshot cap {FilterLimits.SnapshotMax}", "narrow it: add a category, level or view", counts);
                counts["result_set"] = null;
                counts["ok"] = true;
                ((JArray)counts["warnings"]).Add($"FMC-FILTER-TOO-BROAD: {scan.Total} matches is over the snapshot cap {FilterLimits.SnapshotMax}: counts only, no result set");
                return counts;
            }
            if (!scan.Exact) ((JArray)counts["warnings"]).Add("FMC-FILTER-PARTIAL: the 90 s work cap hit; counts are counted_so_far");
            Cache.Put(snap);
            counts["result_set"] = snap.Id;
            if (!withPage)
            {
                counts["next"] = $"run with result_set {snap.Id} (no re-scan), or narrow the criteria";
                return counts;
            }
            JObject page = PageOf(app, p, snap, 0, false);
            foreach (var prop in counts.Properties()) if (page[prop.Name] == null) page[prop.Name] = prop.Value;
            return page;
        }

        private static JObject Summary(Scan scan)
        {
            Snapshot s = scan.Snap;
            var o = new JObject
            {
                ["ok"] = true,
                ["query_hash"] = s.QueryHash,
                ["total"] = scan.Total,
                ["exact"] = scan.Exact,
                ["by_doc"] = new JArray(scan.Groups.Select(g => new JObject { ["doc"] = g.Host.Title, ["link"] = g.Tag["link"], ["kind"] = g.Kind, ["count"] = s.Entries.Count(x => x.D == g.Index) }).Where(x => x.Value<int>("count") > 0 || x["link"].Type == JTokenType.Null)),
                ["by_category"] = new JObject(scan.ByCategory.OrderByDescending(k => k.Value).Select(k => new JProperty(k.Key, k.Value))),
                ["undetermined"] = s.Undetermined.Count,
                ["undetermined_by_reason"] = new JObject(scan.UndeterminedBy.Select(k => new JProperty(k.Key, k.Value))),
                ["skipped"] = s.Skipped.Count,
                ["skipped_by_reason"] = new JObject(s.Skipped.GroupBy(x => x.Value<string>("reason")).Select(g => new JProperty(g.Key, g.Count()))),
                ["sample"] = scan.Sample,
                ["estimated_page_bytes"] = Math.Min(scan.Total, FilterLimits.PageDefault) * 420,
                ["plan"] = scan.Plan,
                ["docs"] = s.Docs,
                ["doc_versions"] = new JObject(s.DocVersions.Select(k => new JProperty(k.Key, k.Value))),
                ["warnings"] = new JArray(scan.Warnings),
            };
            if (!scan.Exact) o["counted_so_far"] = scan.Total;
            return o;
        }

        private static JObject Counts(Snapshot s, JArray warnings) => new JObject
        {
            ["ok"] = true, ["result_set"] = s.Id, ["query_hash"] = s.QueryHash, ["total"] = s.Entries.Count, ["exact"] = true,
            ["undetermined"] = s.Undetermined.Count, ["skipped"] = s.Skipped.Count,
            ["skipped_by_reason"] = new JObject(s.Skipped.GroupBy(x => x.Value<string>("reason")).Select(g => new JProperty(g.Key, g.Count()))),
            ["docs"] = s.Docs, ["doc_versions"] = new JObject(s.DocVersions.Select(k => new JProperty(k.Key, k.Value))),
            ["warnings"] = warnings ?? new JArray(), ["from_snapshot"] = true,
        };

        private static Dictionary<string, string> VersionsNow(UIApplication app, Snapshot s) => VersionsNow(app.Application, s);

        private static Dictionary<string, string> VersionsNow(Autodesk.Revit.ApplicationServices.Application app, Snapshot s)
        {
            var now = new Dictionary<string, string>();
            var open = new Dictionary<string, Document>(StringComparer.OrdinalIgnoreCase);
            foreach (Document d in app.Documents) if (!d.IsLinked) open[FilterVersions.Key(d)] = d;
            foreach (string k in s.DocVersions.Keys)
            {
                if (k.StartsWith("link:", StringComparison.Ordinal))
                {
                    var parts = k.Split(new[] { ':' }, 3);
                    if (open.TryGetValue(parts[2], out Document host) && host.GetElement(new ElementId(long.Parse(parts[1]))) is RevitLinkInstance li && li.GetLinkDocument() is Document ld)
                        now[k] = FilterVersions.Version(ld);
                }
                else if (open.TryGetValue(k, out Document d)) now[k] = FilterVersions.Version(d);
            }
            return now;
        }

        private static JObject Page(UIApplication app, JObject p)
        {
            Cursor c = Cursor.Decode(p.Value<string>("cursor"));
            Snapshot s = Cache.Get(c.Rs);
            bool resumed = false;
            if (p["criteria"] != null || p.Properties().Any(x => Criteria.FlatKeys.Contains(x.Name)))
            {
                var (q, _, _) = Query(p);
                if (Hashes.Query(q) != c.H) throw new FilterException("FMC-FILTER-CURSOR-INVALID", "the cursor belongs to another query (the criteria hash differs)", "follow the cursor without new criteria, or start with run");
            }
            if (s != null && s.QueryHash != c.H) throw new FilterException("FMC-FILTER-CURSOR-INVALID", "the cursor's query hash does not match its result set", "pass the cursor unchanged, or start with run");
            if (s == null)
            {
                // spec 5.6: the snapshot expired; with the query sent again (the server keeps it in history), re-run and go on after the last id
                if (p["criteria"] == null) throw new FilterException("FMC-FILTER-CURSOR-EXPIRED", $"result set {c.Rs} expired (15 minutes idle, or more than 8 kept)", "pass the same cursor again with the query (the server does this), or run again", new JObject { ["query_hash"] = c.H });
                var (query, root, universe) = Query(p);
                Scan scan = Execute(app, p, query, root, universe);
                if (scan.OverCap) throw new FilterException("FMC-FILTER-TOO-BROAD", $"{scan.Total} matches, over the snapshot cap", "narrow it");
                s = scan.Snap; s.Id = SnapshotCache.NewId(); s.Query = query; s.QueryHash = Hashes.Query(query); s.Created = DateTime.UtcNow;
                Cache.Put(s);
                resumed = true;
            }
            int from = s.After(c.D, c.L, c.A);
            return PageOf(app, p, s, from, resumed);
        }

        private static JObject PageOf(UIApplication app, JObject p, Snapshot s, int from, bool resumed)
        {
            int size = FilterLimits.PageSize(p.Value<int?>("page_size"));
            string onChange = p.Value<string>("on_change") ?? "fail";
            var now = VersionsNow(app, s);
            var changed = Hashes.Changed(s.DocVersions, now);
            var warnings = new JArray();
            if (changed.Count > 0 && !resumed)
            {
                if (onChange != "continue")
                    throw new FilterException("FMC-FILTER-STALE", $"the model changed since result set {s.Id} was taken", "run again (a new result set), or page with on_change \"continue\"",
                        new JObject { ["changed_docs"] = new JArray(changed), ["created_at"] = s.Created.ToString("o") });
                warnings.Add("the model changed since this result set: rows are read live, deleted ids are ELEMENT_DELETED, new elements are not added");
            }
            var slice = s.Entries.Skip(from).Take(size).ToList();
            var built = BuildRows(app, s, slice, p, warnings);
            var rows = built.rows;
            var (truncated, dropped) = ByteCap.Apply(rows);
            if (dropped.Count > 0) warnings.Add($"page over 256 KB: params dropped from the end of the page: {string.Join(", ", dropped)}");
            int index = (from / size) + 1;
            bool last = from + slice.Count >= s.Entries.Count;
            string cursor = last || slice.Count == 0 ? null : new Cursor { Rs = s.Id, D = slice[slice.Count - 1].D, L = slice[slice.Count - 1].L, A = slice[slice.Count - 1].Id, V = Hashes.Versions(s.DocVersions), H = s.QueryHash }.Encode();
            // undetermined and skipped rows page alongside (50 per page), so every one of them is seen once
            int r0 = (index - 1) * FilterLimits.ReasonRowsPerPage;
            var und = new JArray(s.Undetermined.Skip(r0).Take(FilterLimits.ReasonRowsPerPage));
            var skp = new JArray(s.Skipped.Skip(r0).Take(FilterLimits.ReasonRowsPerPage));
            foreach (var x in built.skipped) skp.Add(x);
            bool reasonsLeft = s.Undetermined.Count > r0 + FilterLimits.ReasonRowsPerPage || s.Skipped.Count > r0 + FilterLimits.ReasonRowsPerPage;
            if (last && reasonsLeft) warnings.Add($"more undetermined/skipped rows than fit on the pages ({s.Undetermined.Count} / {s.Skipped.Count}): export the result set to see them all");
            return new JObject
            {
                ["ok"] = true, ["result_set"] = s.Id, ["query_hash"] = s.QueryHash, ["total"] = s.Entries.Count,
                ["page"] = new JObject { ["index"] = index, ["size"] = size, ["from"] = slice.Count == 0 ? 0 : from + 1, ["to"] = from + slice.Count },
                ["cursor"] = cursor, ["complete"] = cursor == null, ["resumed"] = resumed,
                ["elements"] = rows,
                ["undetermined"] = und, ["undetermined_total"] = s.Undetermined.Count,
                ["skipped"] = skp, ["skipped_total"] = s.Skipped.Count + built.skipped.Count,
                ["truncated"] = truncated,
                ["key_params_source"] = built.keySource,
                ["doc_versions"] = new JObject(now.Select(k => new JProperty(k.Key, k.Value))),
                ["warnings"] = warnings,
            };
        }

        /// <summary>Export chunks (spec 8): up to 500 rows from an offset, every parameter when params is "all".</summary>
        private static JObject Rows(UIApplication app, JObject p)
        {
            Snapshot s = Cache.Get(p.Value<string>("result_set") ?? "") ?? throw new FilterException("FMC-FILTER-CURSOR-EXPIRED", $"result set {p["result_set"]} is gone", "run again, then export the new result set");
            int from = Math.Max(0, p.Value<int?>("from") ?? 0);
            int count = FilterLimits.Clamp(p.Value<int?>("count") ?? 500, 1, 500);
            var warnings = new JArray();
            var now = VersionsNow(app, s);
            var changed = Hashes.Changed(s.DocVersions, now);
            if (changed.Count > 0 && (p.Value<string>("on_change") ?? "fail") != "continue")
                throw new FilterException("FMC-FILTER-STALE", $"the model changed since result set {s.Id} was taken", "run again, or export with on_change \"continue\"", new JObject { ["changed_docs"] = new JArray(changed) });
            var slice = s.Entries.Skip(from).Take(count).ToList();
            var built = BuildRows(app, s, slice, p, warnings);
            var o = new JObject
            {
                ["ok"] = true, ["result_set"] = s.Id, ["query_hash"] = s.QueryHash, ["total"] = s.Entries.Count, ["from"] = from, ["count"] = slice.Count,
                ["elements"] = built.rows, ["skipped"] = new JArray(built.skipped), ["warnings"] = warnings, ["done"] = from + slice.Count >= s.Entries.Count,
            };
            if (from == 0)
            {
                o["meta"] = new JObject { ["query"] = s.Query, ["docs"] = s.Docs, ["doc_versions"] = new JObject(s.DocVersions.Select(k => new JProperty(k.Key, k.Value))) };
                o["all_undetermined"] = s.Undetermined;
                o["all_skipped"] = s.Skipped;
            }
            return o;
        }

        private static JObject Explain(UIApplication app, JObject p)
        {
            var (query, root, universe) = Query(p);
            using (FmcTarget t = FmcTarget.Resolve(app, p, mayOpen: false))
            {
                var ctx = new FilterCtx { Doc = t.Doc, Host = t.Doc, Ui = t.Ui, Missing = query.Value<string>("missing") };
                Plan plan = FilterCompiler.Compile(ctx, root);
                var o = new JObject { ["ok"] = true, ["query_hash"] = Hashes.Query(query), ["plan"] = plan.Explain(), ["narrowed"] = Criteria.IsNarrowed(root), ["warnings"] = ctx.Warnings };
                if (universe != null) o["universe_plan"] = FilterCompiler.Compile(ctx, universe).Explain();
                return o;
            }
        }

        private static JObject DocInfo(UIApplication app, JObject p)
        {
            using (FmcTarget t = FmcTarget.Resolve(app, p, mayOpen: false))
                return new JObject { ["ok"] = true, ["title"] = t.Doc.Title, ["path"] = t.Doc.PathName ?? "", ["key"] = FilterVersions.Key(t.Doc), ["active"] = t.Ui != null, ["version"] = FilterVersions.Version(t.Doc) };
        }

        // ---- rows (spec 4.2, 5.7) -------------------------------------------------------------------------------------

        private sealed class GroupDocs { public Document Host; public Document Doc; public RevitLinkInstance Link; public JObject Tag; }

        private static GroupDocs Resolve(UIApplication app, Snapshot s, int group)
        {
            JObject g = s.Links.OfType<JObject>().FirstOrDefault(x => x.Value<int>("group") == group);
            if (g == null) return null;
            JObject docInfo = (JObject)s.Docs[g.Value<int>("doc_index")];
            Document host = null;
            foreach (Document d in app.Application.Documents)
                if (!d.IsLinked && string.Equals(FilterVersions.Key(d), docInfo.Value<string>("key"), StringComparison.OrdinalIgnoreCase)) { host = d; break; }
            if (host == null) return null;
            long linkId = g.Value<long>("link_id");
            if (linkId == 0) return new GroupDocs { Host = host, Doc = host, Tag = (JObject)g["tag"] };
            var inst = host.GetElement(new ElementId(linkId)) as RevitLinkInstance;
            Document ld = inst?.GetLinkDocument();
            return ld == null ? null : new GroupDocs { Host = host, Doc = ld, Link = inst, Tag = (JObject)g["tag"] };
        }

        private static (JArray rows, List<JObject> skipped, string keySource) BuildRows(UIApplication app, Snapshot s, List<SnapEntry> slice, JObject p, JArray warnings)
        {
            var rows = new JArray();
            var skipped = new List<JObject>();
            var fields = new HashSet<string>((p["fields"] as JArray)?.Select(x => x.ToString()) ?? new[] { "id", "unique_id", "name", "category", "family", "type", "level", "doc", "link" });
            JToken want = p["params"] ?? "key";
            JObject kit = p["key_params"] as JObject;
            string keySource = null;
            var cache = new Dictionary<int, GroupDocs>();
            var types = new Dictionary<string, ElementType>();
            foreach (SnapEntry en in slice)
            {
                if (!cache.TryGetValue(en.D, out GroupDocs gd)) cache[en.D] = gd = Resolve(app, s, en.D);
                if (gd == null) { skipped.Add(new JObject { ["id"] = en.Id, ["reason"] = "DOC_SKIPPED", ["detail"] = "its document or link is no longer open" }); continue; }
                Element e = gd.Doc.GetElement(new ElementId(en.Id));
                if (e == null) { skipped.Add(new JObject { ["id"] = en.Id, ["doc"] = gd.Host.Title, ["link"] = gd.Tag["link"], ["reason"] = "ELEMENT_DELETED" }); continue; }
                var row = new JObject { ["id"] = en.Id };
                try
                {
                    string bic = e.Category != null ? e.Category.BuiltInCategory.ToString() : "";
                    ElementType t = e is ElementType et ? et : null;
                    if (t == null && e.GetTypeId() is ElementId tid && tid != ElementId.InvalidElementId)
                    {
                        string tk = gd.Doc.GetHashCode() + ":" + tid.Value;
                        if (!types.TryGetValue(tk, out t)) types[tk] = t = gd.Doc.GetElement(tid) as ElementType;
                    }
                    if (fields.Contains("unique_id")) row["unique_id"] = e.UniqueId;
                    row["name"] = e.Name;
                    row["category"] = e.Category?.Name;
                    row["bic"] = bic;
                    if (fields.Contains("family")) row["family"] = t?.FamilyName ?? "";
                    if (fields.Contains("type")) { row["type"] = t?.Name ?? ""; row["type_id"] = t?.Id.Value; }
                    if (fields.Contains("level")) row["level"] = LevelName(gd.Doc, e);
                    row["doc"] = gd.Host.Title;
                    if (fields.Contains("doc")) row["doc_path"] = gd.Host.PathName ?? "";
                    row["link"] = gd.Tag["link"];
                    Transform T = gd.Link?.GetTotalTransform() ?? Transform.Identity;
                    if (fields.Contains("bbox_mm") && e.get_BoundingBox(null) is BoundingBoxXYZ bb)
                    {
                        var c = FilterCompiler.Corners(bb.Min, bb.Max).Select(T.OfPoint).ToList();
                        row["bbox_mm"] = new JArray(Mm(new XYZ(c.Min(v => v.X), c.Min(v => v.Y), c.Min(v => v.Z))), Mm(new XYZ(c.Max(v => v.X), c.Max(v => v.Y), c.Max(v => v.Z))));
                        if (gd.Link != null) row["bbox_link_mm"] = new JArray(Mm(bb.Min), Mm(bb.Max));
                    }
                    if (fields.Contains("location_mm") && FilterCompiler.Centre(e) is XYZ at)
                    {
                        row["location_mm"] = Mm(T.OfPoint(at));
                        if (gd.Link != null) row["location_link_mm"] = Mm(at);
                    }
                    var (ps, units, src) = Params(e, t, bic, want, kit);
                    if (src != null) keySource = keySource == null || keySource == src ? src : "mixed";
                    row["params"] = ps;
                    if (units.Count > 0) row["units"] = units;
                }
                catch (Exception x)
                {
                    // a row that can't be built is still a row: id and what could be read, plus an INFO_FAILED entry
                    row["doc"] = gd.Host.Title; row["link"] = gd.Tag["link"];
                    try { row["category"] = e.Category?.Name; } catch (Exception) { }
                    row["info_failed"] = true;
                    skipped.Add(new JObject { ["id"] = en.Id, ["doc"] = gd.Host.Title, ["reason"] = "INFO_FAILED", ["detail"] = $"{x.GetType().Name}: {x.Message}" });
                }
                rows.Add(row);
            }
            return (rows, skipped, keySource);
        }

        private static JArray Mm(XYZ p) => new JArray(Math.Round(p.X * 304.8, 1), Math.Round(p.Y * 304.8, 1), Math.Round(p.Z * 304.8, 1));

        private static string LevelName(Document doc, Element e)
        {
            ElementId id = e.LevelId;
            if (id == null || id == ElementId.InvalidElementId) id = e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId();
            if (id == null || id == ElementId.InvalidElementId) id = e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)?.AsElementId();
            return id == null || id == ElementId.InvalidElementId ? "" : doc.GetElement(id)?.Name ?? "";
        }

        private static (JObject ps, JObject units, string source) Params(Element e, ElementType t, string bic, JToken want, JObject kit)
        {
            var ps = new JObject();
            var units = new JObject();
            string source = null;
            if (want.Type == JTokenType.String && want.ToString() == "all")
            {
                foreach (Parameter p in e.Parameters) Put(ps, units, p.Definition?.Name, p);
                if (t != null) foreach (Parameter p in t.Parameters) Put(ps, units, "type." + p.Definition?.Name, p);
                return (ps, units, null);
            }
            string[] names;
            if (want.Type == JTokenType.String && want.ToString() == "key") { var k = KeyParams.For(bic, kit); names = k.names; source = k.source; }
            else names = (want as JArray)?.Select(x => x.ToString()).ToArray() ?? new string[0];
            foreach (string n in names)
            {
                if (string.Equals(n, "Type", StringComparison.OrdinalIgnoreCase)) { ps[n] = t?.Name; continue; }
                if (string.Equals(n, "Host id", StringComparison.OrdinalIgnoreCase)) { ps[n] = (e as FamilyInstance)?.Host?.Id.Value; continue; }
                if (n.Equals("From Room", StringComparison.OrdinalIgnoreCase) || n.Equals("To Room", StringComparison.OrdinalIgnoreCase))
                {
                    Room r = n.StartsWith("From", StringComparison.OrdinalIgnoreCase) ? (e as FamilyInstance)?.FromRoom : (e as FamilyInstance)?.ToRoom;
                    ps[n] = r == null ? null : new JObject { ["id"] = r.Id.Value, ["number"] = r.Number, ["name"] = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() };
                    continue;
                }
                if (string.Equals(n, "Level", StringComparison.OrdinalIgnoreCase) && e.LookupParameter("Level") == null) { ps[n] = LevelName(e.Document, e); continue; }
                Parameter p = e.LookupParameter(n) ?? t?.LookupParameter(n);
                if (p == null) { ps[n] = null; continue; }
                Put(ps, units, n, p);
            }
            return (ps, units, source);
        }

        private static void Put(JObject ps, JObject units, string name, Parameter p)
        {
            if (string.IsNullOrEmpty(name) || ps[name] != null) return;
            ps[name] = Value(p, out string unit);
            if (unit != null) units[name] = unit;
        }

        /// <summary>Units out (spec 4.3): length mm, area m², volume m³, angle degrees; Yes/No a boolean; an id {id, name}.</summary>
        public static JToken Value(Parameter p, out string unit)
        {
            unit = null;
            try
            {
                if (!p.HasValue) return JValue.CreateNull();
                switch (p.StorageType)
                {
                    case StorageType.Double:
                    {
                        var spec = FilterCompiler.SpecOf(p);
                        if (spec != Units.Spec.Other) { unit = Units.Label(spec); return Units.FromInternal(p.AsDouble(), spec); }
                        return p.AsValueString() ?? Math.Round(p.AsDouble(), 6).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    }
                    case StorageType.Integer:
                    {
                        if (FilterCompiler.IsYesNo(p)) return p.AsInteger() == 1;
                        string vs = p.AsValueString();
                        int v = p.AsInteger();
                        return string.IsNullOrEmpty(vs) || vs == v.ToString() ? (JToken)v : vs;
                    }
                    case StorageType.String: return p.AsString() ?? "";
                    case StorageType.ElementId:
                    {
                        ElementId id = p.AsElementId();
                        if (id == null || id == ElementId.InvalidElementId) return JValue.CreateNull();
                        return new JObject { ["id"] = id.Value, ["name"] = p.Element?.Document?.GetElement(id)?.Name ?? p.AsValueString() ?? "" };
                    }
                }
            }
            catch (Exception x) { return $"(unreadable: {x.GetType().Name})"; }
            return JValue.CreateNull();
        }

        // ---- handoff to writes and the selection (spec 6.1, 5.8) ------------------------------------------------------

        /// <summary>Host ids of a result set for one document: link rows refused, a stale set refused unless allow_stale.</summary>
        public static List<ElementId> HostIds(Document doc, string resultSet, bool allowStale, out JArray otherDocs)
        {
            Snapshot s = Cache.Get(resultSet) ?? throw new FilterException("FMC-FILTER-CURSOR-EXPIRED", $"result set {resultSet} is gone", "run the query again");
            otherDocs = new JArray();
            if (!allowStale)
            {
                var changed = Hashes.Changed(s.DocVersions, VersionsNow(doc.Application, s));
                if (changed.Count > 0) throw new FilterException("FMC-FILTER-STALE", $"the model changed since result set {s.Id} was taken", "run again, or pass allow_stale true", new JObject { ["changed_docs"] = new JArray(changed) });
            }
            string key = FilterVersions.Key(doc);
            var ids = new List<ElementId>();
            foreach (SnapEntry en in s.Entries)
            {
                JObject g = s.Links.OfType<JObject>().First(x => x.Value<int>("group") == en.D);
                JObject di = (JObject)s.Docs[g.Value<int>("doc_index")];
                if (g.Value<long>("link_id") != 0) throw new FilterException("FMC-FILTER-LINK-NOT-EDITABLE", $"result set {s.Id} has rows in a link ({g["tag"]?["link"]?["name"]})", "edit link elements in the link's own model; narrow scope.links to host");
                if (!string.Equals(di.Value<string>("key"), key, StringComparison.OrdinalIgnoreCase)) { otherDocs.Add(en.Id); continue; }
                ids.Add(new ElementId(en.Id));
            }
            return ids;
        }

        public static Snapshot SnapshotOf(string id) => Cache.Get(id ?? "");

        /// <summary>A criteria tree in one document's host elements (modify_model / see_view select, spec 6.1). Undetermined
        /// elements are not matches, so a write never touches an element whose criterion parameter was missing.</summary>
        public static List<Element> FindIn(Document doc, JObject p, View active)
        {
            var (query, root, universe) = Query(p);
            if (query.Value<bool>("invert")) throw new FilterException("FMC-FILTER-BAD-CRITERIA", "invert is not taken in a write's select", "preview the inverse with select_by, then pass its result_set");
            var ctx = new FilterCtx { Doc = doc, Host = doc, Active = active, Missing = query.Value<string>("missing") };
            Plan plan = FilterCompiler.Compile(ctx, root);
            FilteredElementCollector col = Collector(ctx, plan, query.Value<string>("kind"));
            var found = new List<Element>();
            if (col == null) return found;
            foreach (ElementId id in col.ToElementIds())
            {
                Element e = doc.GetElement(id);
                if (e == null) continue;
                if (plan.Eval(e).IsTrue) found.Add(e);
            }
            return found;
        }

        /// <summary>The select_by show action: Revit's selection only (no transaction), the active document only, capped.</summary>
        public static JObject Show(UIApplication app, JObject p)
        {
            FilterVersions.Hook(app.Application);
            try
            {
                UIDocument ui = app.ActiveUIDocument ?? throw new FilterException("FMC-FILTER-UI-NEEDS-ACTIVE", "no active document", "ask the person to open the model");
                Document doc = ui.Document;
                string want = p.Value<string>("document");
                if (!string.IsNullOrWhiteSpace(want) && !string.Equals(doc.Title, want, StringComparison.OrdinalIgnoreCase) && !string.Equals(doc.PathName, want, StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(System.IO.Path.GetFileNameWithoutExtension(doc.PathName ?? ""), want, StringComparison.OrdinalIgnoreCase))
                    throw new FilterException("FMC-FILTER-UI-NEEDS-ACTIVE", $"{want} is open in the background; the active document is {doc.Title}", "ask the person to activate the model");
                JObject show = p["show"] as JObject ?? new JObject();
                int max = show.Value<int?>("max") ?? p.Value<int?>("max") ?? FilterLimits.ShowDefault;
                if (max < 1 || max > FilterLimits.ShowMax) throw new FilterException("FMC-FILTER-SHOW-TOO-MANY", $"max {max} is outside 1..{FilterLimits.ShowMax}", "use max up to 5000");
                bool zoom = show.Value<bool?>("zoom") ?? p.Value<bool?>("zoom") ?? true;
                var hostIds = new List<ElementId>();
                var linkRefs = new List<Reference>();
                var notSelectable = new JArray();
                if (p["result_set"] != null)
                {
                    Snapshot s = Cache.Get(p.Value<string>("result_set")) ?? throw new FilterException("FMC-FILTER-CURSOR-EXPIRED", $"result set {p["result_set"]} is gone", "run again");
                    if (p.Value<bool?>("allow_stale") != true)
                    {
                        var changed = Hashes.Changed(s.DocVersions, VersionsNow(app, s));
                        if (changed.Count > 0) throw new FilterException("FMC-FILTER-STALE", "the model changed since this result set", "run again", new JObject { ["changed_docs"] = new JArray(changed) });
                    }
                    if (s.Entries.Count > max) throw new FilterException("FMC-FILTER-SHOW-TOO-MANY", $"{s.Entries.Count} elements, over show max {max} (no partial selection)", "narrow the query, or raise show.max up to 5000");
                    string key = FilterVersions.Key(doc);
                    foreach (SnapEntry en in s.Entries)
                    {
                        JObject g = s.Links.OfType<JObject>().First(x => x.Value<int>("group") == en.D);
                        JObject di = (JObject)s.Docs[g.Value<int>("doc_index")];
                        if (!string.Equals(di.Value<string>("key"), key, StringComparison.OrdinalIgnoreCase)) { notSelectable.Add(new JObject { ["id"] = en.Id, ["doc"] = di["title"], ["reason"] = "another document" }); continue; }
                        long linkId = g.Value<long>("link_id");
                        if (linkId == 0) { hostIds.Add(new ElementId(en.Id)); continue; }
                        var inst = doc.GetElement(new ElementId(linkId)) as RevitLinkInstance;
                        Element le = inst?.GetLinkDocument()?.GetElement(new ElementId(en.Id));
                        if (le == null) { notSelectable.Add(new JObject { ["id"] = en.Id, ["reason"] = "link element not found" }); continue; }
                        linkRefs.Add(new Reference(le).CreateLinkReference(inst));
                    }
                }
                else if (p["ids"] is JArray ids)
                {
                    if (ids.Count > max) throw new FilterException("FMC-FILTER-SHOW-TOO-MANY", $"{ids.Count} ids, over show max {max}", "narrow it");
                    foreach (JToken t in ids)
                    {
                        ElementId id = FilterCompiler.IdOf(doc, t);
                        if (doc.GetElement(id) != null) hostIds.Add(id); else notSelectable.Add(new JObject { ["id"] = t, ["reason"] = "not found" });
                    }
                }
                else throw new FilterException("FMC-FILTER-BAD-CRITERIA", "show needs result_set or ids");
#if REVIT2023_OR_GREATER
                if (linkRefs.Count > 0)
                {
                    var refs = hostIds.Select(id => new Reference(doc.GetElement(id))).Concat(linkRefs).ToList();
                    ui.Selection.SetReferences(refs);
                }
                else ui.Selection.SetElementIds(hostIds);
#else
                foreach (var r in linkRefs) notSelectable.Add(new JObject { ["id"] = r.LinkedElementId.Value, ["reason"] = "not_selectable: link rows need Revit 2023+" });
                linkRefs.Clear();
                ui.Selection.SetElementIds(hostIds);
#endif
                bool zoomed = false;
                if (zoom && hostIds.Count > 0) { try { ui.ShowElements(hostIds); zoomed = true; } catch (Exception) { /* not visible in an open view: the selection holds */ } }
                return new JObject
                {
                    ["ok"] = true, ["action"] = "show", ["doc"] = doc.Title, ["selected"] = hostIds.Count + linkRefs.Count, ["selected_host"] = hostIds.Count,
                    ["selected_in_links"] = linkRefs.Count, ["zoomed"] = zoomed, ["not_selectable"] = notSelectable,
                };
            }
            catch (FilterException fx) { var o = fx.ToJson(); o["action"] = "show"; return o; }
        }
    }
}
