using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>
    /// fmc_change_feed_read (F19): what changed in one open model, who changed it and when. Read-only, no transaction.
    /// Three parts: the session journal (FmcChangeFeed, paged with after_seq); the document's version (Revit's
    /// DocumentVersion: GUID and number of saves); and, with since_version, the elements created, modified and deleted
    /// since that version (Document.GetChangedElements), each with its category, name and, in a workshared model, the
    /// creator, last changed by and owner Revit keeps for the worksharing tooltip. It never syncs, saves, reloads latest,
    /// relinquishes or checks anything out, and it never opens a file: the document must already be open.
    /// </summary>
    public class FmcChangeFeedReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const int DefaultElementLimit = 200;
        public const int MaxElementLimit = 1000;

        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft model changes";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_change_feed_read needs document. Refusing to use the active document.");
                                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    long afterSeq = Math.Max(0, Parameters.Value<long?>("after_seq") ?? 0);
                    int limit = Math.Max(1, Math.Min(FeedJournal.MaxPage, Parameters.Value<int?>("limit") ?? 200));
                    int elementLimit = Math.Max(1, Math.Min(MaxElementLimit, Parameters.Value<int?>("element_limit") ?? DefaultElementLimit));
                    string sinceVersion = (Parameters.Value<string>("since_version") ?? "").Trim();
                    var notes = new JArray();

                    string logDir = ChangeFeedLog.DefaultDir();
                    var options = ChangeFeedOptions.Load();
                    // Read only: Query/ReadWindow never write or prune. Memory is used when logging to disk is off.
                    FeedPage page = ChangeFeedLog.Query(logDir, FmcChangeFeed.Key(doc), afterSeq, limit);
                    if (!options.Logging)
                    {
                        FeedPage mem = TryPluginMemory(FmcChangeFeed.Key(doc), afterSeq, limit);
                        if (mem != null) page = MergePages(page, mem, afterSeq, limit);
                        notes.Add(ChangeFeedOptions.DisabledNote());
                    }
                    if (page.Gap) notes.Add($"Some journal entries after sequence {afterSeq} could not be read from the log.");
                    var since = ChangeFeedLog.ListeningSince(logDir);
                    var journal = new JObject
                    {
                        ["listening"] = ChangeFeedLog.IsListening(logDir) || PluginHooked(),
                        ["logging"] = options.Logging,
                        ["retention_months"] = options.RetentionMonths,
                        ["since"] = since.HasValue ? since.Value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") : "",
                        ["log_dir"] = logDir,
                        ["last_seq"] = page.LastSeq,
                        ["next_after_seq"] = page.NextAfterSeq,
                        ["more"] = page.More,
                        ["gap"] = page.Gap,
                        ["dropped"] = page.Dropped,
                        ["entries"] = new JArray(page.Entries.Select(e => ChangeFeedLog.EntryJson(e))),
                    };

                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["applied"] = false,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["worksharing_touched"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["workshared"] = doc.IsWorkshared,
                        ["user"] = app.Application.Username ?? "",
                        ["version"] = VersionOf(doc),
                        ["journal"] = journal,
                        ["diff"] = sinceVersion.Length > 0 ? Diff(doc, sinceVersion, elementLimit, notes) : JValue.CreateNull(),
                        ["notes"] = notes,
                    };
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _done.Set();
            }
        }

        /// <summary>The plugin's in-memory journal, reached by reflection so this command set never writes a file when logging is off. Null when the plugin is not loaded (offline tests).</summary>
        private static FeedPage TryPluginMemory(string document, long afterSeq, int limit)
        {
            try
            {
                var t = Type.GetType("revit_mcp_plugin.Fmc.ChangeFeedSession, RevitMCPPlugin")
                    ?? Type.GetType("revit_mcp_plugin.Fmc.ChangeFeedSession, revit_mcp_plugin");
                var m = t?.GetMethod("QueryMemory", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                if (m == null) return null;
                return m.Invoke(null, new object[] { document, afterSeq, limit }) as FeedPage;
            }
            catch (Exception) { return null; }
        }

        private static bool PluginHooked()
        {
            try
            {
                var t = Type.GetType("revit_mcp_plugin.Fmc.ChangeFeedSession, RevitMCPPlugin")
                    ?? Type.GetType("revit_mcp_plugin.Fmc.ChangeFeedSession, revit_mcp_plugin");
                var p = t?.GetProperty("Hooked", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                return p != null && p.GetValue(null) is bool b && b;
            }
            catch (Exception) { return false; }
        }

        /// <summary>Union of disk and memory pages, unique by seq, oldest first, still within limit. Read only.</summary>
        private static FeedPage MergePages(FeedPage disk, FeedPage memory, long afterSeq, int limit)
        {
            var page = new FeedPage();
            var seen = new System.Collections.Generic.HashSet<long>();
            var all = new System.Collections.Generic.List<FeedEntry>();
            if (disk?.Entries != null) all.AddRange(disk.Entries);
            if (memory?.Entries != null) all.AddRange(memory.Entries);
            all.Sort((a, b) => a.Seq.CompareTo(b.Seq) != 0 ? a.Seq.CompareTo(b.Seq) : a.AtUtc.CompareTo(b.AtUtc));
            int take = Math.Max(1, Math.Min(FeedJournal.MaxPage, limit));
            foreach (var e in all)
            {
                if (e == null || e.Seq <= afterSeq || !seen.Add(e.Seq)) continue;
                if (page.Entries.Count == take) { page.More = true; break; }
                page.Entries.Add(e);
            }
            long last = 0;
            if (disk != null && disk.LastSeq > last) last = disk.LastSeq;
            if (memory != null && memory.LastSeq > last) last = memory.LastSeq;
            page.LastSeq = last;
            page.NextAfterSeq = page.Entries.Count > 0 ? page.Entries[page.Entries.Count - 1].Seq : Math.Max(afterSeq, 0);
            if (disk != null) { page.Gap = page.Gap || disk.Gap; page.Dropped += disk.Dropped; }
            if (memory != null) { page.Gap = page.Gap || memory.Gap; page.Dropped += memory.Dropped; }
            return page;
        }

        private static JObject VersionOf(Document doc)
        {
#if REVIT2023_OR_GREATER
            try
            {
                DocumentVersion v = Document.GetDocumentVersion(doc);
                if (v != null) return new JObject { ["guid"] = v.VersionGUID.ToString("D"), ["saves"] = v.NumberOfSaves };
            }
            catch (Exception) { /* a new unsaved document has no version yet */ }
#endif
            return new JObject { ["guid"] = "", ["saves"] = 0 };
        }

        private static JToken Diff(Document doc, string since, int elementLimit, JArray notes)
        {
#if REVIT2023_OR_GREATER
            if (!Guid.TryParse(since, out Guid baseGuid))
                return new JObject { ["code"] = "FMC-CHANGES-VERSION", ["message"] = $"since_version \"{since}\" is not a version GUID. Pass version.guid from an earlier reply." };
            DocumentDifference d;
            try { d = doc.GetChangedElements(baseGuid); }
            catch (Exception ex)
            {
                return new JObject { ["code"] = "FMC-CHANGES-VERSION", ["message"] = $"Revit doesn't know version {since} in this document ({ex.Message}). It belongs to another model or was saved over." };
            }
            var created = d.GetCreatedElementIds().ToList();
            var modified = d.GetModifiedElementIds().ToList();
            bool deletedAvailable = d.AreDeletedElementIdsAvailable;
            var deleted = deletedAvailable ? d.GetDeletedElementIds().ToList() : new List<ElementId>();
            if (!deletedAvailable) notes.Add("Revit can't list deleted elements for this version range (AreDeletedElementIdsAvailable is false).");
            int left = elementLimit;
            JArray Rows(List<ElementId> ids)
            {
                var rows = new JArray();
                foreach (ElementId id in ids)
                {
                    if (left <= 0) break;
                    rows.Add(Row(doc, id));
                    left--;
                }
                return rows;
            }
            var createdRows = Rows(created);
            var modifiedRows = Rows(modified);
            int listed = createdRows.Count + modifiedRows.Count;
            bool truncated = listed < created.Count + modified.Count;
            if (truncated) notes.Add($"{created.Count + modified.Count - listed} changed elements are counted but not listed (element_limit {elementLimit}).");
            return new JObject
            {
                ["base_version"] = baseGuid.ToString("D"),
                ["counts"] = new JObject { ["created"] = created.Count, ["modified"] = modified.Count, ["deleted"] = deleted.Count },
                ["created"] = createdRows,
                ["modified"] = modifiedRows,
                ["deleted_ids"] = new JArray(deleted.Take(elementLimit).Select(x => x.GetValue())),
                ["deleted_available"] = deletedAvailable,
                ["truncated"] = truncated || deleted.Count > elementLimit,
            };
#else
            notes.Add("Version diffs need Revit 2023 or later.");
            return new JObject { ["code"] = "FMC-CHANGES-VERSION", ["message"] = "Version diffs need Revit 2023 or later." };
#endif
        }

        /// <summary>One changed element: id, category, name and the worksharing tooltip's people. A gone element says so.</summary>
        private static JObject Row(Document doc, ElementId id)
        {
            var row = new JObject { ["id"] = id.GetValue() };
            Element e = null;
            try { e = doc.GetElement(id); } catch (Exception) { }
            if (e == null) { row["exists"] = false; row["reason"] = "not in the document now"; return row; }
            row["exists"] = true;
            row["unique_id"] = e.UniqueId ?? "";
            row["category"] = e.Category?.Name ?? "";
            row["name"] = e.Name ?? "";
            if (doc.IsWorkshared)
            {
                try
                {
                    WorksharingTooltipInfo info = WorksharingUtils.GetWorksharingTooltipInfo(doc, id);
                    row["creator"] = info?.Creator ?? "";
                    row["last_changed_by"] = info?.LastChangedBy ?? "";
                    row["owner"] = info?.Owner ?? "";
                }
                catch (Exception) { row["people"] = "not available for this element"; }
            }
            return row;
        }
    }
}
