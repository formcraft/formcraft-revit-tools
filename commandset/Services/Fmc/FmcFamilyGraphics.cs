using System;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Family line graphics, rule FAM-044 (owner 26 Oct; the same rule as server/src/fmc/familygraphics.ts): lines are
    /// black or dark grey, colour belongs to materials. Outlines and the Coarse envelope pen 3, detail edges pen 2, cut
    /// pen 4; clearance zones, hidden parts and indications pen 1 in their own colour, darkened so it reads.
    /// </summary>
    public static class FmcFamilyGraphics
    {
        public const double MaxLightness = 0.45;

        public static string Role(string name)
        {
            string n = (name ?? "").ToLowerInvariant();
            if (Regex.IsMatch(n, "envelope|outline|silhouette")) return "outline";
            if (Regex.IsMatch(n, "clearance|hidden|swing|zone|approach|operation|light path|indicat|reference|void|service space")) return "light";
            return "detail";
        }

        public static double Lightness(int r, int g, int b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        /// <summary>The add_subcategory op with the rule's colour and pens.</summary>
        public static JObject Apply(string name, JObject op)
        {
            var o = (JObject)op.DeepClone();
            string role = Role(name);
            int[] c = (o["color"] as JArray)?.Select(x => x.Value<int>()).ToArray();
            if (role == "light")
            {
                c = c ?? new[] { 80, 80, 80 };
                double l = Lightness(c[0], c[1], c[2]);
                if (l > MaxLightness) c = c.Select(v => (int)Math.Floor(v * MaxLightness / l)).ToArray();
            }
            else c = new[] { 0, 0, 0 };
            o["color"] = new JArray(c);
            o["line_weight_projection"] = role == "outline" ? 3 : role == "detail" ? 2 : 1;
            o["line_weight_cut"] = role == "light" ? 1 : 4;
            return o;
        }
    }
}
