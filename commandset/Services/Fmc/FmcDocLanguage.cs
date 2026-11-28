using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// N064 (L001 build plan): the recipe-language ops the generator recipe (FMC_E_EQ_Generator_Diesel_Standby, 6 Nov
    /// repair) is written in. Ported from the formcraft plugin's FmcDocOps / FmcDocKit (5 Nov 2026). The server expands
    /// envelope and visibility_tier before it sends (server/src/fmc/recipelang.ts); these handlers do the same for a caller
    /// that sends them as written. set_line_weight always comes here.
    /// </summary>
    public static class FmcDocLanguage
    {
        /// <summary>set_line_weight: pens (and line colour) of an existing subcategory, the FAM-044 repair path.</summary>
        public static (string, string) SetLineWeight(Document doc, JObject op)
        {
            Category sub = FmcDocLod.Subcategory(doc, op.Value<string>("name"));
            var changed = new List<string>();
            int? proj = op.Value<int?>("projection"), cut = op.Value<int?>("cut");
            if (proj.HasValue && sub.GetLineWeight(GraphicsStyleType.Projection) != proj.Value) { sub.SetLineWeight(proj.Value, GraphicsStyleType.Projection); changed.Add("projection pen " + proj); }
            if (cut.HasValue)
            {
                try { if (sub.GetLineWeight(GraphicsStyleType.Cut) != cut.Value) { sub.SetLineWeight(cut.Value, GraphicsStyleType.Cut); changed.Add("cut pen " + cut); } }
                catch (Exception) { changed.Add("warning: this category has no cut pen, so cut " + cut + " isn't set"); }
            }
            if (op["color"] is JArray rgb && rgb.Count == 3)
            {
                var want = new Color((byte)rgb[0].Value<int>(), (byte)rgb[1].Value<int>(), (byte)rgb[2].Value<int>());
                Color has = sub.LineColor;
                if (has == null || !has.IsValid || has.Red != want.Red || has.Green != want.Green || has.Blue != want.Blue) { sub.LineColor = want; changed.Add("colour"); }
            }
            return changed.Count == 0 ? ("skip", "") : ("update", string.Join(", ", changed));
        }

        private static readonly Dictionary<string, bool[]> Tiers = new Dictionary<string, bool[]>
        {
            ["envelope"] = new[] { true, false, false }, ["clearance"] = new[] { true, true, false }, ["body"] = new[] { false, true, true },
            ["medium"] = new[] { false, true, false }, ["fine"] = new[] { false, false, true }, ["all"] = new[] { true, true, true },
        };

        /// <summary>visibility_tier: one Coarse / Medium / Fine setting for many solids (each as set_visibility).</summary>
        public static (string, string) VisibilityTier(Document doc, JObject op)
        {
            string tier = op.Value<string>("tier");
            bool[] t = tier != null && Tiers.TryGetValue(tier, out var x) ? x : null;
            var parts = new List<(string, string)>();
            foreach (string solid in (op["solids"] as JArray ?? new JArray()).Select(s => s.ToString()))
            {
                var v = new JObject { ["name"] = solid };
                string[] keys = { "coarse", "medium", "fine" };
                for (int k = 0; k < 3; k++) { if (op[keys[k]] != null) v[keys[k]] = op.Value<bool>(keys[k]); else if (t != null) v[keys[k]] = t[k]; }
                var r = FmcDocGeometry.Visibility(doc, v);
                parts.Add((r.Item1, r.Item1 == "skip" ? "" : solid + ": " + r.Item2));
            }
            return Merge(parts);
        }

        /// <summary>envelope: the Coarse box between four planes, on its subcategory (FAM-044 outline pens), Coarse only.</summary>
        public static (string, string) Envelope(Document doc, JObject op)
        {
            string name = op.Value<string>("name"), sub = op.Value<string>("subcategory") ?? "Coarse Envelope";
            var parts = new List<(string, string)>
            {
                FmcDocLod.AddSubcategory(doc, new JObject { ["name"] = sub, ["color"] = new JArray(0, 0, 0), ["line_weight_projection"] = 3, ["line_weight_cut"] = 4 }),
            };
            var box = new JObject { ["name"] = name, ["rect"] = op["rect"], ["start"] = op["start"] ?? 0, ["end"] = op["end"] ?? 1000 };
            if (op["start_plane"] != null) box["start_plane"] = op["start_plane"];
            if (op["end_plane"] != null) box["end_plane"] = op["end_plane"];
            parts.Add(FmcDocGeometry.Extrusion(doc, box, false));
            parts.Add(FmcDocLod.SetSubcategory(doc, new JObject { ["name"] = name, ["subcategory"] = sub }));
            parts.Add(FmcDocGeometry.Visibility(doc, new JObject { ["name"] = name, ["coarse"] = true, ["medium"] = false, ["fine"] = false }));
            return Merge(parts);
        }

        /// <summary>Joins the answers of several sub-steps into one create / update / skip.</summary>
        private static (string, string) Merge(List<(string Result, string Detail)> parts)
        {
            string result = parts.Any(p => p.Result == "create") ? "create" : parts.Any(p => p.Result == "update") ? "update" : "skip";
            return (result, string.Join("; ", parts.Where(p => !string.IsNullOrEmpty(p.Detail)).Select(p => p.Detail)));
        }
    }
}
