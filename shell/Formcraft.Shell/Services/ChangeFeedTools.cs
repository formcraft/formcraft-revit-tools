using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One parameter that changed, with the value before and after (either side may be missing).</summary>
    public sealed class ChangeFeedParam
    {
        public ChangeFeedParam(string name, string? before, string? after)
        {
            Name = name;
            Before = before;
            After = after;
        }

        public string Name { get; }
        public string? Before { get; }
        public string? After { get; }
        public string Line =>
            Before != null && After != null ? Name + ": " + Before + " → " + After
            : Before != null ? Name + ": " + Before + " → (removed)"
            : Name + ": (set) " + After;
    }

    /// <summary>One element inside a journal entry: created, modified or deleted, with its key-param diffs.</summary>
    public sealed class ChangeFeedElement
    {
        public long Id { get; set; }
        public string Action { get; set; } = "";
        public string Category { get; set; } = "";
        public string Name { get; set; } = "";
        public string UniqueId { get; set; } = "";
        public List<ChangeFeedParam> Params { get; } = new List<ChangeFeedParam>();
        public string TruncateReason { get; set; } = "";
        public string Title =>
            (string.IsNullOrEmpty(Category) ? "Element" : Category)
            + (string.IsNullOrEmpty(Name) ? "" : ": " + Name)
            + " (" + Id + ")";
    }

    /// <summary>One line of the lasting change log, ready for Check › Changes.</summary>
    public sealed class ChangeFeedRow
    {
        public long Seq { get; set; }
        public DateTime AtUtc { get; set; }
        /// <summary>The time already labeled with its zone, e.g. "2026-11-28 11:28:33 EAT (UTC+3)".</summary>
        public string AtLocal { get; set; } = "";
        public string Tz { get; set; } = "";
        public string Document { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Label { get; set; } = "";
        public string User { get; set; } = "";
        public string By { get; set; } = "";
        public string What { get; set; } = "";
        public List<ChangeFeedElement> Elements { get; } = new List<ChangeFeedElement>();
        public string TruncateReason { get; set; } = "";
        public IEnumerable<string> Categories
        {
            get
            {
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var e in Elements)
                    if (!string.IsNullOrEmpty(e.Category) && seen.Add(e.Category))
                        yield return e.Category;
            }
        }
    }

    /// <summary>Check › Changes (F133): the lasting change log, read-only. Never syncs, saves or touches the model.</summary>
    public interface IChangeFeedTools
    {
        /// <summary>The log folder on this PC (%APPDATA%\Formcraft\ledger\model-changes), for the page to name it.</summary>
        string LogDir { get; }
        /// <summary>False when the kit or %APPDATA%\Formcraft\config.json has turned the lasting log off. The in-memory journal may still be shown.</summary>
        bool LoggingEnabled { get; }
        Task<IReadOnlyList<ChangeFeedRow>> ReadAsync(string document, string category, string user, DateTime? sinceUtc, DateTime? untilUtc, int cap);
    }

    /// <summary>Sample rows for the preview and tests: one morning in EAT, with a before/after Mark change.</summary>
    public sealed class MockChangeFeedTools : IChangeFeedTools
    {
        public bool LoggingEnabled { get; set; } = true;
        public string LogDir { get; set; } = @"C:\Users\test\AppData\Roaming\Formcraft\ledger\model-changes";
        public List<ChangeFeedRow> Rows { get; } = Sample();

        public Task<IReadOnlyList<ChangeFeedRow>> ReadAsync(string document, string category, string user, DateTime? sinceUtc, DateTime? untilUtc, int cap)
        {
            var kept = new List<ChangeFeedRow>();
            foreach (var r in Rows)
            {
                if (!string.IsNullOrEmpty(document) && !r.Document.EndsWith(document, StringComparison.OrdinalIgnoreCase)
                    && r.Document.IndexOf(document, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (!string.IsNullOrEmpty(category) && !ContainsCategory(r, category)) continue;
                if (!string.IsNullOrEmpty(user) && !string.Equals(r.User, user, StringComparison.OrdinalIgnoreCase)) continue;
                if (sinceUtc != null && r.AtUtc < sinceUtc.Value) continue;
                if (untilUtc != null && r.AtUtc > untilUtc.Value) continue;
                kept.Add(r);
                if (kept.Count >= cap) break;
            }
            return Task.FromResult((IReadOnlyList<ChangeFeedRow>)kept);
        }

        private static bool ContainsCategory(ChangeFeedRow r, string category)
        {
            foreach (var c in r.Categories)
                if (string.Equals(c, category, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public static List<ChangeFeedRow> Sample()
        {
            var wall = new ChangeFeedElement { Id = 5, Action = "modified", Category = "Walls", Name = "Basic Wall", UniqueId = "u5" };
            wall.Params.Add(new ChangeFeedParam("Mark", "A1", "A2"));
            wall.Params.Add(new ChangeFeedParam("Comments", "", "Moved to grid 3"));
            var tag = new ChangeFeedElement { Id = 12, Action = "created", Category = "Door Tags", Name = "Tag" };
            tag.Params.Add(new ChangeFeedParam("Type", null, "Door Tag"));
            return new List<ChangeFeedRow>
            {
                new ChangeFeedRow
                {
                    Seq = 3, AtUtc = new DateTime(2026, 11, 28, 8, 30, 0, DateTimeKind.Utc),
                    AtLocal = "2026-11-28 11:30:00 EAT (UTC+3)", Tz = "EAT",
                    Document = "F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", Kind = "change", Label = "Formcraft: tags",
                    User = "emlyn", By = "ai", What = "Formcraft: tags (+1 ~0 -0)",
                }.With(tag),
                new ChangeFeedRow
                {
                    Seq = 2, AtUtc = new DateTime(2026, 11, 28, 8, 20, 0, DateTimeKind.Utc),
                    AtLocal = "2026-11-28 11:20:00 EAT (UTC+3)", Tz = "EAT",
                    Document = "F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", Kind = "synced", Label = "Succeeded",
                    User = "emlyn", By = "person", What = "Synced with central Succeeded",
                },
                new ChangeFeedRow
                {
                    Seq = 1, AtUtc = new DateTime(2026, 11, 28, 8, 10, 0, DateTimeKind.Utc),
                    AtLocal = "2026-11-28 11:10:00 EAT (UTC+3)", Tz = "EAT",
                    Document = "F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", Kind = "change", Label = "Walls",
                    User = "emlyn", By = "person", What = "Walls (+0 ~1 -0)",
                }.With(wall),
            };
        }
    }

    internal static class ChangeFeedRowX
    {
        public static ChangeFeedRow With(this ChangeFeedRow row, ChangeFeedElement e) { row.Elements.Add(e); return row; }
    }
}
