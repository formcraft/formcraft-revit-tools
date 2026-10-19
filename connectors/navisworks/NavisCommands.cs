using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Clash;
using Newtonsoft.Json.Linq;
using NwApp = Autodesk.Navisworks.Api.Application;

namespace Formcraft.Navis
{
    /// <summary>
    /// The bridge's commands, run on Navisworks' main thread. Step 1 is read-only: the models, the clash tests and their
    /// results, each clash item with the Revit Element ID and source file it came from (so a fix goes back to the right
    /// model). Running tests, statuses and comments come later, behind the same AI policy and a person's yes.
    /// </summary>
    public static class NavisCommands
    {
        public static JObject Run(string method, JObject p)
        {
            Document doc = NwApp.ActiveDocument ?? throw new InvalidOperationException("No document is open in Navisworks.");
            switch (method)
            {
                case "navis_info": return Info(doc);
                case "navis_clash_tests": return Tests(doc);
                case "navis_clash_results": return Results(doc, p);
                case "navis_search_sets": return SearchSets(doc, p);
                case "navis_append": return NavisFederate.Append(doc, p);
                case "navis_save_as": return NavisFederate.SaveAs(doc, p);
                case "navis_clash_create": return NavisClash.Create(doc, p);
                case "navis_clash_run": return NavisClash.Run(doc, p);
                case "navis_clash_status": return NavisClash.Status(doc, p);
                // X1, one selection: NavisSelection.cs
                case "navis_select": return NavisSelection.Select(doc, p);
                case "navis_selection": return NavisSelection.Selection(doc, p);
                default: throw new ArgumentException($"Unknown command '{method}': use navis_info, navis_clash_tests, navis_clash_results or navis_search_sets");
            }
        }

        /// <summary>
        /// The recipe tree's search sets (T6): one folder (replaced whole on every run, so it always matches the tree), with
        /// a sub-folder per level and department and a search set per room. Each set finds the items whose Revit Comments
        /// contain the tree's mark (FMC:<node>, written by the room build), so a set follows its room through every rebuild.
        /// Only the open document's selection sets change; saving the .nwf is a person's step.
        /// </summary>
        public static JObject SearchSets(Document doc, JObject p)
        {
            string top = p.Value<string>("folder") ?? "FMC Recipe tree";
            var sets = (p["sets"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            bool dry = p.Value<bool?>("dry_run") ?? true;
            var root = new FolderItem { DisplayName = top };
            var folders = new Dictionary<string, FolderItem>();
            int made = 0;
            foreach (JObject s in sets)
            {
                GroupItem parent = root;
                string key = "";
                foreach (string part in (s["path"] as JArray ?? new JArray()).Select(x => x.Value<string>()))
                {
                    key += "/" + part;
                    if (!folders.TryGetValue(key, out FolderItem f))
                    {
                        f = new FolderItem { DisplayName = part };
                        parent.Children.Add(f);
                        folders[key] = f;
                    }
                    parent = f;
                }
                var search = new Search();
                search.Selection.SelectAll();
                search.Locations = SearchLocations.DescendantsAndSelf;
                search.SearchConditions.Add(SearchCondition.HasPropertyByDisplayName("Element", "Comments").DisplayStringContains(s.Value<string>("contains") ?? ""));
                parent.Children.Add(new SelectionSet(search) { DisplayName = s.Value<string>("name") ?? "set" });
                made++;
            }
            SavedItem existing = doc.SelectionSets.RootItem.Children.FirstOrDefault(c => c.DisplayName == top);
            if (!dry)
            {
                if (existing != null) doc.SelectionSets.ReplaceWithCopy(doc.SelectionSets.RootItem.Children.IndexOf(existing), root);
                else doc.SelectionSets.AddCopy(root);
            }
            return new JObject { ["dry_run"] = dry, ["folder"] = top, ["sets"] = made, ["folders"] = folders.Count, ["replaced"] = existing != null };
        }

        private static double Mm(Document doc) => UnitConversion.ScaleFactor(doc.Units, Units.Millimeters);

        public static JObject Info(Document doc)
        {
            var models = new JArray(doc.Models.Select(m => new JObject { ["file"] = m.FileName ?? "", ["source"] = m.SourceFileName ?? "", ["units"] = m.Units.ToString() }));
            int tests = 0;
            try { tests = doc.GetClash().TestsData.Tests.OfType<ClashTest>().Count(); } catch (Exception) { /* no Clash Detective */ }
            return new JObject
            {
                ["title"] = doc.Title ?? "", ["file"] = doc.FileName ?? "", ["clear"] = doc.IsClear, ["units"] = doc.Units.ToString(),
                ["models"] = models, ["clash_tests"] = tests, ["version"] = NwApp.Version.ApiMajor + "." + NwApp.Version.ApiMinor,
            };
        }

        private static IEnumerable<ClashResult> Flatten(GroupItem group)
        {
            foreach (SavedItem child in group.Children)
            {
                if (child is ClashResult r) yield return r;
                else if (child is GroupItem g) foreach (ClashResult inner in Flatten(g)) yield return inner;
            }
        }

        public static JObject Tests(Document doc)
        {
            double mm = Mm(doc);
            var tests = new JArray();
            foreach (ClashTest t in doc.GetClash().TestsData.Tests.OfType<ClashTest>())
            {
                var byStatus = Flatten(t).GroupBy(r => r.Status.ToString()).ToDictionary(g => g.Key, g => g.Count());
                tests.Add(new JObject
                {
                    ["name"] = t.DisplayName, ["type"] = t.TestType.ToString(), ["status"] = t.Status.ToString(),
                    ["tolerance_mm"] = Math.Round(t.Tolerance * mm, 1), ["last_run"] = t.LastRun?.ToString("s") ?? "",
                    ["results"] = byStatus.Values.Sum(), ["by_status"] = JObject.FromObject(byStatus),
                });
            }
            return new JObject { ["title"] = doc.Title ?? "", ["tests"] = tests };
        }

        /// <summary>The item's Revit Element ID (from a Revit NWC) and its source file, from the item or its nearest ancestor.</summary>
        internal static JObject Item(ModelItem item)
        {
            if (item == null) return new JObject();
            string id = "", category = "";
            foreach (ModelItem a in item.AncestorsAndSelf)
            {
                if (id.Length == 0)
                {
                    DataProperty p = a.PropertyCategories.FindPropertyByDisplayName("Element ID", "Value");
                    if (p != null) id = p.Value.IsDisplayString ? p.Value.ToDisplayString() : p.Value.IsInt32 ? p.Value.ToInt32().ToString() : p.Value.ToString();
                }
                if (category.Length == 0)
                {
                    DataProperty c = a.PropertyCategories.FindPropertyByDisplayName("Element", "Category");
                    if (c != null) category = c.Value.IsDisplayString ? c.Value.ToDisplayString() : c.Value.ToString();
                }
                if (id.Length > 0 && category.Length > 0) break;
            }
            Model model = item.AncestorsAndSelf.Where(a => a.HasModel).Select(a => a.Model).FirstOrDefault();
            return new JObject
            {
                ["name"] = item.DisplayName ?? "", ["class"] = item.ClassDisplayName ?? "", ["category"] = category, ["revit_id"] = id,
                ["source"] = model?.SourceFileName ?? model?.FileName ?? "", ["guid"] = item.InstanceGuid.ToString(),
            };
        }

        public static JObject Results(Document doc, JObject p)
        {
            string testName = p.Value<string>("test") ?? "";
            string status = p.Value<string>("status") ?? "";
            int limit = Math.Max(1, Math.Min(p.Value<int?>("limit") ?? 200, 2000));
            ClashTest test = doc.GetClash().TestsData.Tests.OfType<ClashTest>().FirstOrDefault(t => string.Equals(t.DisplayName, testName, StringComparison.OrdinalIgnoreCase))
                ?? throw new ArgumentException($"No clash test named '{testName}'");
            double mm = Mm(doc);
            var all = Flatten(test).Where(r => status.Length == 0 || string.Equals(r.Status.ToString(), status, StringComparison.OrdinalIgnoreCase)).ToList();
            var rows = new JArray();
            foreach (ClashResult r in all.Take(limit))
            {
                Point3D c = r.Center;
                rows.Add(new JObject
                {
                    ["name"] = r.DisplayName, ["status"] = r.Status.ToString(), ["distance_mm"] = Math.Round(r.Distance * mm, 1),
                    ["center_mm"] = new JArray(Math.Round(c.X * mm), Math.Round(c.Y * mm), Math.Round(c.Z * mm)),
                    ["assigned_to"] = r.AssignedTo ?? "", ["description"] = r.Description ?? "",
                    ["item1"] = Item(r.Item1), ["item2"] = Item(r.Item2),
                });
            }
            return new JObject { ["test"] = test.DisplayName, ["total"] = all.Count, ["shown"] = rows.Count, ["results"] = rows };
        }
    }
}
