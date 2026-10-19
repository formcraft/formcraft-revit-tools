using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Navisworks.Api;
using Newtonsoft.Json.Linq;

namespace Formcraft.Navis
{
    /// <summary>
    /// One selection across the apps (docs/PLAN_ENGINEERING_HUB.md, X1). navis_select finds the items a Revit element
    /// became, by its Revit Element ID and source model (the same "Element ID" property the clash results read), then
    /// selects them and zooms to them; with select false it only says what it found (fmc_find). navis_selection reads
    /// the current selection back as Revit ids. Only the selection and the camera change, never the model or the .nwf.
    /// </summary>
    public static class NavisSelection
    {
        /// <summary>The item's own Revit Element ID, or "" (not its ancestors': a match is the element's own node).</summary>
        private static string OwnRevitId(ModelItem item)
        {
            DataProperty p = item.PropertyCategories.FindPropertyByDisplayName("Element ID", "Value");
            if (p == null) return "";
            return p.Value.IsDisplayString ? p.Value.ToDisplayString() : p.Value.IsInt32 ? p.Value.ToInt32().ToString() : p.Value.ToString();
        }

        /// <summary>A model loaded from this Revit file: names match without folders and extensions (.rvt, .nwc).</summary>
        private static bool SameSource(Model m, string source)
        {
            if (string.IsNullOrEmpty(source)) return true;
            string want = Path.GetFileNameWithoutExtension(source);
            foreach (string f in new[] { m.SourceFileName, m.FileName })
            {
                string have = Path.GetFileNameWithoutExtension(f ?? "");
                if (have.Length > 0 && (have.StartsWith(want, StringComparison.OrdinalIgnoreCase) || want.StartsWith(have, StringComparison.OrdinalIgnoreCase))) return true;
            }
            return false;
        }

        public static JObject Select(Document doc, JObject p)
        {
            var wanted = (p["items"] as JArray ?? new JArray()).OfType<JObject>().Take(500).ToList();
            var guids = (p["guids"] as JArray ?? new JArray()).Select(t => t.Value<string>()).Where(s => !string.IsNullOrEmpty(s)).ToList();
            bool select = p.Value<bool?>("select") ?? true;
            bool zoom = p.Value<bool?>("zoom") ?? true;
            var found = new ModelItemCollection();
            var rows = new JArray();
            var missing = new JArray();
            foreach (JObject w in wanted)
            {
                string id = w.Value<string>("revit_id") ?? "";
                string source = w.Value<string>("source") ?? "";
                var models = doc.Models.Where(m => SameSource(m, source)).ToList();
                if (id.Length == 0 || models.Count == 0) { missing.Add(new JObject { ["revit_id"] = id, ["source"] = source, ["why"] = models.Count == 0 ? "no model from that file" : "no id" }); continue; }
                // one search per element, only in its own model; "contains" finds the property whatever its type, the exact
                // id is checked after (12 must not find 123)
                var search = new Search();
                search.Selection.CopyFrom(models.Select(m => m.RootItem));
                search.Locations = SearchLocations.DescendantsAndSelf;
                search.SearchConditions.Add(SearchCondition.HasPropertyByDisplayName("Element ID", "Value").DisplayStringContains(id));
                var hits = search.FindAll(doc, false).Where(i => OwnRevitId(i) == id).ToList();
                // the element's node, not also the geometry under it that repeats the property
                var hitSet = new HashSet<ModelItem>(hits);
                hits = hits.Where(i => !i.Ancestors.Any(a => hitSet.Contains(a))).ToList();
                if (hits.Count == 0) { missing.Add(new JObject { ["revit_id"] = id, ["source"] = source, ["why"] = "not in the model" }); continue; }
                foreach (ModelItem h in hits) { found.Add(h); rows.Add(NavisCommands.Item(h)); }
            }
            // items the identity map already knows by their Navisworks instance GUID
            if (guids.Count > 0)
            {
                var set = new HashSet<string>(guids, StringComparer.OrdinalIgnoreCase);
                foreach (ModelItem i in doc.Models.RootItemDescendantsAndSelf.Where(i => set.Contains(i.InstanceGuid.ToString())))
                {
                    set.Remove(i.InstanceGuid.ToString());
                    found.Add(i); rows.Add(NavisCommands.Item(i));
                }
                foreach (string g in set) missing.Add(new JObject { ["guid"] = g, ["why"] = "not in the model" });
            }
            bool zoomed = false;
            if (select)
            {
                doc.CurrentSelection.CopyFrom(found);
                if (zoom && found.Count > 0)
                {
                    BoundingBox3D box = found.BoundingBox();
                    if (box != null && !box.IsEmpty)
                    {
                        Viewpoint vp = doc.CurrentViewpoint.CreateCopy();
                        vp.ZoomBox(box);
                        doc.CurrentViewpoint.CopyFrom(vp);
                        zoomed = true;
                    }
                }
            }
            return new JObject { ["selected"] = select ? found.Count : 0, ["found"] = rows, ["missing"] = missing, ["zoomed"] = zoomed };
        }

        public static JObject Selection(Document doc, JObject p)
        {
            int limit = Math.Max(1, Math.Min(p.Value<int?>("limit") ?? 500, 5000));
            var items = doc.CurrentSelection.SelectedItems;
            var rows = new JArray();
            var seen = new HashSet<string>();
            foreach (ModelItem i in items)
            {
                JObject o = NavisCommands.Item(i);
                // a selected piece of geometry and its element are one Revit element
                string key = o.Value<string>("revit_id").Length > 0 ? o.Value<string>("revit_id") + "|" + o.Value<string>("source") : o.Value<string>("guid");
                if (!seen.Add(key)) continue;
                rows.Add(o);
                if (rows.Count >= limit) break;
            }
            return new JObject { ["count"] = items.Count, ["items"] = rows };
        }
    }
}
