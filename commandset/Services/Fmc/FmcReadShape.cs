using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Pure helpers shared by the read tools (no Revit API, so the offline tests compile this file as is).
    /// VE-4 / MQ-3: category names that do not parse are refused, never silently dropped, and a requested
    /// filter never falls back to "all categories". GSE-3: a capped list always says how many there were.
    /// </summary>
    public static class FmcReadShape
    {
        public const string BadCategoryCode = "[FMC-BAD-CATEGORY]";

        public sealed class NameSplit<T> where T : struct
        {
            public List<T> Parsed { get; } = new List<T>();
            public List<string> Applied { get; } = new List<string>();
            public List<string> Unknown { get; } = new List<string>();
        }

        /// <summary>
        /// Splits names into defined enum members and unknown tokens. Only exact, defined member names are
        /// accepted (case-sensitive): numeric strings such as "-2000011" and friendly names such as "Walls" are unknown.
        /// Duplicates are kept once.
        /// </summary>
        public static NameSplit<T> SplitEnumNames<T>(IEnumerable<string> names) where T : struct
        {
            if (!typeof(T).IsEnum) throw new ArgumentException("T must be an enum");
            var split = new NameSplit<T>();
            if (names == null) return split;
            var definedNames = new HashSet<string>(Enum.GetNames(typeof(T)), StringComparer.Ordinal);
            foreach (var raw in names)
            {
                var name = raw?.Trim() ?? "";
                if (name.Length > 0 && definedNames.Contains(name) && Enum.TryParse(name, false, out T value))
                {
                    if (!split.Applied.Contains(name))
                    {
                        split.Applied.Add(name);
                        split.Parsed.Add(value);
                    }
                }
                else if (!split.Unknown.Contains(raw ?? ""))
                {
                    split.Unknown.Add(raw ?? "");
                }
            }
            return split;
        }

        /// <summary>The refusal text for unknown category names. Names the tokens that did not parse.</summary>
        public static string UnknownCategoryMessage(string what, IEnumerable<string> unknown)
        {
            var list = string.Join(", ", (unknown ?? Enumerable.Empty<string>()).Select(u => "\"" + u + "\""));
            return $"{BadCategoryCode} {what}: unknown category name(s) {list}. Use BuiltInCategory names such as \"OST_Walls\" or \"OST_Doors\" (not \"Walls\"). Nothing was read; the filter was not widened to all categories.";
        }

        /// <summary>Throws the FMC-BAD-CATEGORY refusal if any requested name is unknown.</summary>
        public static NameSplit<T> RequireKnownNames<T>(string what, IEnumerable<string> names) where T : struct
        {
            var split = SplitEnumNames<T>(names);
            if (split.Unknown.Count > 0)
                throw new ArgumentException(UnknownCategoryMessage(what, split.Unknown));
            return split;
        }

        public sealed class Page<TItem>
        {
            /// <summary>How many items there were before the cap.</summary>
            public int Count { get; set; }
            /// <summary>The cap that was applied.</summary>
            public int Limit { get; set; }
            /// <summary>True when the cap hid some items.</summary>
            public bool Truncated { get; set; }
            public List<TItem> Items { get; set; } = new List<TItem>();
        }

        /// <summary>Caps a list. A missing, zero or negative limit means defaultLimit.</summary>
        public static Page<TItem> Cap<TItem>(IList<TItem> all, int? limit, int defaultLimit = 100)
        {
            all = all ?? new List<TItem>();
            int cap = limit.HasValue && limit.Value > 0 ? limit.Value : defaultLimit;
            return new Page<TItem>
            {
                Count = all.Count,
                Limit = cap,
                Truncated = all.Count > cap,
                Items = all.Take(cap).ToList(),
            };
        }
    }
}
