using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// fmc_watch: a change ledger for one open project model. While a watch runs, every change is appended as one JSON line
    /// (time, user, element id, category, change type, transaction names, undo operation) to the ledger file the server chose
    /// (<project>\06_QA\Watch\*.jsonl, or the reports folder: the server applies the same guard as fmc_warnings).
    ///
    /// Two sources, because each alone is not enough:
    ///  - a dynamic model updater (<see cref="WatchUpdater"/>) sees WHAT kind of change it was (added, deleted, geometry,
    ///    parameter) and the element's category, while the transaction is still open. It only reads, never writes a model
    ///    element, never throws into Revit, and does no file I/O: it files its findings in memory.
    ///  - Application.DocumentChanged fires after each commit, undo and redo with the transaction names and every added,
    ///    modified and deleted id (also the ones no trigger matched), merges the updater's findings and writes the lines.
    ///
    /// The updater is registered for this one document and unregistered on stop and on DocumentClosing. Nothing here saves,
    /// synchronises, opens or closes a model, and nothing writes the model. The only file written is the ledger.
    /// </summary>
    public static class FmcWatch
    {
        public const int MaxRowsPerEvent = 500;
        public const int MaxIdsPerExecute = 2000;
        private const int CategoryCacheLimit = 100000;

        public sealed class Session
        {
            public string Key = "", Title = "", File = "", User = "", Scope = "model";
            public DateTime StartedAt = DateTime.Now;
            public UpdaterId Id;
            public long Added, Deleted, Geometry, Parameter, Modified, Rows, Dropped, Errors, Events;
            public string LastError = "";
            /// <summary>What the updater decided for an id during the open transaction: added, deleted, geometry or parameter.</summary>
            public readonly Dictionary<long, string> Types = new Dictionary<long, string>();
            /// <summary>Category by element id, so a deleted element (gone when DocumentChanged fires) still has one when it was seen.</summary>
            public readonly Dictionary<long, string> Cats = new Dictionary<long, string>();
        }

        private static readonly object L = new object();
        private static readonly Dictionary<string, Session> Sessions = new Dictionary<string, Session>(StringComparer.OrdinalIgnoreCase);
        private static Autodesk.Revit.ApplicationServices.Application _revit;
        private static bool _hooked;

        // categories a "model" scope adds to the model categories: levels, grids and rooms are what people watch most
        private static readonly long[] ExtraCategories =
        {
            (long)BuiltInCategory.OST_Levels, (long)BuiltInCategory.OST_Grids, (long)BuiltInCategory.OST_Rooms, (long)BuiltInCategory.OST_Areas,
        };

        public static string Key(Document d) => string.IsNullOrEmpty(d.PathName) ? d.Title : d.PathName;

        /// <summary>The ledger path is the server's choice; the add-in still refuses anything but a .jsonl in a folder called Watch, and any review folder.</summary>
        public static string FileProblem(string file)
        {
            if (string.IsNullOrWhiteSpace(file)) return "file is required";
            string expanded;
            try { expanded = Path.GetFullPath(file); } catch (Exception) { return "file is not a valid path"; }
            if (!Path.IsPathRooted(file)) return "file must be an absolute path";
            if (!string.Equals(Path.GetExtension(expanded), ".jsonl", StringComparison.OrdinalIgnoreCase)) return "the ledger is a .jsonl file";
            if (!string.Equals(Path.GetFileName(Path.GetDirectoryName(expanded) ?? ""), "Watch", StringComparison.OrdinalIgnoreCase)) return "the ledger goes in a folder called Watch";
            string low = expanded.ToLowerInvariant();
            if (low.Contains("\\_reviews\\") || low.Contains("review_register")) return "a review folder or register is never written";
            return "";
        }

        public static Session Find(string key) { lock (L) return Sessions.TryGetValue(key, out Session s) ? s : null; }
        public static List<Session> All() { lock (L) return Sessions.Values.ToList(); }

        /// <summary>Starts watching a document (call on Revit's API thread, inside an external event, so ActiveAddInId is valid).</summary>
        public static Session Start(UIApplication app, Document doc, string file, string scope, out bool already)
        {
            already = false;
            string key = Key(doc);
            lock (L) if (Sessions.TryGetValue(key, out Session existing)) { already = true; return existing; }
            string problem = FileProblem(file);
            if (problem.Length > 0) throw new InvalidOperationException("[FMC-WATCH-FILE] " + problem);
            if (doc.IsFamilyDocument || doc.IsLinked) throw new InvalidOperationException("[FMC-WATCH-DOC] fmc_watch watches project models, not families or links.");
            scope = string.Equals(scope, "all", StringComparison.OrdinalIgnoreCase) ? "all" : "model";

            ElementFilter filter = Categories(doc, scope);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
            var updater = new WatchUpdater(app.ActiveAddInId, DocumentGuid(key), key);
            var s = new Session { Key = key, Title = doc.Title ?? "", File = Path.GetFullPath(file), User = app.Application.Username ?? "", Scope = scope, Id = updater.GetUpdaterId() };
            lock (L) Sessions[key] = s;
            try
            {
                // optional: a model opened on a machine without the add-in opens without a warning
                UpdaterRegistry.RegisterUpdater(updater, doc, true);
                UpdaterRegistry.AddTrigger(s.Id, doc, filter, Element.GetChangeTypeElementAddition());
                UpdaterRegistry.AddTrigger(s.Id, doc, filter, Element.GetChangeTypeElementDeletion());
                UpdaterRegistry.AddTrigger(s.Id, doc, filter, Element.GetChangeTypeGeometry());
                UpdaterRegistry.AddTrigger(s.Id, doc, filter, Element.GetChangeTypeAny());
                Hook(app);
                Append(s, new List<string> { Row(s, "watch_started", $"scope {scope}; user {s.User}") });
            }
            catch (Exception)
            {
                lock (L) Sessions.Remove(key);
                TryUnregister(s.Id, doc);
                throw;
            }
            return s;
        }

        /// <summary>Stops a watch: unregisters the updater, writes a closing row and drops the session. Returns null when none ran.</summary>
        public static Session Stop(UIApplication app, Document doc, string why)
        {
            Session s;
            lock (L) { if (!Sessions.TryGetValue(Key(doc), out s)) return null; Sessions.Remove(s.Key); }
            TryUnregister(s.Id, doc);
            Append(s, new List<string> { Row(s, "watch_stopped", why ?? "stop") });
            Unhook(app?.Application);
            return s;
        }

        public static JObject Describe(Session s) => new JObject
        {
            ["document"] = s.Title, ["running"] = true, ["file"] = s.File, ["scope"] = s.Scope, ["user"] = s.User,
            ["started_at"] = s.StartedAt.ToString("o"), ["events"] = s.Events, ["rows_written"] = s.Rows, ["rows_dropped"] = s.Dropped,
            ["seen"] = new JObject { ["added"] = s.Added, ["deleted"] = s.Deleted, ["geometry"] = s.Geometry, ["parameter"] = s.Parameter, ["modified_other"] = s.Modified },
            ["errors"] = s.Errors, ["last_error"] = s.LastError,
        };

        // ---- the two sources --------------------------------------------------------------------------------------------

        internal static void FromUpdater(string key, Document doc, UpdaterData data)
        {
            Session s = Find(key);
            if (s == null || doc == null) return;
            lock (s)
            {
                int budget = MaxIdsPerExecute;
                foreach (ElementId id in data.GetAddedElementIds()) { if (budget-- <= 0) break; Note(s, doc, id, "added"); s.Added++; }
                foreach (ElementId id in data.GetModifiedElementIds())
                {
                    if (budget-- <= 0) break;
                    bool geometry = data.IsChangeTriggered(id, Element.GetChangeTypeGeometry());
                    Note(s, doc, id, geometry ? "geometry" : "parameter");
                    if (geometry) s.Geometry++; else s.Parameter++;
                }
                foreach (ElementId id in data.GetDeletedElementIds()) { if (budget-- <= 0) break; s.Types[id.Value] = "deleted"; s.Deleted++; }
            }
        }

        private static void Note(Session s, Document doc, ElementId id, string type)
        {
            s.Types[id.Value] = type;
            Category c = doc.GetElement(id)?.Category;
            if (c != null) Remember(s, id.Value, c.Name);
        }

        private static void Remember(Session s, long id, string category)
        {
            if (s.Cats.Count > CategoryCacheLimit) s.Cats.Clear();
            s.Cats[id] = category;
        }

        internal static void Fail(string key, Exception e)
        {
            Session s = Find(key);
            if (s == null) return;
            lock (s) { s.Errors++; s.LastError = e.GetType().Name + ": " + e.Message; }
        }

        private static void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            Session s = null;
            try
            {
                Document doc = e.GetDocument();
                if (doc == null) return;
                s = Find(Key(doc));
                if (s == null) return;
                var lines = new List<string>();
                lock (s)
                {
                    s.Events++;
                    string tx = string.Join("; ", e.GetTransactionNames());
                    string op = e.Operation.ToString();
                    string user = doc.Application.Username ?? "";
                    int skipped = 0;
                    void Emit(ElementId id, string generic, bool deleted)
                    {
                        string category = null;
                        if (!deleted) { Category c = doc.GetElement(id)?.Category; if (c != null) { category = c.Name; Remember(s, id.Value, category); } }
                        else s.Cats.TryGetValue(id.Value, out category);
                        // a model scope leaves out what has no category (views' own bookkeeping, tags' helper elements): an undo or redo too
                        if (category == null && !deleted && s.Scope != "all") { skipped++; return; }
                        if (category != null && s.Scope != "all" && !s.Types.ContainsKey(id.Value) && !deleted && !IsModelOrExtra(doc, id)) { skipped++; return; }
                        if (lines.Count >= MaxRowsPerEvent) { skipped++; return; }
                        string type = s.Types.TryGetValue(id.Value, out string t) ? t : generic;
                        if (type == "modified") s.Modified++;
                        lines.Add(new JObject
                        {
                            ["t"] = DateTime.Now.ToString("o"), ["user"] = user, ["doc"] = s.Title, ["op"] = op, ["tx"] = tx,
                            ["id"] = id.Value, ["cat"] = category ?? (deleted ? "(unknown)" : ""), ["type"] = type,
                        }.ToString(Newtonsoft.Json.Formatting.None));
                    }
                    foreach (ElementId id in e.GetAddedElementIds()) Emit(id, "added", false);
                    foreach (ElementId id in e.GetModifiedElementIds()) Emit(id, "modified", false);
                    foreach (ElementId id in e.GetDeletedElementIds()) Emit(id, "deleted", true);
                    if (skipped > 0) lines.Add(new JObject { ["t"] = DateTime.Now.ToString("o"), ["user"] = user, ["doc"] = s.Title, ["op"] = op, ["tx"] = tx, ["type"] = "summary", ["not_listed"] = skipped }.ToString(Newtonsoft.Json.Formatting.None));
                    s.Types.Clear();
                    Append(s, lines);
                }
            }
            catch (Exception ex) { if (s != null) Fail(s.Key, ex); }
        }

        private static bool IsModelOrExtra(Document doc, ElementId id)
        {
            Category c = doc.GetElement(id)?.Category;
            return c != null && (c.CategoryType == CategoryType.Model || ExtraCategories.Contains(c.Id.Value));
        }

        private static void OnClosing(object sender, DocumentClosingEventArgs e)
        {
            try
            {
                Document doc = e.Document;
                if (doc == null) return;
                Session s;
                lock (L) { if (!Sessions.TryGetValue(Key(doc), out s)) return; Sessions.Remove(s.Key); }
                TryUnregister(s.Id, doc);
                Append(s, new List<string> { Row(s, "watch_stopped", "document closed") });
                Unhook(sender as Autodesk.Revit.ApplicationServices.Application ?? _revit);
            }
            catch (Exception) { /* closing a document must never be held up by the watch */ }
        }

        // ---- plumbing ---------------------------------------------------------------------------------------------------

        private static void Hook(UIApplication app)
        {
            lock (L)
            {
                if (_hooked) return;
                _revit = app.Application;
                _revit.DocumentChanged += OnChanged;
                _revit.DocumentClosing += OnClosing;
                _hooked = true;
            }
        }

        private static void Unhook(Autodesk.Revit.ApplicationServices.Application revit)
        {
            lock (L)
            {
                if (!_hooked || Sessions.Count > 0) return;
                try
                {
                    var r = revit ?? _revit;
                    if (r != null) { r.DocumentChanged -= OnChanged; r.DocumentClosing -= OnClosing; }
                }
                catch (Exception) { }
                _hooked = false;
            }
        }

        private static void TryUnregister(UpdaterId id, Document doc)
        {
            try { if (UpdaterRegistry.IsUpdaterRegistered(id, doc)) UpdaterRegistry.UnregisterUpdater(id, doc); }
            catch (Exception) { /* a document that is closing has dropped its document-specific updaters already */ }
        }

        private static ElementFilter Categories(Document doc, string scope)
        {
            var ids = new List<ElementId>();
            foreach (Category c in doc.Settings.Categories)
            {
                if (c == null) continue;
                if (scope == "all" || c.CategoryType == CategoryType.Model || ExtraCategories.Contains(c.Id.Value)) ids.Add(c.Id);
            }
            if (ids.Count == 0) throw new InvalidOperationException("[FMC-WATCH-DOC] this document has no categories to watch.");
            return new ElementMulticategoryFilter(ids);
        }

        /// <summary>One stable updater id per document, so a restart in the same Revit session registers the same updater.</summary>
        private static Guid DocumentGuid(string key)
        {
            using (var md5 = MD5.Create()) return new Guid(md5.ComputeHash(Encoding.UTF8.GetBytes("FMC.Watch|" + key.ToLowerInvariant())));
        }

        private static string Row(Session s, string type, string note) =>
            new JObject { ["t"] = DateTime.Now.ToString("o"), ["user"] = s.User, ["doc"] = s.Title, ["type"] = type, ["note"] = note }.ToString(Newtonsoft.Json.Formatting.None);

        /// <summary>Appends lines to the ledger. A failure is counted and kept for status; it is never thrown into Revit.</summary>
        private static void Append(Session s, List<string> lines)
        {
            if (lines.Count == 0) return;
            try
            {
                File.AppendAllText(s.File, string.Join("\n", lines) + "\n", new UTF8Encoding(false));
                s.Rows += lines.Count;
            }
            catch (Exception ex)
            {
                s.Dropped += lines.Count; s.Errors++; s.LastError = ex.GetType().Name + ": " + ex.Message;
            }
        }
    }

    /// <summary>
    /// The updater half of fmc_watch. Execute only reads, files its findings in memory (no I/O), and swallows every
    /// exception: an updater that throws is switched off by Revit for the session, with a dialog for the person.
    /// </summary>
    public sealed class WatchUpdater : IUpdater
    {
        private readonly UpdaterId _id;
        private readonly string _key;

        public WatchUpdater(AddInId addIn, Guid guid, string key) { _id = new UpdaterId(addIn, guid); _key = key; }

        public UpdaterId GetUpdaterId() => _id;
        public ChangePriority GetChangePriority() => ChangePriority.Annotations;
        public string GetUpdaterName() => "Formcraft: watch (change ledger)";
        public string GetAdditionalInformation() =>
            "Records what kind of change each element had (added, deleted, geometry, parameter) for the change ledger the BIM team switched on with fmc_watch. It never changes the model.";

        public void Execute(UpdaterData data)
        {
            try { FmcWatch.FromUpdater(_key, data.GetDocument(), data); }
            catch (Exception e) { try { FmcWatch.Fail(_key, e); } catch (Exception) { } }
        }
    }
}
