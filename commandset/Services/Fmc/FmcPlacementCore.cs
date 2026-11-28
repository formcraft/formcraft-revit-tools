using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Plain rules shared by the grid, level, dimension, placement and tag handlers. No Revit types, so
    /// tests/placementcore runs it without Revit against server/src/fmc/fixtures/placement_cases.json,
    /// the same cases server/src/fmc/datum.test.ts runs on the server's copy (server/src/fmc/datum.ts).
    /// </summary>
    public static class FmcPlacementCore
    {
        /// <summary>
        /// Grid labels. A label ending in digits keeps its prefix and counts up (TX1, TX2, ...; 01, 02, ...); a letter
        /// label with a prefix counts its last letter (GA, GB, ...); numeric counts from the number; alphabetic from the
        /// first letter, past Z as AA, AB. Moved unchanged from CreateGridEventHandler (night test 26 Oct).
        /// </summary>
        public static List<string> GridLabels(int count, string startLabel, string namingStyle)
        {
            var labels = new List<string>();
            startLabel = startLabel ?? "";
            Match m = Regex.Match(startLabel, @"^(.*?)(\d+)$");
            if (m.Success)
            {
                int n = int.Parse(m.Groups[2].Value);
                string digits = m.Groups[2].Value;
                string format = digits.StartsWith("0") ? new string('0', digits.Length) : "0";
                for (int i = 0; i < count; i++) labels.Add(m.Groups[1].Value + (n + i).ToString(format));
                return labels;
            }
            if (namingStyle != "numeric" && startLabel.Length > 1 && char.IsLetter(startLabel[startLabel.Length - 1]))
            {
                string prefix = startLabel.Substring(0, startLabel.Length - 1);
                char last = char.ToUpper(startLabel[startLabel.Length - 1]);
                for (int i = 0; i < count; i++) labels.Add(prefix + AlphabeticLabel(last, i));
                return labels;
            }
            if (namingStyle == "numeric")
            {
                if (!int.TryParse(startLabel, out int start)) start = 1;
                for (int i = 0; i < count; i++) labels.Add((start + i).ToString());
                return labels;
            }
            string upper = startLabel.ToUpper();
            char first = upper.Length > 0 ? upper[0] : 'A';
            if (!char.IsLetter(first)) first = 'A';
            for (int i = 0; i < count; i++) labels.Add(AlphabeticLabel(first, i));
            return labels;
        }

        /// <summary>A, B, ..., Z, AA, AB, ...</summary>
        public static string AlphabeticLabel(char startChar, int offset)
        {
            int index = (startChar - 'A') + offset;
            if (index < 26) return ((char)('A' + index)).ToString();
            string result = "";
            int remaining = index;
            while (remaining >= 0)
            {
                result = (char)('A' + remaining % 26) + result;
                remaining = remaining / 26 - 1;
            }
            return result;
        }

        /// <summary>The old rename rule (A, A1, A2, ...), kept for on_duplicate rename.</summary>
        public static string UniqueName(string baseName, ISet<string> existing)
        {
            string candidate = baseName;
            int counter = 1;
            while (existing.Contains(candidate)) candidate = baseName + counter++;
            return candidate;
        }

        /// <summary>
        /// Names that clash, case-insensitive: with an existing name, or with an earlier name in the same request.
        /// Index of each clashing request row and why.
        /// </summary>
        public static List<KeyValuePair<int, string>> Duplicates(IList<string> requested, IEnumerable<string> existing)
        {
            var have = new HashSet<string>(existing ?? Enumerable.Empty<string>(), StringComparer.OrdinalIgnoreCase);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var clashes = new List<KeyValuePair<int, string>>();
            for (int i = 0; i < requested.Count; i++)
            {
                string name = (requested[i] ?? "").Trim();
                if (name.Length == 0) continue;
                if (have.Contains(name)) clashes.Add(new KeyValuePair<int, string>(i, "exists"));
                else if (!seen.Add(name)) clashes.Add(new KeyValuePair<int, string>(i, "repeated"));
            }
            return clashes;
        }

        /// <summary>A tag that shows nothing: empty, spaces, or Revit's "?" for an empty label. Null (unknown) is not blank.</summary>
        public static bool IsBlankTagText(string text)
        {
            if (text == null) return false;
            string t = Regex.Replace(text, @"\s+", "");
            return t.Length == 0 || Regex.IsMatch(t, @"^\?+$");
        }

        /// <summary>Two points closer than tolerance (mm, plan and height). Used for duplicate placements.</summary>
        public static bool SamePoint(double ax, double ay, double az, double bx, double by, double bz, double toleranceMm)
        {
            double dx = ax - bx, dy = ay - by, dz = az - bz;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz) <= toleranceMm;
        }

        /// <summary>One per-item result row, the shape every placement and tag handler returns in items.</summary>
        public static Dictionary<string, object> Item(int index, string status, long? id = null, string code = null, string reason = null, string name = null)
        {
            var row = new Dictionary<string, object> { ["index"] = index, ["status"] = status };
            if (id.HasValue) row["id"] = id.Value;
            if (!string.IsNullOrEmpty(name)) row["name"] = name;
            if (!string.IsNullOrEmpty(code)) row["code"] = code;
            if (!string.IsNullOrEmpty(reason)) row["reason"] = reason;
            return row;
        }
    }
}
