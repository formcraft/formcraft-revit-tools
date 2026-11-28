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
                FmcChangeFeed.Hook(app);
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    long afterSeq = Math.Max(0, Parameters.Value<long?>("after_seq") ?? 0);
                    int limit = Math.Max(1, Math.Min(FeedJournal.MaxPage, Parameters.Value<int?>("limit") ?? 200));
                    int elementLimit = Math.Max(1, Math.Min(MaxElementLimit, Parameters.Value<int?>("element_limit") ?? DefaultElementLimit));
                    string sinceVersion = (Parameters.Value<string>("since_version") ?? "").Trim();
                    var notes = new JArray();

                    FeedPage page = FmcChangeFeed.Journal.Query(FmcChangeFeed.Key(doc), afterSeq, limit);
                    if (page.Gap) notes.Add($"The session journal keeps the last {FeedJournal.DefaultCap} entries; {page.Dropped} older entries were dropped before they were read. Read the version diff for what changed since then.");
                    var journal = new JObject
                    {
                        ["listening"] = FmcChangeFeed.Hooked,
                        ["since"] = FmcChangeFeed.Journal.StartedAtUtc.HasValue ? FmcChangeFeed.Journal.StartedAtUtc.Value.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") : "",
                        ["last_seq"] = page.LastSeq,
                        ["next_after_seq"] = page.NextAfterSeq,
                        ["more"] = page.More,
                        ["gap"] = page.Gap,
                        ["dropped"] = page.Dropped,
                        ["entries"] = new JArray(page.Entries.Select(e => e.ToJson())),
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
