using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Check › Changes: reads the lasting JSONL log on this PC. Never syncs, saves or touches a model.</summary>
    public sealed class RevitChangeFeedTools : IChangeFeedTools
    {
        public string LogDir => ChangeFeedLog.DefaultDir();
        public bool LoggingEnabled => ChangeFeedSession.Hooked ? ChangeFeedSession.LoggingEnabled : ChangeFeedOptions.Load().Logging;

        public Task<IReadOnlyList<ChangeFeedRow>> ReadAsync(string document, string category, string user, DateTime? sinceUtc, DateTime? untilUtc, int cap)
        {
            var src = ChangeFeedLog.ReadWindow(LogDir, document ?? "", sinceUtc, untilUtc, Math.Max(1, cap));
            if (!LoggingEnabled && ChangeFeedSession.Hooked)
            {
                var mem = ChangeFeedSession.QueryMemory(document ?? "", 0, FeedJournal.MaxPage);
                if (mem?.Entries != null)
                {
                    var seen = new HashSet<long>();
                    foreach (var e in src) seen.Add(e.Seq);
                    var merged = new List<FeedEntry>(src);
                    foreach (var e in mem.Entries)
                        if (e != null && seen.Add(e.Seq)) merged.Add(e);
                    src = merged;
                }
            }
            var rows = new List<ChangeFeedRow>();
            foreach (var e in src)
            {
                if (!string.IsNullOrEmpty(user) && !string.Equals(e.User, user, StringComparison.OrdinalIgnoreCase)) continue;
                var row = Map(e);
                if (!string.IsNullOrEmpty(category))
                {
                    bool hit = false;
                    foreach (var c in row.Categories)
                        if (string.Equals(c, category, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }
                    if (!hit) continue;
                }
                rows.Add(row);
            }
            return Task.FromResult((IReadOnlyList<ChangeFeedRow>)rows);
        }

        internal static ChangeFeedRow Map(FeedEntry e)
        {
            string what = e.Label ?? "";
            if (e.Kind == "change" || e.Kind == "undo" || e.Kind == "redo")
                what = (string.IsNullOrEmpty(what) ? "(unnamed transaction)" : what) + " (+" + e.Added + " ~" + e.Modified + " -" + e.Deleted + ")";
            else if (e.Kind == "synced") what = "Synced with central " + (e.Label ?? "");
            else if (e.Kind == "saved") what = "Saved " + (e.Label ?? "");
            else if (e.Kind == "opened") what = "Opened " + (e.Label ?? "").Trim();
            else if (e.Kind == "closed") what = "Closed";
            var row = new ChangeFeedRow
            {
                Seq = e.Seq,
                AtUtc = e.AtUtc.Kind == DateTimeKind.Utc ? e.AtUtc : e.AtUtc.ToUniversalTime(),
                AtLocal = string.IsNullOrEmpty(e.AtLocal) ? ChangeFeedLog.LabelTime(e.AtUtc) : e.AtLocal,
                Tz = e.Tz ?? "",
                Document = e.Document ?? "",
                Kind = e.Kind ?? "",
                Label = e.Label ?? "",
                User = e.User ?? "",
                By = e.By ?? "",
                What = what.Trim(),
                TruncateReason = e.TruncateReason ?? "",
            };
            if (e.Elements != null)
            {
                foreach (var el in e.Elements)
                {
                    var d = new ChangeFeedElement
                    {
                        Id = el.Id, Action = el.Action ?? "", Category = el.Category ?? "",
                        Name = el.Name ?? "", UniqueId = el.UniqueId ?? "", TruncateReason = el.TruncateReason ?? "",
                    };
                    if (el.Params != null)
                        foreach (var p in el.Params)
                            d.Params.Add(new ChangeFeedParam(p.Name, p.Before, p.After));
                    row.Elements.Add(d);
                }
            }
            return row;
        }
    }
}
