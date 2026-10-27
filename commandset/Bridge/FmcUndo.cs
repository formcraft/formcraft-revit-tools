using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet
{
    /// <summary>
    /// undo_ai_batch (owner 27 Oct: "the undo AI batch is necessary"). Revit's API has no undo list, so this keeps its own
    /// copy from DocumentChanged: every commit, undo and redo, each marked "ai" (a modify_model batch, a script, or any
    /// AI tool's transaction) or "other" (a person's). An undo is only posted when the entries above the wanted batch are
    /// all the AI's, so a person's work is never taken back. When the copy is unsure (a person's grouped command shows
    /// as several entries) it errs towards undoing less, never more: one Revit undo takes the whole cluster of entries
    /// with the same id. Several batches are undone one Revit Undo at a time, each posted on the next Idling after
    /// Revit reports the last one. A sync with central or closing the model clears Revit's list, and this copy too.
    /// </summary>
    public static class FmcUndo
    {
        public sealed class Entry
        {
            public string Id = "", Label = "", Kind = "other";
            public DateTime At = DateTime.Now;
            public JArray Created = new JArray();
            public string Batch => Id.Split('.')[0];
        }

        private static readonly object L = new object();
        private static readonly Dictionary<string, List<Entry>> Undos = new Dictionary<string, List<Entry>>();
        private static readonly Dictionary<string, List<Entry>> Redos = new Dictionary<string, List<Entry>>();
        private static bool _hooked;
        private static string _batch, _batchLabel = "";
        private static bool _inGroup;
        private static int _afterN, _seq;

        // the running plan: undo these entry ids, top first
        private static string _planDoc;
        private static readonly List<string> _planLeft = new List<string>();
        private static readonly List<string> _planDone = new List<string>();
        private static string _planStop = "";
        private static bool _awaiting;
        private static long _postedAt;

        public static string Key(Document d) => string.IsNullOrEmpty(d.PathName) ? d.Title : d.PathName;

        /// <summary>Call on Revit's API thread before the AI's first change (any handler's Execute).</summary>
        public static void Hook(UIApplication app)
        {
            if (_hooked || app == null) return;
            try
            {
                app.Application.DocumentChanged += OnChanged;
                app.Application.DocumentClosing += (s, e) => Clear(e.Document);
                app.Application.DocumentSynchronizedWithCentral += (s, e) => Clear(e.Document);
                app.Idling += OnIdling;
                _hooked = true;
            }
            catch (Exception) { /* without the hooks undo_ai_batch says it can't tell what is on top */ }
        }

        public static bool Hooked => _hooked;

        private static void Clear(Document d)
        {
            if (d == null) return;
            lock (L) { Undos.Remove(Key(d)); Redos.Remove(Key(d)); if (_planDoc == Key(d)) EndPlan("the model was closed or synced"); }
        }

        private static string NewId() => (Interlocked.Increment(ref _seq) % 0xFFFF).ToString("x4") + DateTime.Now.ToString("ss");

        /// <summary>
        /// A modify_model batch or a script starts: its inner commits are one entry, pushed by <see cref="Committed"/>.
        /// "{id}" in the label becomes the batch id; <see cref="Label"/> is the result (the name Revit's Undo shows).
        /// </summary>
        public static string Begin(string label)
        {
            lock (L) { _batch = NewId(); _batchLabel = (label ?? "").Replace("{id}", _batch); _inGroup = true; _afterN = 0; return _batch; }
        }

        /// <summary>The running batch's label, with its id.</summary>
        public static string Label => _batchLabel;

        /// <summary>The batch's group ended: kept (assimilated or committed) or rolled back.</summary>
        public static void Committed(Document doc, bool kept, IEnumerable<long> created = null)
        {
            lock (L)
            {
                _inGroup = false;
                if (!kept || _batch == null || doc == null) return;
                Push(Key(doc), new Entry { Id = _batch, Label = _batchLabel, Kind = "ai", Created = new JArray((created ?? Enumerable.Empty<long>()).Take(50)) });
            }
        }

        /// <summary>The batch's call is over (after its family saves and loads, which are entries of their own).</summary>
        public static void Close() { lock (L) { _batch = null; _inGroup = false; } }

        private static List<Entry> Of(Dictionary<string, List<Entry>> d, string key)
        {
            if (!d.TryGetValue(key, out var l)) d[key] = l = new List<Entry>();
            return l;
        }

        private static void Push(string key, Entry e)
        {
            var u = Of(Undos, key);
            u.Add(e);
            if (u.Count > 400) u.RemoveRange(0, u.Count - 400);
            Of(Redos, key).Clear();
        }

        /// <summary>Moves the top cluster (entries sharing the top id) from one list to the other; returns its id.</summary>
        private static string Move(List<Entry> from, List<Entry> to)
        {
            if (from.Count == 0) return null;
            string id = from[from.Count - 1].Id;
            var cluster = new List<Entry>();
            while (from.Count > 0 && from[from.Count - 1].Id == id) { cluster.Insert(0, from[from.Count - 1]); from.RemoveAt(from.Count - 1); }
            to.AddRange(cluster);
            return id;
        }

        private static void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                Document doc = e.GetDocument();
                string key = Key(doc);
                lock (L)
                {
                    switch (e.Operation)
                    {
                        case UndoOperation.TransactionCommitted:
                        {
                            if (_inGroup) return;
                            string label = string.Join(", ", e.GetTransactionNames());
                            var created = new JArray(e.GetAddedElementIds().Take(50).Select(x => x.Value));
                            Entry en = _batch != null ? new Entry { Id = $"{_batch}.{++_afterN}", Kind = "ai", Label = label, Created = created }
                                : FmcAiJob.Executing ? new Entry { Id = FmcAiJob.Current.Length > 0 ? "job" + FmcAiJob.Current : NewId(), Kind = "ai", Label = label, Created = created }
                                : new Entry { Id = NewId(), Kind = "other", Label = label };
                            Push(key, en);
                            break;
                        }
                        case UndoOperation.TransactionUndone:
                        {
                            string id = Move(Of(Undos, key), Of(Redos, key));
                            if (_planDoc == key && _awaiting)
                            {
                                _awaiting = false;
                                if (id != null && _planLeft.Count > 0 && id == _planLeft[0]) { _planLeft.RemoveAt(0); _planDone.Add(id); if (_planLeft.Count == 0) EndPlan(""); }
                                else EndPlan($"Revit undid {id ?? "something"} instead of {(_planLeft.Count > 0 ? _planLeft[0] : "?")}: stopped");
                            }
                            break;
                        }
                        case UndoOperation.TransactionRedone:
                            if (Move(Of(Redos, key), Of(Undos, key)) == null) Of(Undos, key).Add(new Entry { Id = NewId(), Label = string.Join(", ", e.GetTransactionNames()) });
                            break;
                    }
                }
            }
            catch (Exception) { /* the copy is best effort; a gap only makes undo_ai_batch refuse */ }
        }

        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            lock (L)
            {
                if (_planDoc == null) return;
                if (_awaiting)
                {
                    if (Environment.TickCount64 - _postedAt > 20000) EndPlan("Revit didn't run the Undo within 20 s (a dialog or an edit mode open?)");
                    return;
                }
                if (_planLeft.Count > 0 && sender is UIApplication app) PostNext(app);
            }
        }

        private static void EndPlan(string why) { _planStop = why ?? ""; _planDoc = null; _planLeft.Clear(); _awaiting = false; }

        private static void PostNext(UIApplication app)
        {
            var u = Of(Undos, _planDoc);
            if (u.Count == 0 || u[u.Count - 1].Id != _planLeft[0]) { EndPlan("the undo list changed (a person worked in Revit): stopped"); return; }
            try { app.PostCommand(RevitCommandId.LookupPostableCommandId(PostableCommand.Undo)); _awaiting = true; _postedAt = Environment.TickCount64; }
            catch (Exception ex) { EndPlan("Revit refused the Undo: " + ex.Message); }
        }

        /// <summary>Plans and posts the undo of the top AI batches (count) or down to batch_id. Refuses a person's work.</summary>
        public static JObject Undo(UIApplication app, Document doc, string batchId, int count)
        {
            lock (L)
            {
                if (!_hooked) throw new InvalidOperationException("The undo list is followed from the AI's first change after Revit starts; nothing is known yet");
                if (_planDoc != null) throw new InvalidOperationException("An undo is still running: check with undo_ai_batch status");
                if (app.ActiveUIDocument?.Document == null || !app.ActiveUIDocument.Document.Equals(doc)) throw new InvalidOperationException($"Revit undoes in the active model: make {doc.Title} the active window first");
                if (doc.IsModifiable) throw new InvalidOperationException("Revit is in the middle of an edit");
                var u = Of(Undos, Key(doc));
                if (u.Count == 0) throw new InvalidOperationException("Nothing the AI did is on Revit's undo list (a sync, a close or a person's undo cleared it)");
                // clusters from the top: (id, entries)
                var clusters = new List<List<Entry>>();
                for (int i = u.Count - 1; i >= 0; i--)
                {
                    if (clusters.Count > 0 && clusters[clusters.Count - 1][0].Id == u[i].Id) clusters[clusters.Count - 1].Add(u[i]);
                    else clusters.Add(new List<Entry> { u[i] });
                }
                var plan = new List<List<Entry>>();
                var batches = new List<string>();
                foreach (var c in clusters)
                {
                    Entry top = c[0];
                    if (string.IsNullOrEmpty(batchId) && !batches.Contains(top.Batch) && batches.Count >= Math.Max(1, count)) break;
                    if (top.Kind != "ai")
                        throw new InvalidOperationException($"A person's change is above {(string.IsNullOrEmpty(batchId) ? "the AI's last batch" : "batch " + batchId)}: \"{top.Label}\" ({top.At:HH:mm}). " +
                            "The AI never undoes a person's work: they can undo it themselves, or leave the batch and fix it with a new one.");
                    plan.Add(c);
                    if (!batches.Contains(top.Batch)) batches.Add(top.Batch);
                    if (!string.IsNullOrEmpty(batchId) && top.Id == batchId) break;
                }
                if (!string.IsNullOrEmpty(batchId) && !plan.Any(c => c[0].Id == batchId))
                    throw new InvalidOperationException($"Batch {batchId} isn't on Revit's undo list for {doc.Title} (see undo_ai_batch status)");
                _planDoc = Key(doc); _planLeft.Clear(); _planDone.Clear(); _planStop = "";
                _planLeft.AddRange(plan.Select(c => c[0].Id));
                PostNext(app);
                return new JObject
                {
                    ["posted"] = _planDoc != null, ["stopped"] = _planStop.Length > 0 ? _planStop : null,
                    ["undoing"] = new JArray(plan.Select(c => new JObject { ["id"] = c[0].Id, ["label"] = c[0].Label, ["at"] = c[0].At.ToString("HH:mm:ss") })),
                };
            }
        }

        /// <summary>Redo of the AI batch the last undo took back, when nothing was committed since.</summary>
        public static JObject Redo(UIApplication app, Document doc)
        {
            lock (L)
            {
                var r = Of(Redos, Key(doc));
                if (r.Count == 0) throw new InvalidOperationException("Nothing to redo");
                Entry top = r[r.Count - 1];
                if (top.Kind != "ai") throw new InvalidOperationException($"The next redo is a person's change (\"{top.Label}\"), not the AI's");
                app.PostCommand(RevitCommandId.LookupPostableCommandId(PostableCommand.Redo));
                return new JObject { ["posted"] = true, ["redoing"] = top.Id, ["label"] = top.Label };
            }
        }

        public static JObject Status(Document doc)
        {
            lock (L)
            {
                JObject Row(Entry e) => new JObject { ["id"] = e.Id, ["kind"] = e.Kind, ["label"] = e.Label, ["at"] = e.At.ToString("HH:mm:ss"), ["created"] = e.Created.Count > 0 ? e.Created : null };
                var u = Of(Undos, Key(doc));
                var r = Of(Redos, Key(doc));
                return new JObject
                {
                    ["document"] = doc.Title, ["followed"] = _hooked,
                    ["top_is_ai"] = u.Count > 0 && u[u.Count - 1].Kind == "ai",
                    ["undo_list"] = new JArray(Enumerable.Reverse(u).Take(15).Select(Row)),
                    ["redo_list"] = new JArray(Enumerable.Reverse(r).Take(5).Select(Row)),
                    ["undo_running"] = _planDoc != null,
                    ["left"] = new JArray(_planLeft), ["done"] = new JArray(_planDone),
                    ["stopped"] = _planStop.Length > 0 ? _planStop : null,
                };
            }
        }
    }
}

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>fmc_undo / fmc_undo_status: undo_ai_batch's Revit side (see <see cref="FmcUndo"/>).</summary>
    public class FmcUndoHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft undo";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                FmcBusy.Hook(app); FmcUndo.Hook(app);
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open");
                switch (Parameters.Value<string>("action") ?? "status")
                {
                    case "undo": Result = FmcUndo.Undo(app, doc, Parameters.Value<string>("batch_id"), Parameters.Value<int?>("count") ?? 1); break;
                    case "redo": Result = FmcUndo.Redo(app, doc); break;
                    default: Result = FmcUndo.Status(doc); break;
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }
}
