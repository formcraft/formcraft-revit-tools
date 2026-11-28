using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>
    /// One thing that happened to an open model, as Revit reported it (F19, the NBRB change record and sync feed): a
    /// committed, undone or redone transaction, a save, a sync with central someone else ran, the model closing. The feed
    /// only listens. It never saves, never synchronises, never reloads latest, never relinquishes and never starts a
    /// transaction (CLAUDE.md rule 6, decision 5). This file has no Revit types so it is tested offline (tests/changefeed).
    /// </summary>
    public sealed class FeedEntry
    {
        public long Seq;
        public DateTime AtUtc = DateTime.UtcNow;
        public string Document = "";
        /// <summary>change, undo, redo, saved, synced, closed.</summary>
        public string Kind = "";
        /// <summary>The transaction names Revit gave, or the status of a save or a sync.</summary>
        public string Label = "";
        /// <summary>The Revit user name of the session (Application.Username). Never used to rank people (rule 9).</summary>
        public string User = "";
        /// <summary>ai when a Formcraft AI job was executing, else person.</summary>
        public string By = "person";
        public int Added, Modified, Deleted;
        public List<long> AddedIds = new List<long>();
        public List<long> ModifiedIds = new List<long>();
        public List<long> DeletedIds = new List<long>();
        public List<ElementChange> Elements = new List<ElementChange>();
        public bool ElementsTruncated;
        public string TruncateReason = "";
        /// <summary>The time already labeled with its zone, e.g. "2026-11-28 11:10:00 EAT (UTC+3)".</summary>
        public string AtLocal = "";
        public string Tz = "";

        public JObject ToJson()
        {
            var o = new JObject
            {
                ["seq"] = Seq,
                ["at"] = AtUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                ["document"] = Document,
                ["kind"] = Kind,
                ["label"] = Label,
                ["user"] = User,
                ["by"] = By,
            };
            if (Kind == "change" || Kind == "undo" || Kind == "redo")
            {
                o["added"] = Added;
                o["modified"] = Modified;
                o["deleted"] = Deleted;
                o["added_ids"] = new JArray(AddedIds);
                o["modified_ids"] = new JArray(ModifiedIds);
                o["deleted_ids"] = new JArray(DeletedIds);
                o["ids_truncated"] = AddedIds.Count < Added || ModifiedIds.Count < Modified || DeletedIds.Count < Deleted;
            }
            if (Elements != null && Elements.Count > 0)
                o["elements"] = new JArray(Elements.ConvertAll(e => e.ToJson()));
            if (ElementsTruncated) { o["elements_truncated"] = true; o["truncate_reason"] = TruncateReason ?? ""; }
            if (!string.IsNullOrEmpty(AtLocal)) o["at_local"] = AtLocal;
            if (!string.IsNullOrEmpty(Tz)) o["tz"] = Tz;
            return o;
        }

        public static FeedEntry FromJson(JObject o)
        {
            if (o == null) return null;
            var e = new FeedEntry
            {
                Seq = o["seq"] != null ? (long)o["seq"] : 0,
                Document = (string)o["document"] ?? "",
                Kind = (string)o["kind"] ?? "",
                Label = (string)o["label"] ?? "",
                User = (string)o["user"] ?? "",
                By = (string)o["by"] ?? "",
                Added = o["added"] != null ? (int)o["added"] : 0,
                Modified = o["modified"] != null ? (int)o["modified"] : 0,
                Deleted = o["deleted"] != null ? (int)o["deleted"] : 0,
                ElementsTruncated = o["elements_truncated"] != null && (bool)o["elements_truncated"],
                TruncateReason = (string)o["truncate_reason"] ?? "",
                AtLocal = (string)o["at_local"] ?? "",
                Tz = (string)o["tz"] ?? "",
            };
            DateTime at;
            if (DateTime.TryParse((string)o["at"], System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out at))
                e.AtUtc = at;
            e.AddedIds = Longs(o["added_ids"]);
            e.ModifiedIds = Longs(o["modified_ids"]);
            e.DeletedIds = Longs(o["deleted_ids"]);
            var els = o["elements"] as JArray;
            if (els != null)
                foreach (JToken t in els)
                {
                    var el = ElementChange.FromJson(t as JObject);
                    if (el != null) e.Elements.Add(el);
                }
            return e;
        }

        private static List<long> Longs(JToken t)
        {
            var list = new List<long>();
            var arr = t as JArray;
            if (arr == null) return list;
            foreach (JToken x in arr)
                try { list.Add((long)x); } catch { }
            return list;
        }
    }

    /// <summary>A page of the journal for one document.</summary>
    public sealed class FeedPage
    {
        public List<FeedEntry> Entries = new List<FeedEntry>();
        public long LastSeq;
        public long NextAfterSeq;
        public bool More;
        /// <summary>True when entries after the caller's after_seq were dropped by the cap before they were read.</summary>
        public bool Gap;
        public long Dropped;
    }

    /// <summary>
    /// The session journal: an in-memory ring of entries, oldest dropped past the cap, with a sequence number so a caller
    /// pages forward with after_seq and is told when it fell behind the cap (never a silent gap).
    /// </summary>
    public sealed class FeedJournal
    {
        public const int DefaultCap = 2000;
        public const int IdCap = 50;
        public const int MaxPage = 1000;

        private readonly object _l = new object();
        private readonly LinkedList<FeedEntry> _entries = new LinkedList<FeedEntry>();
        private readonly int _cap;
        private long _seq;
        private long _dropped;
        private long _droppedUpTo;

        public FeedJournal(int cap = DefaultCap) { _cap = Math.Max(1, cap); }

        /// <summary>When the journal began listening (UTC); null until Started is called.</summary>
        public DateTime? StartedAtUtc { get; private set; }

        public void Started(DateTime atUtc) { lock (_l) if (!StartedAtUtc.HasValue) StartedAtUtc = atUtc; }

        public long LastSeq { get { lock (_l) return _seq; } }
        public long Dropped { get { lock (_l) return _dropped; } }
        public int Count { get { lock (_l) return _entries.Count; } }

        public FeedEntry Add(FeedEntry e)
        {
            if (e == null) throw new ArgumentNullException(nameof(e));
            lock (_l)
            {
                e.Seq = ++_seq;
                e.AddedIds = Cap(e.AddedIds, IdCap);
                e.ModifiedIds = Cap(e.ModifiedIds, IdCap);
                e.DeletedIds = Cap(e.DeletedIds, IdCap);
                _entries.AddLast(e);
                while (_entries.Count > _cap)
                {
                    _droppedUpTo = _entries.First.Value.Seq;
                    _entries.RemoveFirst();
                    _dropped++;
                }
                return e;
            }
        }

        /// <summary>
        /// Entries for one document (its path, or its title when it has no path; empty: every document) after afterSeq,
        /// oldest first, at most limit. Gap is set when afterSeq is older than the oldest entry still kept.
        /// </summary>
        public FeedPage Query(string document, long afterSeq, int limit)
        {
            int take = Math.Max(1, Math.Min(MaxPage, limit));
            lock (_l)
            {
                var page = new FeedPage { LastSeq = _seq };
                page.Gap = _dropped > 0 && afterSeq < _droppedUpTo;
                page.Dropped = _dropped;
                foreach (FeedEntry e in _entries)
                {
                    if (e.Seq <= afterSeq) continue;
                    if (!SameDocument(e.Document, document)) continue;
                    if (page.Entries.Count == take) { page.More = true; break; }
                    page.Entries.Add(e);
                }
                page.NextAfterSeq = page.Entries.Count > 0 ? page.Entries[page.Entries.Count - 1].Seq : Math.Max(afterSeq, 0);
                return page;
            }
        }

        /// <summary>A document key (path or title) matches when equal, or when either side's file name without .rvt matches.</summary>
        public static bool SameDocument(string key, string wanted)
        {
            if (string.IsNullOrWhiteSpace(wanted)) return true;
            if (string.IsNullOrWhiteSpace(key)) return false;
            if (string.Equals(key.Trim(), wanted.Trim(), StringComparison.OrdinalIgnoreCase)) return true;
            return string.Equals(BaseName(key), BaseName(wanted), StringComparison.OrdinalIgnoreCase);
        }

        public static string BaseName(string key)
        {
            string s = (key ?? "").Trim().Replace('/', '\\');
            int i = s.LastIndexOf('\\');
            if (i >= 0) s = s.Substring(i + 1);
            return Regex.Replace(s, @"\.(rvt|rfa)$", "", RegexOptions.IgnoreCase);
        }

        /// <summary>Revit's UndoOperation name as the feed's kind.</summary>
        public static string KindOf(string operation)
        {
            switch (operation ?? "")
            {
                case "TransactionCommitted": return "change";
                case "TransactionUndone": return "undo";
                case "TransactionRedone": return "redo";
                case "TransactionGroupRolledBack": return "rolled_back";
                default: return "change";
            }
        }

        public static List<long> Cap(IEnumerable<long> ids, int cap)
        {
            return (ids ?? Enumerable.Empty<long>()).Take(Math.Max(0, cap)).ToList();
        }
    }

    /// <summary>
    /// The read-only contract of the change feed (CLAUDE.md rule 6, decision 5): the API calls its Revit files must never
    /// contain. tests/changefeed and the server tests scan the source with it, so a later edit can't add a sync or a save.
    /// </summary>
    public static class ReadOnlyContract
    {
        public static readonly string[] Forbidden =
        {
            @"SynchronizeWithCentral\s*\(",
            @"\bReloadLatest\s*\(",
            @"RelinquishOwnership\s*\(",
            @"\.Save\s*\(",
            @"\.SaveAs\s*\(",
            @"\.Close\s*\(",
            @"new\s+Transaction\s*\(",
            @"new\s+TransactionGroup\s*\(",
            @"new\s+SubTransaction\s*\(",
            @"\.Commit\s*\(",
            @"\.Assimilate\s*\(",
            @"CheckoutElements\s*\(",
            @"CheckoutWorksets\s*\(",
            @"GetModelUpdatesStatus\s*\(",
            @"PostCommand\s*\(",
            @"OpenDocumentFile\s*\(",
            @"OpenAndActivateDocument\s*\(",
            @"EnableWorksharing\s*\(",
            @"mayOpen\s*:\s*true",
        };

        /// <summary>The forbidden patterns found in one source text, line comments left out (they say what the feed never does).</summary>
        public static List<string> Violations(string source)
        {
            var found = new List<string>();
            string text = StripLineComments(source ?? "");
            foreach (string p in Forbidden)
                if (Regex.IsMatch(text, p)) found.Add(p);
            return found;
        }

        /// <summary>Doc comments describe what the feed never does; they are not calls, so // lines are left out.</summary>
        public static string StripLineComments(string source)
        {
            var lines = (source ?? "").Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                int c = lines[i].IndexOf("//", StringComparison.Ordinal);
                if (c >= 0) lines[i] = lines[i].Substring(0, c);
            }
            return string.Join("\n", lines);
        }
    }
}
