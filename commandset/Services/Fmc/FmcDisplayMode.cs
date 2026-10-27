using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    public partial class FmcModelEditHandler
    {
        /// <summary>
        /// display_mode (owner 27 Oct: light for navigating, full for rendering). mode navigate: Shaded (style:
        /// consistent for Consistent Colors), model surface patterns hidden; mode render: Realistic, patterns back. Views:
        /// views [ids, names, "active"], default every 3D view. A view under a template is left alone unless templates:
        /// true, which changes the template instead. detail: coarse|medium|fine as well. Materials are not touched.
        /// </summary>
        private JObject DisplayOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            if (name != "display_mode") return FrameOp(doc, name, op, made, created);
            string mode = (op.Value<string>("mode") ?? "").ToLowerInvariant();
            if (mode != "navigate" && mode != "render") throw new InvalidOperationException("display_mode needs mode: navigate or render");
            bool nav = mode == "navigate", templates = op.Value<bool?>("templates") == true;
            DisplayStyle style = (op.Value<string>("style") ?? (nav ? "shaded" : "realistic")).ToLowerInvariant() switch
            {
                "shaded" => DisplayStyle.Shading, "shaded_edges" => DisplayStyle.ShadingWithEdges, "consistent" => DisplayStyle.FlatColors,
                "realistic" => DisplayStyle.Realistic, "realistic_edges" => DisplayStyle.RealisticWithEdges, "hidden" => DisplayStyle.HLR,
                string s => throw new InvalidOperationException($"style {s}: shaded, shaded_edges, consistent, realistic, realistic_edges or hidden"),
            };
            ViewDetailLevel? detail = (op.Value<string>("detail") ?? "").ToLowerInvariant() switch
            {
                "coarse" => ViewDetailLevel.Coarse, "medium" => ViewDetailLevel.Medium, "fine" => ViewDetailLevel.Fine, _ => (ViewDetailLevel?)null,
            };

            var views = new List<View>();
            if (op["views"] is JArray named)
                foreach (JToken t in named)
                    views.Add(string.Equals(t.ToString(), "active", StringComparison.OrdinalIgnoreCase) ? _uidoc?.ActiveView ?? throw new InvalidOperationException("no active view") : ViewOf(doc, t, made));
            else
                views.AddRange(new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().Where(v => !v.IsTemplate));

            var cats = doc.Settings.Categories.Cast<Category>().Where(c => c.CategoryType == CategoryType.Model).Select(c => c.Id).ToList();
            var done = new HashSet<ElementId>();
            var changed = new JArray(); var left = new JArray();
            foreach (View v0 in views)
            {
                View v = v0;
                if (v.ViewTemplateId != ElementId.InvalidElementId)
                {
                    if (!templates) { left.Add($"{v.Name}: uses template {doc.GetElement(v.ViewTemplateId)?.Name} (templates: true changes the template)"); continue; }
                    v = (View)doc.GetElement(v.ViewTemplateId);
                }
                if (!done.Add(v.Id)) continue;
                try
                {
                    v.DisplayStyle = style;
                    if (detail.HasValue) v.DetailLevel = detail.Value;
                    int n = 0;
                    foreach (ElementId c in cats)
                    {
                        if (!v.IsCategoryOverridable(c)) continue;
                        OverrideGraphicSettings g = v.GetCategoryOverrides(c);
                        if (g.IsSurfaceForegroundPatternVisible == !nav && g.IsSurfaceBackgroundPatternVisible == !nav) continue;
                        g.SetSurfaceForegroundPatternVisible(!nav); g.SetSurfaceBackgroundPatternVisible(!nav);
                        v.SetCategoryOverrides(c, g); n++;
                    }
                    changed.Add(new JObject { ["view"] = v.Id.Value, ["name"] = v.Name, ["template"] = v.IsTemplate, ["style"] = style.ToString(), ["pattern_categories"] = n });
                }
                catch (Exception e) { left.Add($"{v.Name}: {e.Message}"); }
            }
            return new JObject { ["mode"] = mode, ["changed"] = changed, ["left"] = left.Count > 0 ? left : null };
        }
    }
}
