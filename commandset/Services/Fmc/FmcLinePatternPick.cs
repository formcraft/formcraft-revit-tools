using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Which of a family's line patterns a subcategory gets for a requested name (add_subcategory line_pattern,
    /// fmc_generate_bind's dashed Legend Back). Family templates name their patterns differently ("Dash", "Dash 1/16\"",
    /// "Hidden", "Hidden 1/8\""), so the closest one is taken: the exact name, then the shortest name starting with it,
    /// then the shortest name in the same family of patterns (dash, hidden, dashed). "Solid" is Revit's built-in solid
    /// line. Null means the family has nothing like it: the caller keeps solid lines and says so. No Revit types here,
    /// so it is tested outside Revit (tests/linepattern).
    /// </summary>
    public static class FmcLinePatternPick
    {
        public const string Solid = "Solid";

        private static readonly string[][] Kin =
        {
            new[] { "dash", "dashed", "hidden" },
            new[] { "dot", "dotted" },
            new[] { "center", "centre", "centerline", "centreline" },
        };

        public static string Pick(string want, IEnumerable<string> available)
        {
            if (string.IsNullOrWhiteSpace(want)) return null;
            string w = want.Trim();
            if (string.Equals(w, Solid, StringComparison.OrdinalIgnoreCase)) return Solid;
            var names = (available ?? Enumerable.Empty<string>()).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().ToList();
            string exact = names.FirstOrDefault(n => string.Equals(n.Trim(), w, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            string starts = Shortest(names.Where(n => n.Trim().StartsWith(w, StringComparison.OrdinalIgnoreCase)));
            if (starts != null) return starts;
            string head = FirstWord(w);
            string[] kin = Kin.FirstOrDefault(k => k.Contains(head)) ?? new[] { head };
            return Shortest(names.Where(n => kin.Contains(FirstWord(n))));
        }

        private static string FirstWord(string s)
        {
            string t = s.Trim().ToLowerInvariant();
            int i = 0;
            while (i < t.Length && char.IsLetter(t[i])) i++;
            return t.Substring(0, i);
        }

        private static string Shortest(IEnumerable<string> names) =>
            names.OrderBy(n => n.Length).ThenBy(n => n, StringComparer.OrdinalIgnoreCase).FirstOrDefault();
    }
}
