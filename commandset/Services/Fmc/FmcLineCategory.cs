using System.Text.RegularExpressions;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Which categories create_line_based_element may make (see server/src/fmc/linecat.ts, which says the same on the server
    /// and in the AI gate). Walls and ducts for everyone; structure (framing, columns, foundations, trusses) only when the
    /// server marked the call as an admin session (<c>_category_admin</c>, set by the server, never by the caller); anything
    /// else is refused. The category that counts is the type's own: with a typeId the add-in builds what the type is,
    /// whatever the item's category string says.
    /// </summary>
    public static class FmcLineCategory
    {
        public const string Admin = "FMC-LINE-CATEGORY-ADMIN";
        public const string Unknown = "FMC-LINE-CATEGORY-UNKNOWN";

        private static readonly string[] Allowed = { "OST_Walls", "OST_DuctCurves" };
        private static readonly string[] Structure = { "OST_StructuralFraming", "OST_StructuralFramingSystem", "OST_StructuralColumns", "OST_StructuralFoundation", "OST_StructuralTruss" };

        /// <summary>The add-in parses categories with Enum.TryParse(Replace(".", ""), ignoreCase), so a number would parse too; only an OST_ name is a category here.</summary>
        public static string Normalise(string raw)
        {
            string text = (raw ?? "").Replace(".", "").Trim();
            if (!Regex.IsMatch(text, "^OST_[A-Za-z0-9_]+$")) return null;
            foreach (string c in Allowed) if (string.Equals(c, text, StringComparison.OrdinalIgnoreCase)) return c;
            foreach (string c in Structure) if (string.Equals(c, text, StringComparison.OrdinalIgnoreCase)) return c;
            return text;
        }

        /// <summary>Null when the category may be made in this session; else the refusal, code first.</summary>
        public static string Refusal(string raw, bool admin)
        {
            string category = Normalise(raw);
            bool allowed = category != null && Array.IndexOf(Allowed, category) >= 0;
            bool structure = category != null && Array.IndexOf(Structure, category) >= 0;
            if (allowed || (structure && admin)) return null;
            if (structure)
                return $"[{Admin}] {category} is structure: only an admin can make it (create_structural_framing_system is admin-only for the same reason). AI may make {string.Join(" and ", Allowed)} here.";
            return $"[{Unknown}] create_line_based_element makes {string.Join(" and ", Allowed)} only; \"{raw}\" is not one of them.";
        }
    }
}
