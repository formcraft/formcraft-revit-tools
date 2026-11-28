using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// The lasting change log (F19 / F133): hooked at plugin startup, not at the first Formcraft call. Listens to
    /// DocumentOpened, DocumentChanged, saves, syncs and closing, and appends JSONL under
    /// %APPDATA%\Formcraft\ledger\model-changes. Read only: no transaction, no save, no sync, no reload latest,
    /// no relinquish, no checkout, and it never opens or closes a model. A save or a sync someone runs in Revit is
    /// recorded after it happened.
    /// </summary>
    public static class ChangeFeedSession
    {
        private static readonly object L = new object();
        private static bool _hooked;
        private static string _dir;
        private static readonly FeedJournal Memory = new FeedJournal(FeedJournal.DefaultCap);
        // last seen key params, so the next DocumentChanged can say old -> new
        private static readonly Dictionary<string, Dictionary<long, List<ParamValue>>> Cache =
            new Dictionary<string, Dictionary<long, List<ParamValue>>>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, Dictionary<long, ElementHint>> Hints =
            new Dictionary<string, Dictionary<long, ElementHint>>(StringComparer.OrdinalIgnoreCase);
        private static readonly Queue<FillJob> Fill = new Queue<FillJob>();
        private const int CacheCap = 30000;
        private const int IdleSlice = 250;

        private struct ElementHint { public string Category, Name, UniqueId; }
        private sealed class FillJob { public Document Doc; public FilteredElementCollector Coll; public FilteredElementIterator Walk; }

        private static ChangeFeedOptions _options = ChangeFeedOptions.Defaults();

        public static bool Hooked { get { lock (L) return _hooked; } }
        public static string Dir { get { lock (L) return _dir; } }
        public static ChangeFeedOptions Options { get { lock (L) return _options ?? ChangeFeedOptions.Defaults(); } }
        public static bool LoggingEnabled { get { return Options.Logging; } }

        /// <summary>The in-memory journal page, for fmc_change_feed_read when logging to disk is off.</summary>
        public static FeedPage QueryMemory(string document, long afterSeq, int limit)
        {
            lock (L) return Memory.Query(document, afterSeq, limit);
        }

        /// <summary>Call once from OnStartup on Revit's UI thread. kitFolder is the Formcraft kit (FMC_Kit.json in it), used only to read the change-feed options; it is never written.</summary>
        public static void Hook(UIControlledApplication ui, Func<string> kitFolder = null)
        {
            if (ui == null) return;
            lock (L)
            {
                if (_hooked) return;
                try
                {
                    string kit = "";
                    try { kit = kitFolder != null ? (kitFolder() ?? "") : ""; } catch (Exception) { kit = ""; }
                    _options = ChangeFeedOptions.Load(kit);
                    _dir = ChangeFeedLog.DefaultDir();
                    var app = ui.ControlledApplication;
                    app.DocumentOpened += OnOpened;
                    app.DocumentCreated += OnCreated;
                    app.DocumentChanged += OnChanged;
                    app.DocumentSaved += OnSaved;
                    app.DocumentSavedAs += OnSavedAs;
                    app.DocumentSynchronizedWithCentral += OnSynced;
                    app.DocumentClosing += OnClosing;
                    ui.Idling += OnIdling;
                    _hooked = true;
                    DateTime at = DateTime.UtcNow;
                    Memory.Started(at);
                    if (_options.Logging && !string.IsNullOrEmpty(_dir) && ChangeFeedLog.RefuseDir(_dir).Length == 0)
                    {
                        ChangeFeedLog.MarkListening(_dir, at);
                        ChangeFeedLog.PruneOlder(_dir, at, _options.RetentionMonths);
                    }
                }
                catch (Exception) { /* the command then says it isn't listening */ }
            }
        }

        public static string Key(Document d)
        {
            if (d == null) return "";
            return string.IsNullOrEmpty(d.PathName) ? (d.Title ?? "") : d.PathName;
        }

        private static long IdOf(ElementId id)
        {
            if (id == null) return 0;
#if REVIT2024_OR_GREATER
            return id.Value;
#else
            return id.IntegerValue;
#endif
        }

        private static string UserOf(Document d)
        {
            try { return d?.Application?.Username ?? ""; } catch (Exception) { return ""; }
        }

        // The plugin must not reference commandset's FmcAiJob; a person is the default, "ai" when the job flag is on.
        private static string ByNow()
        {
            try
            {
                var t = Type.GetType("RevitMCPCommandSet.Bridge.FmcAiJob, RevitMCPCommandSet");
                if (t == null) return "person";
                var p = t.GetProperty("Executing", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                if (p != null && p.GetValue(null) is bool b && b) return "ai";
            }
            catch (Exception) { }
            return "person";
        }

        private static void Note(Document doc, string kind, string label)
        {
            try
            {
                if (doc == null || doc.IsLinked) return;
                Record(new FeedEntry
                {
                    AtUtc = DateTime.UtcNow,
                    Document = Key(doc),
                    Kind = kind,
                    Label = label ?? "",
                    User = UserOf(doc),
                    By = ByNow(),
                });
            }
            catch (Exception) { /* never break Revit's own event */ }
        }

        private static void OnOpened(object sender, DocumentOpenedEventArgs e)
        {
            Note(e.Document, "opened", "");
            if (!ChangeFeedOptions.IsProtectedDocument(Key(e.Document), out _)) QueueFill(e.Document);
        }

        private static void OnCreated(object sender, DocumentCreatedEventArgs e)
        {
            Note(e.Document, "opened", "new document");
            if (!ChangeFeedOptions.IsProtectedDocument(Key(e.Document), out _)) QueueFill(e.Document);
        }

        private static void OnSaved(object sender, DocumentSavedEventArgs e) => Note(e.Document, "saved", e.Status.ToString());
        private static void OnSavedAs(object sender, DocumentSavedAsEventArgs e) => Note(e.Document, "saved", "save as: " + e.Status);
        private static void OnSynced(object sender, DocumentSynchronizedWithCentralEventArgs e) => Note(e.Document, "synced", e.Status.ToString());

        private static void OnClosing(object sender, DocumentClosingEventArgs e)
        {
            Note(e.Document, "closed", "");
            string k = Key(e.Document);
            lock (L) { Cache.Remove(k); Hints.Remove(k); }
        }

        private static void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                Document doc = e.GetDocument();
                if (doc == null || doc.IsLinked) return;
                var added = e.GetAddedElementIds();
                var modified = e.GetModifiedElementIds();
                var deleted = e.GetDeletedElementIds();
                var entry = new FeedEntry
                {
                    AtUtc = DateTime.UtcNow,
                    Document = Key(doc),
                    Kind = FeedJournal.KindOf(e.Operation.ToString()),
                    Label = string.Join(", ", e.GetTransactionNames()),
                    User = UserOf(doc),
                    By = ByNow(),
                    Added = added.Count,
                    Modified = modified.Count,
                    Deleted = deleted.Count,
                    AddedIds = added.Take(FeedJournal.IdCap).Select(IdOf).ToList(),
                    ModifiedIds = modified.Take(FeedJournal.IdCap).Select(IdOf).ToList(),
                    DeletedIds = deleted.Take(FeedJournal.IdCap).Select(IdOf).ToList(),
                };
                if (ChangeFeedOptions.IsProtectedDocument(Key(doc), out string protectedWhy))
                {
                    entry.Elements = new List<ElementChange>();
                    entry.ElementsTruncated = false;
                    entry.TruncateReason = protectedWhy;
                    Record(entry);
                    return;
                }
                var details = new List<ElementChange>();
                foreach (ElementId id in deleted)
                    details.Add(DescribeDeleted(Key(doc), IdOf(id)));
                foreach (ElementId id in added)
                    details.Add(Describe(doc, id, "created", null));
                foreach (ElementId id in modified)
                {
                    long n = IdOf(id);
                    List<ParamValue> before = LookupCache(Key(doc), n);
                    details.Add(Describe(doc, id, "modified", before));
                }
                bool et;
                string reason;
                entry.Elements = ChangeFeedParams.CapElements(details, ChangeFeedParams.DefaultMaxElements, ChangeFeedParams.DefaultMaxBytes, out et, out reason);
                entry.ElementsTruncated = et;
                entry.TruncateReason = reason;
                Record(entry);

                // refresh the snapshot so the next edit has an old value
                foreach (ElementId id in added.Concat(modified))
                    Remember(doc, id);
                foreach (ElementId id in deleted)
                {
                    long n = IdOf(id);
                    lock (L)
                    {
                        if (Cache.TryGetValue(Key(doc), out var map)) map.Remove(n);
                        if (Hints.TryGetValue(Key(doc), out var h)) h.Remove(n);
                    }
                }
            }
            catch (Exception) { /* never break Revit's own event */ }
        }

        private static void Record(FeedEntry e)
        {
            string dir;
            lock (L)
            {
                Memory.Add(e);
                dir = _dir;
            }
            if (LoggingEnabled && !string.IsNullOrEmpty(dir) && ChangeFeedLog.RefuseDir(dir).Length == 0)
                ChangeFeedLog.Append(dir, e);
        }

        private static ElementChange DescribeDeleted(string docKey, long id)
        {
            var row = new ElementChange { Id = id, Action = "deleted" };
            List<ParamValue> before = LookupCache(docKey, id);
            ElementHint hint;
            lock (L)
            {
                hint = default;
                if (Hints.TryGetValue(docKey, out var h) && h.TryGetValue(id, out var x)) hint = x;
            }
            row.Category = hint.Category ?? "";
            row.Name = hint.Name ?? "";
            row.UniqueId = hint.UniqueId ?? "";
            bool t;
            string reason;
            row.Params = ChangeFeedParams.Cap(ChangeFeedParams.Diff(before, null), ChangeFeedParams.DefaultMaxParams, ChangeFeedParams.DefaultMaxBytes / 4, out t, out reason);
            row.ParamsTruncated = t;
            row.TruncateReason = reason;
            if (before == null) { row.TruncateReason = string.IsNullOrEmpty(row.TruncateReason) ? "Before values were not yet in the session snapshot." : row.TruncateReason; }
            return row;
        }

        private static ElementChange Describe(Document doc, ElementId id, string action, List<ParamValue> before)
        {
            var row = new ElementChange { Id = IdOf(id), Action = action };
            Element e = null;
            try { e = doc.GetElement(id); } catch (Exception) { }
            if (e == null)
            {
                row.TruncateReason = "The element was not in the document when the change was read.";
                return row;
            }
            row.Category = e.Category?.Name ?? "";
            row.Name = e.Name ?? "";
            try { row.UniqueId = e.UniqueId ?? ""; } catch (Exception) { row.UniqueId = ""; }
            var after = Snapshot(e);
            bool t;
            string reason;
            row.Params = ChangeFeedParams.Cap(ChangeFeedParams.Diff(before, after), ChangeFeedParams.DefaultMaxParams, ChangeFeedParams.DefaultMaxBytes / 4, out t, out reason);
            row.ParamsTruncated = t;
            row.TruncateReason = reason;
            if (action == "modified" && before == null)
                row.TruncateReason = string.IsNullOrEmpty(row.TruncateReason)
                    ? "Before values were not yet in the session snapshot; only the values after this edit were kept."
                    : row.TruncateReason;
            return row;
        }

        private static List<ParamValue> Snapshot(Element e)
        {
            var raw = new List<ParamValue>();
            if (e == null) return raw;
            raw.Add(new ParamValue { Name = "Name", Value = e.Name ?? "" });
            try
            {
                if (e is ElementType typ)
                {
                    raw.Add(new ParamValue { Name = "Family", Value = typ.FamilyName ?? "" });
                    raw.Add(new ParamValue { Name = "Type Name", Value = typ.Name ?? "" });
                }
                else if (e is FamilyInstance fi)
                {
                    raw.Add(new ParamValue { Name = "Family", Value = fi.Symbol?.FamilyName ?? "" });
                    raw.Add(new ParamValue { Name = "Type", Value = fi.Symbol?.Name ?? "" });
                }
            }
            catch (Exception) { }
            try
            {
                foreach (Parameter p in e.Parameters)
                {
                    string name;
                    try { name = p?.Definition?.Name ?? ""; } catch (Exception) { continue; }
                    if (!ChangeFeedParams.IsKeyName(name) || name == "Name") continue;
                    raw.Add(new ParamValue { Name = name, Value = Stringify(p) });
                }
            }
            catch (Exception) { }
            return ChangeFeedParams.SnapshotOf(raw, ChangeFeedParams.DefaultMaxParams);
        }

        private static string Stringify(Parameter p)
        {
            if (p == null) return "";
            try
            {
                if (p.StorageType == StorageType.String) return p.AsString() ?? "";
                if (p.StorageType == StorageType.ElementId)
                {
                    ElementId id = p.AsElementId();
                    Element t = p.Element?.Document?.GetElement(id);
                    if (t != null && !string.IsNullOrEmpty(t.Name)) return t.Name;
                }
                return p.AsValueString() ?? "";
            }
            catch (Exception) { return ""; }
        }

        private static List<ParamValue> LookupCache(string doc, long id)
        {
            lock (L)
            {
                if (Cache.TryGetValue(doc, out var map) && map.TryGetValue(id, out var v))
                    return v.Select(p => new ParamValue { Name = p.Name, Value = p.Value }).ToList();
            }
            return null;
        }

        private static void Remember(Document doc, ElementId id)
        {
            Element e;
            try { e = doc.GetElement(id); } catch (Exception) { return; }
            if (e == null) return;
            string k = Key(doc);
            long n = IdOf(id);
            var snap = Snapshot(e);
            var hint = new ElementHint { Category = e.Category?.Name ?? "", Name = e.Name ?? "", UniqueId = "" };
            try { hint.UniqueId = e.UniqueId ?? ""; } catch (Exception) { }
            lock (L)
            {
                if (!Cache.TryGetValue(k, out var map)) Cache[k] = map = new Dictionary<long, List<ParamValue>>();
                if (!Hints.TryGetValue(k, out var hints)) Hints[k] = hints = new Dictionary<long, ElementHint>();
                map[n] = snap;
                hints[n] = hint;
                if (map.Count > CacheCap)
                {
                    // drop an arbitrary older half to stay bounded
                    foreach (var old in map.Keys.Take(map.Count / 4).ToList()) { map.Remove(old); hints.Remove(old); }
                }
            }
        }

        private static void QueueFill(Document doc)
        {
            if (doc == null || doc.IsLinked) return;
            try
            {
                var coll = new FilteredElementCollector(doc);
                lock (L) Fill.Enqueue(new FillJob { Doc = doc, Coll = coll, Walk = coll.GetElementIterator() });
            }
            catch (Exception) { /* the first edit may then have no before value, and the entry says so */ }
        }

        /// <summary>Fills the param cache in short idle slices so opening a large model does not stall Revit. Read only.</summary>
        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            FillJob job;
            lock (L)
            {
                if (Fill.Count == 0) return;
                job = Fill.Peek();
            }
            try
            {
                int n = 0;
                while (n < IdleSlice && job.Walk != null && job.Walk.MoveNext())
                {
                    Element el = job.Walk.Current;
                    if (el != null) Remember(job.Doc, el.Id);
                    n++;
                }
                bool done = job.Walk == null || n < IdleSlice;
                if (done) { try { job.Walk.Dispose(); } catch (Exception) { } lock (L) { if (Fill.Count > 0 && ReferenceEquals(Fill.Peek().Walk, job.Walk)) Fill.Dequeue(); } }
            }
            catch (Exception)
            {
                lock (L) { if (Fill.Count > 0) Fill.Dequeue(); }
            }
        }
    }
}
