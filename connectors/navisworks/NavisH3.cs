using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Clash;
using Newtonsoft.Json.Linq;

namespace Formcraft.Navis
{
    /// <summary>
    /// Hub step H3 (docs/PLAN_ENGINEERING_HUB.md): federate, clash tests from the kit's clash matrix, clash statuses.
    /// Every command is a dry run unless dry_run is false. The server checks paths and the matrix first (fmc_navis); these
    /// checks are the second line. Only tests named "FMC …" are ever edited, run or removed: a person's test is never touched.
    /// </summary>
    public static class NavisFederate
    {
        private static readonly string[] Blocked = { "02_Shared", "03_Published", "04_Archive", "05_Incoming" };
        private static readonly string[] Appendable = { ".nwc", ".nwd", ".rvt", ".nwf" };

        private static string Stem(string file) => Path.GetFileNameWithoutExtension(file ?? "").ToLowerInvariant();

        /// <summary>navis_append: the given NWC, NWD or RVT files into the open document; a file already in it is skipped.</summary>
        public static JObject Append(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            var loaded = new HashSet<string>(doc.Models.SelectMany(m => new[] { Stem(m.FileName), Stem(m.SourceFileName) }).Where(s => s.Length > 0));
            var rows = new JArray();
            int appended = 0;
            foreach (string file in (p["files"] as JArray ?? new JArray()).Select(x => x.Value<string>() ?? ""))
            {
                string ext = Path.GetExtension(file).ToLowerInvariant();
                string result;
                if (!Appendable.Contains(ext) || ext == ".nwf") result = "refused: not an NWC, NWD or RVT file";
                else if (!File.Exists(file)) result = "missing";
                else if (loaded.Contains(Stem(file))) result = "already in the document";
                else if (dry) result = "would append";
                else
                {
                    result = doc.TryAppendFile(file) ? "appended" : "failed";
                    if (result == "appended") { appended++; loaded.Add(Stem(file)); }
                }
                rows.Add(new JObject { ["file"] = file, ["result"] = result });
            }
            return new JObject { ["dry_run"] = dry, ["files"] = rows, ["appended"] = appended, ["models"] = doc.Models.Count };
        }

        /// <summary>navis_save_as: the federated document as an .nwf, only inside a 01_WIP folder and never over a file.</summary>
        public static JObject SaveAs(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            string file = p.Value<string>("file") ?? "";
            var reasons = new List<string>();
            if (!Path.IsPathRooted(file)) reasons.Add("The path must be absolute");
            if (!string.Equals(Path.GetExtension(file), ".nwf", StringComparison.OrdinalIgnoreCase)) reasons.Add("Only an .nwf is saved");
            var segs = file.Split('\\', '/').Select(s => s.ToLowerInvariant()).ToList();
            if (!segs.Contains("01_wip")) reasons.Add("Only into the project's 01_WIP");
            foreach (string b in Blocked) if (segs.Contains(b.ToLowerInvariant())) reasons.Add("Never into " + b);
            if (File.Exists(file)) reasons.Add("A file is already there: the server archives it first; nothing is overwritten");
            if (doc.Models.Count == 0) reasons.Add("The document has no models");
            if (reasons.Count > 0) return new JObject { ["dry_run"] = dry, ["saved"] = false, ["file"] = file, ["refused"] = new JArray(reasons) };
            if (dry) return new JObject { ["dry_run"] = true, ["would_save"] = file, ["models"] = doc.Models.Count };
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            bool ok = doc.TrySaveFile(file);
            return new JObject { ["dry_run"] = false, ["saved"] = ok, ["file"] = file, ["models"] = doc.Models.Count };
        }
    }

    public static class NavisClash
    {
        public const string Prefix = "FMC ";

        private static double Mm(Document doc) => UnitConversion.ScaleFactor(doc.Units, Units.Millimeters);

        /// <summary>A model's discipline from its container name, as the server's roleOfModel (Manual 4.1).</summary>
        public static string RoleOf(string file)
        {
            Match m = Regex.Match(Path.GetFileNameWithoutExtension(file ?? ""), @"-([A-Z]{1,2})-\d{4}$");
            return m.Success ? m.Groups[1].Value : "BIM";
        }

        /// <summary>The matrix id a Formcraft test carries ("FMC S-M · S vs M" → "S-M"); null for a person's test.</summary>
        public static string IdOf(string name)
        {
            if (name == null || !name.StartsWith(Prefix, StringComparison.Ordinal)) return null;
            string rest = name.Substring(Prefix.Length);
            int sp = rest.IndexOf(' ');
            return sp < 0 ? rest : rest.Substring(0, sp);
        }

        private static IEnumerable<ClashTest> All(Document doc) => doc.GetClash().TestsData.Tests.OfType<ClashTest>();

        private static IEnumerable<ClashResult> Flatten(GroupItem group)
        {
            foreach (SavedItem child in group.Children)
            {
                if (child is ClashResult r) yield return r;
                else if (child is GroupItem g) foreach (ClashResult inner in Flatten(g)) yield return inner;
            }
        }

        private static SavedItem FindSet(GroupItem root, string path)
        {
            string[] parts = path.Split('/').Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
            if (parts.Length == 0) return null;
            if (parts.Length > 1)
            {
                GroupItem at = root;
                for (int k = 0; k < parts.Length; k++)
                {
                    SavedItem next = at.Children.FirstOrDefault(c => c.DisplayName == parts[k]);
                    if (next == null) return null;
                    if (k == parts.Length - 1) return next is GroupItem ? null : next;
                    at = next as GroupItem;
                    if (at == null) return null;
                }
                return null;
            }
            foreach (SavedItem c in root.Children)
            {
                if (!(c is GroupItem) && c.DisplayName == parts[0]) return c;
                if (c is GroupItem g) { SavedItem inner = FindSet(g, parts[0]); if (inner != null) return inner; }
            }
            return null;
        }

        /// <summary>One side of a test: the models of the roles, or a selection or search set. Fills the selection on a real run.</summary>
        private static string Side(Document doc, JObject side, Selection target, out int count)
        {
            count = 0;
            string set = side?.Value<string>("set") ?? "";
            if (set.Length > 0)
            {
                SavedItem found = FindSet(doc.SelectionSets.RootItem, set);
                if (found == null) return $"no selection or search set '{set}'";
                count = 1;
                if (target != null)
                {
                    var sources = new SelectionSourceCollection { doc.SelectionSets.CreateSelectionSource(found) };
                    target.CopyFrom(sources);
                }
                return null;
            }
            var roles = (side?["roles"] as JArray ?? new JArray()).Select(x => x.Value<string>()).ToList();
            var items = new ModelItemCollection();
            foreach (Model m in doc.Models)
                if (roles.Contains(RoleOf(m.SourceFileName)) || roles.Contains(RoleOf(m.FileName))) items.Add(m.RootItem);
            count = items.Count;
            if (count == 0) return "no model for role " + string.Join(", ", roles);
            if (target != null) target.CopyFrom(items);
            return null;
        }

        private static ClashTestType TypeOf(string t)
        {
            switch ((t ?? "hard").ToLowerInvariant())
            {
                case "hard_conservative": return ClashTestType.HardConservative;
                case "clearance": return ClashTestType.Clearance;
                case "duplicates": return ClashTestType.Duplicate;
                default: return ClashTestType.Hard;
            }
        }

        /// <summary>
        /// navis_clash_create: the matrix's tests (already checked by the server) as ClashTests: a new one is added, one this
        /// tool made before (same id) is edited from a copy. remove_stale removes only Formcraft tests the matrix no longer has.
        /// </summary>
        public static JObject Create(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            bool removeStale = p.Value<bool?>("remove_stale") ?? false;
            DocumentClashTests data = doc.GetClash().TestsData;
            double mm = Mm(doc);
            var rows = new JArray();
            var ids = new HashSet<string>();
            foreach (JObject t in (p["tests"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string id = t.Value<string>("id") ?? "", name = t.Value<string>("name") ?? "";
                ids.Add(id);
                if (!name.StartsWith(Prefix, StringComparison.Ordinal) || IdOf(name) != id) { rows.Add(new JObject { ["id"] = id, ["action"] = "refused", ["reason"] = "the name must be 'FMC <id> …'" }); continue; }
                ClashTest existing = All(doc).FirstOrDefault(x => IdOf(x.DisplayName) == id);
                string whyA = Side(doc, t["a"] as JObject, null, out int a);
                string whyB = Side(doc, t["b"] as JObject, null, out int b);
                string why = whyA ?? whyB;
                if (why != null) { rows.Add(new JObject { ["id"] = id, ["name"] = name, ["action"] = "skipped", ["reason"] = why }); continue; }
                string action = existing == null ? "create" : "update";
                if (!dry)
                {
                    ClashTest test = existing == null ? new ClashTest() : (ClashTest)existing.CreateCopy();
                    test.DisplayName = name;
                    test.TestType = TypeOf(t.Value<string>("type"));
                    test.Tolerance = (t.Value<double?>("tolerance_mm") ?? 0) / mm;
                    Side(doc, t["a"] as JObject, test.SelectionA.Selection, out _);
                    Side(doc, t["b"] as JObject, test.SelectionB.Selection, out _);
                    if (existing == null) data.TestsAddCopy(test);
                    else data.TestsEditTestFromCopy(existing, test);
                    action = existing == null ? "created" : "updated";
                }
                rows.Add(new JObject { ["id"] = id, ["name"] = name, ["action"] = action, ["a"] = a, ["b"] = b, ["replaces"] = existing?.DisplayName ?? "" });
            }
            var stale = All(doc).Where(x => IdOf(x.DisplayName) != null && !ids.Contains(IdOf(x.DisplayName))).ToList();
            var staleNames = new JArray(stale.Select(x => x.DisplayName));
            if (!dry && removeStale) foreach (ClashTest s in stale) data.TestsRemove(s);
            int people = All(doc).Count(x => IdOf(x.DisplayName) == null);
            return new JObject
            {
                ["dry_run"] = dry, ["tests"] = rows, ["stale"] = staleNames, ["stale_removed"] = !dry && removeStale,
                ["peoples_tests_left_alone"] = people,
            };
        }

        /// <summary>navis_clash_run: runs the named Formcraft tests (TestsRunTest) and reports their results by status.</summary>
        public static JObject Run(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            DocumentClashTests data = doc.GetClash().TestsData;
            var names = (p["tests"] as JArray ?? new JArray()).Select(x => x.Value<string>() ?? "").ToList();
            var rows = new JArray();
            foreach (string n in names)
            {
                ClashTest test = All(doc).FirstOrDefault(x => x.DisplayName == n);
                if (test == null) { rows.Add(new JObject { ["test"] = n, ["result"] = "missing" }); continue; }
                if (IdOf(test.DisplayName) == null) { rows.Add(new JObject { ["test"] = n, ["result"] = "refused: not a Formcraft test" }); continue; }
                if (dry) { rows.Add(new JObject { ["test"] = n, ["result"] = "would run", ["last_run"] = test.LastRun?.ToString("s") ?? "" }); continue; }
                data.TestsRunTest(test);
                ClashTest after = All(doc).FirstOrDefault(x => x.DisplayName == n) ?? test;
                var byStatus = Flatten(after).GroupBy(r => r.Status.ToString()).ToDictionary(g => g.Key, g => g.Count());
                rows.Add(new JObject
                {
                    ["test"] = n, ["result"] = "ran", ["status"] = after.Status.ToString(), ["last_run"] = after.LastRun?.ToString("s") ?? "",
                    ["results"] = byStatus.Values.Sum(), ["by_status"] = JObject.FromObject(byStatus),
                });
            }
            return new JObject { ["dry_run"] = dry, ["tests"] = rows };
        }

        private static CommentStatus CommentStatusOf(ClashResultStatus s) =>
            s == ClashResultStatus.Approved ? CommentStatus.Approved : s == ClashResultStatus.Resolved ? CommentStatus.Resolved : CommentStatus.Active;

        /// <summary>
        /// navis_clash_status: a new status and a comment on the clash results a person named, by name, in one test. The server
        /// asks for the person's yes (approved_by and the plan they saw) before a real run; nothing else is changed.
        /// </summary>
        public static JObject Status(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            string testName = p.Value<string>("test") ?? "";
            string body = p.Value<string>("comment") ?? "";
            string author = p.Value<string>("author") ?? "";
            if (!Enum.TryParse(p.Value<string>("status") ?? "", true, out ClashResultStatus status) || status == ClashResultStatus.New)
                throw new ArgumentException("status must be Active, Reviewed, Approved or Resolved");
            ClashTest test = All(doc).FirstOrDefault(t => string.Equals(t.DisplayName, testName, StringComparison.OrdinalIgnoreCase))
                ?? throw new ArgumentException($"No clash test named '{testName}'");
            DocumentClashTests data = doc.GetClash().TestsData;
            var results = Flatten(test).ToList();
            var rows = new JArray();
            foreach (string n in (p["names"] as JArray ?? new JArray()).Select(x => x.Value<string>() ?? ""))
            {
                ClashResult r = results.FirstOrDefault(x => x.DisplayName == n);
                if (r == null) { rows.Add(new JObject { ["name"] = n, ["result"] = "missing" }); continue; }
                string was = r.Status.ToString();
                if (dry) { rows.Add(new JObject { ["name"] = n, ["was"] = was, ["result"] = r.Status == status ? "already " + was : "would set " + status }); continue; }
                if (r.Status != status) data.TestsEditResultStatus(r, status);
                if (body.Length > 0)
                {
                    var comments = new CommentCollection();
                    foreach (Comment c in r.Comments) comments.Add(new Comment(c));
                    comments.Add(new Comment(body, CommentStatusOf(status), author));
                    data.TestsEditResultComments(r, comments);
                }
                rows.Add(new JObject { ["name"] = n, ["was"] = was, ["result"] = "set " + status });
            }
            return new JObject { ["dry_run"] = dry, ["test"] = test.DisplayName, ["status"] = status.ToString(), ["results"] = rows };
        }
    }
}
