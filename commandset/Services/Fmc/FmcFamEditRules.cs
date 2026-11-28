using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The Revit-free rules behind the family editor ops (fmc_fam_param, fmc_fam_type, fmc_fam_ref): which ops delete, when a
    /// queue approval is a person's, the template origin planes, rename clashes and the flex matrix's values. Tested in
    /// tests/famedit without Revit; the server has the same lists (server/src/fmc/ops.ts, famedit.ts).
    /// </summary>
    public static class FmcFamEditRules
    {
        public static readonly string[] DeleteOps = { "param_remove", "type_delete", "plane_delete" };
        public static readonly string[] Ops =
        {
            "param_rename", "param_regroup", "param_set_reporting", "param_set_formula", "param_remove",
            "type_rename", "type_flex_matrix", "type_delete", "plane_rename", "plane_move", "plane_delete",
        };
        public static readonly string[] OriginPlanes = { "Center (Left/Right)", "Center (Front/Back)", "Ref. Level" };

        public static bool IsDeleteOp(string op) => DeleteOps.Contains(op ?? "");
        public static bool Handles(string op) => Ops.Contains(op ?? "");
        public static bool IsOriginPlaneName(string name) => OriginPlanes.Contains((name ?? "").Trim());

        /// <summary>
        /// A queue item is a person's yes when the pane marked it approved and named who (the Windows user). The testing
        /// mode's auto-approval writes "auto-approved (…)" and never counts; neither does a used or pending item.
        /// </summary>
        public static bool PersonApproved(string status, string by)
        {
            if (!string.Equals(status, "approved", StringComparison.Ordinal)) return false;
            string who = (by ?? "").Trim();
            return who.Length > 0 && !who.StartsWith("auto", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Why a rename can't go ahead (null: it can). Names compare as Revit does, case-insensitively.</summary>
        public static string RenameProblem(string from, string to, IEnumerable<string> existing)
        {
            string t = (to ?? "").Trim();
            if (t.Length == 0) return "the new name is blank";
            if (string.Equals(from, t, StringComparison.Ordinal)) return "the new name is the same as the old one";
            if (t.IndexOfAny(new[] { '{', '}', '[', ']', '|', ';', '<', '>', '?', '`', '~', ':', '\\' }) >= 0) return "\"" + t + "\" has a character Revit doesn't allow in a name";
            if ((existing ?? Enumerable.Empty<string>()).Any(e => !string.Equals(e, from, StringComparison.Ordinal) && string.Equals(e, t, StringComparison.OrdinalIgnoreCase)))
                return "\"" + t + "\" is already used";
            return null;
        }

        /// <summary>The flex matrix's values: steps values from low to high, both ends included, rounded to 0.001.</summary>
        public static List<double> FlexValues(double low, double high, int steps)
        {
            if (!(high > low)) throw new ArgumentException("high must be above low");
            int n = Math.Max(2, Math.Min(6, steps));
            return Enumerable.Range(0, n).Select(i => Math.Round(low + (high - low) * i / (n - 1), 3)).ToList();
        }

        /// <summary>A type may be deleted only while another stays (Revit needs one).</summary>
        public static bool CanDeleteType(int typeCount) => typeCount > 1;

        /// <summary>Parameters whose formulas use a name (whole word, as Revit reads it): a parameter they use can't be removed.</summary>
        /// A longer parameter name that contains it ("Leaf Width" for "Width") is not a use.
        public static List<string> FormulasUsing(string name, IEnumerable<KeyValuePair<string, string>> formulas)
        {
            var hits = new List<string>();
            if (string.IsNullOrEmpty(name)) return hits;
            var all = (formulas ?? Enumerable.Empty<KeyValuePair<string, string>>()).ToList();
            var longer = all.Select(kv => kv.Key).Where(k => k != name && k.Contains(name)).OrderByDescending(k => k.Length).ToList();
            foreach (var kv in all)
            {
                if (kv.Key == name || string.IsNullOrEmpty(kv.Value)) continue;
                string text = kv.Value;
                foreach (string l in longer) text = text.Replace(l, new string('#', l.Length));
                int at = 0;
                while ((at = text.IndexOf(name, at, StringComparison.Ordinal)) >= 0)
                {
                    bool before = at == 0 || !IsNameChar(text[at - 1]);
                    bool after = at + name.Length >= text.Length || !IsNameChar(text[at + name.Length]);
                    if (before && after) { hits.Add(kv.Key); break; }
                    at += name.Length;
                }
            }
            return hits;
        }

        private static bool IsNameChar(char c) => char.IsLetterOrDigit(c) || c == '_';
    }
}
