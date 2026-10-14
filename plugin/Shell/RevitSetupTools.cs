using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Setup › Families in Revit: fmc_family through the installed server (ServerCli), the very code Claude runs, with
    /// its folder rules, dry run, Revit call and log row. Moved here from the Formcraft Browser page.
    /// </summary>
    public sealed class RevitFamilyTools : IFamilyTools
    {
        public string Problem => ServerCli.Problem ?? "";
        public string StagingRoot => GuardStatus.Load().FamilyStagingRoot;

        public async Task<FamilySpecs> LoadSpecsAsync()
        {
            CliResult r = await ServerCli.RunAsync("specs");
            if (!r.Ok) return new FamilySpecs(new FamilySpec[0], new string[0], string.Join(" ", r.Reasons()));
            var families = ((r.Body["families"] as JArray) ?? new JArray()).Select(f => new FamilySpec(
                f.Value<string>("family"), f.Value<string>("role") ?? "", f.Value<string>("category") ?? "",
                f.Value<int?>("connectors") ?? 0, f.Value<int?>("parameters") ?? 0)).ToList();
            return new FamilySpecs(families, Strings(r.Body["pilot_set"]));
        }

        /// <summary>fmc_family plan: every check against the kit, before Revit is touched.</summary>
        public async Task<ToolResult> PlanAsync(IReadOnlyList<string> families)
        {
            CliResult r = await ServerCli.RunAsync("fmc_family", new JObject { ["action"] = "plan", ["families"] = JArray.FromObject(families) });
            if (!r.Ok && r.Body["families"] == null) return ToolResult.Refused("Plan refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            var briefs = Briefs(r.Body["families"]);
            foreach (string name in families)
                result.Lines.Add(briefs.TryGetValue(name, out JObject b) ? Line(name, b)
                    : new FamilyLine(name, "Unknown", ChipKind.Bad, "Not in FMC_Family_Specs.json", "Not in the kit's family specs"));
            var problems = result.Lines.Where(l => l.Kind == ChipKind.Bad).ToList();
            int ready = result.Lines.Count(l => l.Status == "Ready" || l.Kind == ChipKind.Warn);
            result.Messages.Add(new ToolMessage(ready > 0 ? ChipKind.Good : ChipKind.Grey,
                $"Plan: {ready} ready to build, {result.Lines.Count(l => l.Status == "In staging")} already in staging, {problems.Count} with problems."));
            if (problems.Count > 0)
                result.Messages.Add(new ToolMessage(ChipKind.Bad, $"{problems.Count} can't be built yet:\n" + Bullets(problems.Select(p => Short(p.Family) + ": " + p.Tip))));
            var notes = briefs.Values.SelectMany(b => Strings(b["notes"]).Select(n => Short(b.Value<string>("family")) + ": " + n)).ToList();
            if (notes.Count > 0) result.Messages.Add(new ToolMessage(ChipKind.Warn, "Notes for the Family Librarian:\n" + Bullets(notes)));
            return result;
        }

        public async Task<ToolResult> BuildAsync(IReadOnlyList<string> families, bool dryRun, bool overwrite, bool oneByOne, Action<string> progress)
        {
            var args = new JObject { ["action"] = "build", ["families"] = JArray.FromObject(families), ["dry_run"] = true };
            if (dryRun)
            {
                CliResult d = await ServerCli.RunAsync("fmc_family", args);
                if (!d.Ok) return ToolResult.Refused("Build refused: " + string.Join(" ", d.Reasons()));
                var would = Briefs(d.Body["would_build"]);
                var skipped = Briefs(d.Body["skipped"]);
                var result = new ToolResult { Ok = true, Count = would.Count };
                foreach (var b in would.Concat(skipped)) result.Lines.Add(Line(b.Key, b.Value));
                result.Details.AddRange(would.Keys.Select(f => f + "  →  " + StagingRoot + "\\" + RoleOf(f)));
                result.Messages.Add(new ToolMessage(would.Count > 0 ? ChipKind.Info : ChipKind.Warn,
                    $"Dry run: would build {would.Count} into {StagingRoot}\\<Role>." + (skipped.Count > 0 ? $" {skipped.Count} skipped (see their chips)." : "")));
                if (skipped.Count > 0)
                    result.Messages.Add(new ToolMessage(ChipKind.Warn, "Skipped:\n" + Bullets(skipped.Values.SelectMany(b => Strings(b["problems"]).Select(p => Short(b.Value<string>("family")) + ": " + p)))));
                return result;
            }

            args["dry_run"] = false;
            if (overwrite) { args["overwrite"] = true; args["confirm"] = true; }
            var batches = oneByOne ? families.Select(n => new List<string> { n }).ToList() : new List<List<string>> { families.ToList() };
            var results = new JArray();
            var refusals = new List<string>();
            int step = 0;
            foreach (var batch in batches)
            {
                step++;
                args["families"] = JArray.FromObject(batch);
                progress(oneByOne ? $"Building {step} of {batches.Count}: {Short(batch[0])}…" : $"Building {families.Count} families in Revit…");
                CliResult r = await ServerCli.RunAsync("fmc_family", args);
                if (!r.Ok) { refusals.Add((oneByOne ? Short(batch[0]) + ": " : "") + string.Join(" ", r.Reasons())); continue; }
                foreach (var f in (r.Body["result"]?["families"] as JArray ?? new JArray())) results.Add(f);
            }
            if (results.Count == 0) return ToolResult.Refused("Build refused: " + string.Join("\n", refusals));

            var done = new ToolResult { Ok = true };
            var warnings = new List<string>();
            foreach (JObject f in results.OfType<JObject>())
            {
                string name = f.Value<string>("family");
                bool failed = f["error"] != null;
                var w = Strings(f["warnings"]);
                warnings.AddRange(w.Select(x => Short(name) + ": " + x));
                done.Lines.Add(new FamilyLine(name, failed ? "Failed" : "Built", failed ? ChipKind.Bad : ChipKind.Good, "",
                    failed ? f.Value<string>("error") : "Saved to " + f.Value<string>("saved") + (w.Count > 0 ? "\n" + string.Join("\n", w) : "")));
            }
            int failedCount = done.Lines.Count(l => l.Kind == ChipKind.Bad), built = done.Lines.Count - failedCount;
            done.Messages.Add(new ToolMessage(failedCount > 0 ? ChipKind.Warn : ChipKind.Good,
                $"Built {built}" + (failedCount > 0 ? $", {failedCount} failed (hover the chip for why)." : ".") + " Logged in FMC_MCP_FileLog.csv."));
            // Every warning is shown: they are the hand steps left for the Family Librarian.
            if (warnings.Count > 0) done.Messages.Add(new ToolMessage(ChipKind.Warn, "Hand steps left for the Family Librarian:\n" + Bullets(warnings, 30)));
            if (refusals.Count > 0) done.Messages.Add(new ToolMessage(ChipKind.Bad, "Refused:\n" + Bullets(refusals)));
            return done;
        }

        public async Task<ToolResult> LoadTestAsync(IReadOnlyList<string> families, bool dryRun)
        {
            var args = new JObject { ["action"] = "load_test", ["families"] = JArray.FromObject(families), ["dry_run"] = dryRun };
            CliResult r = await ServerCli.RunAsync("fmc_family", args);
            if (!r.Ok) return ToolResult.Refused("Load test refused: " + string.Join(" ", r.Reasons()));
            var missing = Strings(r.Body["missing"]);
            if (dryRun)
            {
                var would = Strings(r.Body["would_load_and_place"]);
                var result = new ToolResult { Ok = true, Count = would.Count };
                result.Details.AddRange(would);
                result.Messages.Add(new ToolMessage(would.Count > 0 ? ChipKind.Info : ChipKind.Warn, $"Dry run: would load and place {would.Count}." +
                    (missing.Count > 0 ? $" Not in staging yet (build first): {string.Join(", ", missing.Select(Short))}." : "")));
                return result;
            }
            var done = new ToolResult { Ok = true };
            var results = r.Body["result"]?["families"] as JArray ?? new JArray();
            foreach (JObject f in results.OfType<JObject>())
            {
                bool pass = f.Value<bool?>("pass") == true;
                done.Lines.Add(new FamilyLine(f.Value<string>("family"), pass ? "Load tested" : "Fail", pass ? ChipKind.Good : ChipKind.Bad, "",
                    pass ? "Loaded, placed and flexed; connectors and parameters as expected" : f["issues"]?.ToString(Newtonsoft.Json.Formatting.None) ?? f.ToString()));
            }
            int tested = r.Body["result"]?.Value<int?>("tested") ?? results.Count, passed = r.Body["result"]?.Value<int?>("passed") ?? 0;
            done.Messages.Add(new ToolMessage(passed == tested ? ChipKind.Good : ChipKind.Warn, $"Load test: {passed} of {tested} passed." +
                (missing.Count > 0 ? $" Not in staging: {string.Join(", ", missing.Select(Short))}." : "")));
            string note = r.Body["result"]?.Value<string>("note");
            if (!string.IsNullOrEmpty(note)) done.Messages.Add(new ToolMessage(ChipKind.Info, note));
            return done;
        }

        // ---- helpers (as on the Browser page) ----

        private static FamilyLine Line(string name, JObject b)
        {
            var problems = Strings(b["problems"]);
            var notes = Strings(b["notes"]);
            int connectors = (b["connectors"] as JArray)?.Count ?? 0;
            int parameters = b.Value<int?>("shared_parameters") ?? 0;
            string meta = $"{RoleOf(name)} · {Count(connectors, "connector")} · {Count(parameters, "parameter")}";
            string tip = string.Join("\n", problems.Concat(notes).DefaultIfEmpty("No problems or notes"));
            var real = problems.Where(p => !IsInStaging(p)).ToList();
            if (real.Count > 0) return new FamilyLine(name, "Problem", ChipKind.Bad, meta, tip);
            if (problems.Count > 0) return new FamilyLine(name, "In staging", ChipKind.Good, meta, tip);
            if (notes.Count > 0) return new FamilyLine(name, Count(notes.Count, "note"), ChipKind.Warn, meta, tip);
            return new FamilyLine(name, "Ready", ChipKind.Info, meta, tip);
        }

        internal static bool IsInStaging(string problem) => problem.Contains("exists; set overwrite");

        private static Dictionary<string, JObject> Briefs(JToken families) =>
            (families as JArray)?.OfType<JObject>().GroupBy(b => b.Value<string>("family")).ToDictionary(g => g.Key, g => g.First())
            ?? new Dictionary<string, JObject>();

        internal static List<string> Strings(JToken t) => (t as JArray)?.Select(x => x.ToString()).ToList() ?? new List<string>();
        private static string Bullets(IEnumerable<string> lines, int max = 12)
        {
            var l = lines.ToList();
            return string.Join("\n", l.Take(max).Select(x => "• " + x)) + (l.Count > max ? $"\n… and {l.Count - max} more" : "");
        }
        private static string Short(string family) => family != null && family.StartsWith("FMC_") ? family.Substring(4) : family;
        private static string RoleOf(string family) => family.Split('_').Skip(1).FirstOrDefault() ?? "";
        private static string Count(int n, string word) => $"{n} {word}{(n == 1 ? "" : "s")}";
    }

    /// <summary>
    /// Setup › Templates in Revit: fmc_file through the installed server (create from template, save as, close, archive),
    /// and the documents open in Revit as the guard sees them. Moved here from the Formcraft Browser page.
    /// </summary>
    public sealed class RevitFileTools : IFileTools
    {
        private IReadOnlyList<OpenDocument> _docs = new OpenDocument[0];

        public IReadOnlyList<OpenDocument> Documents => _docs;
        public string StartFolder => GuardStatus.Load().FirstWritableFolder() ?? "";
        public event EventHandler Changed;

        /// <summary>From FormcraftBrowser's Idling snapshot, only when the open documents changed.</summary>
        public void Update(IEnumerable<Fmc.DocState> docs)
        {
            var guard = GuardStatus.Load();
            _docs = docs.Select(d => new OpenDocument(d.Title, d.Path, d.IsFamily, d.IsWorkshared, d.IsModified, d.IsActive,
                live: guard.LiveModelLock && !guard.Verdict(d).Ok)).ToList();
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public async Task<ToolResult> RunAsync(FileRequest q, bool dryRun)
        {
            var args = new JObject { ["action"] = q.Action, ["dry_run"] = dryRun };
            if (q.Kind.Length > 0) args["kind"] = q.Kind;
            if (q.TemplatePath.Length > 0) args["template_path"] = q.TemplatePath;
            if (q.SavePath.Length > 0) args["save_path"] = q.SavePath;
            if (q.Document.Length > 0) args["document"] = q.Document;
            if (q.Path.Length > 0) args["path"] = q.Path;
            if (q.Action == "close") args["save"] = q.Save;
            if (q.Action == "create_from_template") args["close_after"] = q.CloseAfter;
            if (q.Overwrite) { args["overwrite"] = true; args["confirm"] = true; }
            if (q.ProjectInfo.Count > 0) args["project_info"] = JObject.FromObject(q.ProjectInfo);
            if (q.Action == "archive" && !dryRun) args["confirm"] = true;

            CliResult r = await ServerCli.RunAsync("fmc_file", args);
            if (dryRun)
            {
                if (!r.Ok)
                {
                    var reasons = r.Reasons();
                    var refused = ToolResult.Refused("Refused: " + string.Join(" ", reasons));
                    refused.NeedsOverwrite = !q.Overwrite && reasons.Any(RevitFamilyTools.IsInStaging) &&
                                             reasons.All(x => RevitFamilyTools.IsInStaging(x) || x.Contains("overwrite needs confirm"));
                    return refused;
                }
                var result = new ToolResult { Ok = true };
                if (r.Body["would_do"] is JObject would)
                    result.Details.AddRange(would.Properties().Where(p => p.Value.Type != JTokenType.Null && p.Value.ToString().Length > 0)
                        .Select(p => p.Name + ": " + p.Value));
                if (r.Body["would_move"] is JArray moves)
                    result.Details.AddRange(moves.OfType<JArray>().Select(m => Path.GetFileName(m[0].ToString()) + " → " + m[1]));
                return result;
            }
            var done = new ToolResult { Ok = r.Ok };
            done.Messages.Add(r.Ok
                ? new ToolMessage(ChipKind.Good, FileLog.Describe(q.Action, false) + ": done. Logged in FMC_MCP_FileLog.csv.")
                : new ToolMessage(ChipKind.Bad, FileLog.Describe(q.Action, false) + " failed: " + string.Join(" ", r.Reasons())));
            return done;
        }
    }
}

namespace revit_mcp_plugin.Shell
{
    /// <summary>Setup › Project in Revit: fmc_project through the installed server (plan, then start), as Claude runs it.</summary>
    public sealed class RevitProjectTools : Formcraft.Shell.ViewModels.IProjectTools
    {
        public async Task<ToolResult> RunAsync(Formcraft.Shell.ViewModels.ProjectRequest q, bool dryRun)
        {
            var args = new JObject
            {
                ["action"] = "start", ["dry_run"] = dryRun, ["project_folder"] = q.Folder, ["code"] = q.Code,
                ["originator"] = q.Originator, ["volume"] = q.Volume, ["level"] = q.Level, ["type"] = q.Type,
                ["roles"] = JArray.FromObject(q.Roles), ["templates"] = JObject.FromObject(q.Templates),
                ["details"] = JObject.FromObject(q.Details), ["stage"] = q.Stage, ["issue_set"] = q.IssueSet, ["standard"] = q.Standard,
            };
            CliResult r = await ServerCli.RunAsync("fmc_project", args);
            if (r.Body["refused"] != null || (!r.Ok && r.Body["steps"] == null))
            {
                var refused = new ToolResult();
                foreach (string reason in r.Reasons()) refused.Messages.Add(new ToolMessage(ChipKind.Bad, reason));
                return refused;
            }
            if (dryRun)
            {
                var would = r.Body["would_do"] as JObject ?? new JObject();
                var result = new ToolResult { Ok = true, Count = q.Roles.Count };
                var folders = (would["folders"] as JArray)?.Select(f => Path.GetFileName(f.ToString())).Distinct().ToList() ?? new List<string>();
                result.Details.Add("Folders: " + string.Join(" · ", folders.Where(f => f.Length > 2 && char.IsDigit(f[0]))));
                foreach (JObject m in (would["models"] as JArray ?? new JArray()).OfType<JObject>())
                    result.Details.Add(m.Value<string>("name") + "  ←  " + Path.GetFileName(m.Value<string>("template") ?? ""));
                result.Details.Add("Manifest: " + would.Value<string>("manifest_path"));
                return result;
            }
            var done = new ToolResult { Ok = r.Ok };
            foreach (JObject s in (r.Body["steps"] as JArray ?? new JArray()).OfType<JObject>())
                done.Messages.Add(new ToolMessage(s.Value<bool>("ok") ? ChipKind.Good : ChipKind.Bad, s.Value<string>("step") + ": " + s.Value<string>("detail")));
            done.Messages.Insert(0, new ToolMessage(r.Ok ? ChipKind.Good : ChipKind.Warn,
                r.Ok ? $"Started {q.Code}. Logged in FMC_MCP_FileLog.csv." : $"{q.Code} started with problems: see the lines below."));
            done.Messages.Add(new ToolMessage(ChipKind.Info, "Next: link the models, project families and the first QA run."));
            return done;
        }
    }
}

namespace revit_mcp_plugin.Shell
{
    /// <summary>Setup › Templates in Revit: fmc_template through the installed server (audit; brand pack with a dry run first).</summary>
    public sealed class RevitTemplateTools : ITemplateTools
    {
        public async Task<AuditResult> AuditAsync(string templatePath, BrandPack brand)
        {
            var args = new JObject { ["action"] = "audit", ["template_path"] = templatePath };
            if (brand != null) args["brand"] = new JObject { ["name"] = brand.Name, ["main_font"] = brand.MainFont, ["title_font"] = brand.TitleFont };
            CliResult r = await ServerCli.RunAsync("fmc_template", args);
            var result = new AuditResult { Ok = r.Ok && r.Body["lines"] != null };
            if (!result.Ok) { result.Message = "Audit refused: " + string.Join(" ", r.Reasons()); return result; }
            foreach (JObject l in ((JArray)r.Body["lines"]).OfType<JObject>())
                result.Lines.Add(new AuditLine(l.Value<string>("area"), l.Value<string>("severity"), l.Value<string>("status"), l.Value<string>("detail") ?? ""));
            int must = result.Lines.Count(l => l.Severity == "Must"), should = result.Lines.Count(l => l.Severity == "Should");
            result.Message = $"Audited {Path.GetFileName(templatePath)}: {must} must, {should} should. Logged in FMC_MCP_FileLog.csv.";
            return result;
        }

        public async Task<ToolResult> BrandAsync(string templatePath, BrandPack brand, bool dryRun)
        {
            var args = new JObject
            {
                ["action"] = "brand", ["template_path"] = templatePath, ["dry_run"] = dryRun,
                ["brand"] = new JObject { ["name"] = brand.Name, ["main_font"] = brand.MainFont, ["title_font"] = brand.TitleFont },
            };
            CliResult r = await ServerCli.RunAsync("fmc_template", args);
            if (!r.Ok) return ToolResult.Refused("Brand pack refused: " + string.Join(" ", r.Reasons()));
            var changes = (dryRun ? r.Body["would_change"] : r.Body["changed"]) as JArray ?? new JArray();
            var result = new ToolResult { Ok = true, Count = changes.Count };
            foreach (JObject c in changes.OfType<JObject>())
                result.Details.Add($"{c.Value<string>("item")}   {c.Value<string>("now")} → {c.Value<string>("after")}");
            if (!dryRun) result.Messages.Add(new ToolMessage(ChipKind.Good, $"Brand pack {brand.Name} applied to {changes.Count} types and saved. Logged in FMC_MCP_FileLog.csv."));
            return result;
        }

        public async Task<TemplateRecipe> RecipeAsync(string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_template", new JObject { ["action"] = "recipe", ["template_path"] = "base.rte", ["kit_folder"] = kitFolder });
            var t = new TemplateRecipe { Ok = r.Ok && r.Body["counts"] != null };
            if (!t.Ok) { t.Message = "The recipe can't be read: " + string.Join(" ", r.Reasons()); return t; }
            t.Kit = r.Body.Value<string>("kit") ?? "";
            foreach (var kv in ((JObject)r.Body["counts"]).Properties()) t.Counts.Add((kv.Name.Replace('_', ' '), kv.Value.Value<int>()));
            t.Readings.AddRange(RevitFamilyTools.Strings(r.Body["readings"]));
            t.Roles.AddRange(RevitFamilyTools.Strings(r.Body["roles"]));
            t.Message = $"Recipe read from {t.Kit}: {t.Readings.Count} readings to settle in the kit.";
            return t;
        }

        public async Task<TemplateCompare> CompareAsync(string templatePath, string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_template", new JObject { ["action"] = "compare", ["template_path"] = templatePath, ["kit_folder"] = kitFolder });
            var c = new TemplateCompare { Ok = r.Ok && r.Body["missing"] != null };
            if (!c.Ok) { c.Message = "Compare refused: " + string.Join(" ", r.Reasons()); return c; }
            c.Matches = r.Body.Value<bool?>("matches") ?? false;
            foreach (var kv in ((JObject)r.Body["missing"]).Properties())
            {
                var names = RevitFamilyTools.Strings(kv.Value);
                c.Missing.Add((kv.Name, names.Count, string.Join(", ", names.Take(3)) + (names.Count > 3 ? ", …" : "")));
            }
            c.Message = c.Matches ? "The template holds everything the recipe names." : $"{c.Missing.Sum(m => m.Missing)} names missing from {Path.GetFileName(templatePath)}.";
            return c;
        }

        public async Task<ToolResult> BuildAsync(string templatePath, string kitFolder, string seedPath, bool roleCopies, bool dryRun)
        {
            var args = new JObject { ["action"] = "build", ["template_path"] = templatePath, ["kit_folder"] = kitFolder, ["seed_path"] = seedPath,
                ["role_copies"] = roleCopies, ["dry_run"] = dryRun };
            CliResult r = await ServerCli.RunAsync("fmc_template", args);
            if (!r.Ok) return ToolResult.Refused("Build refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            foreach (string w in RevitFamilyTools.Strings(r.Body["would"])) result.Details.Add(w);
            foreach (JObject s in (r.Body["steps"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string line = $"{s.Value<string>("step")}: {s.Value<int?>("made") ?? 0} new, {s.Value<int?>("updated") ?? 0} updated, {s.Value<int?>("skipped") ?? 0} already there";
                if (dryRun) result.Details.Add(line); else result.Messages.Add(new ToolMessage(ChipKind.Info, line));
            }
            foreach (string c in RevitFamilyTools.Strings(r.Body["role_copies"])) { if (dryRun) result.Details.Add(c); else result.Messages.Add(new ToolMessage(ChipKind.Info, c)); }
            result.Count = result.Details.Count;
            if (!dryRun) result.Messages.Insert(0, new ToolMessage(ChipKind.Good, $"{Path.GetFileName(templatePath)} built in staging. Logged. Compare, then audit; publishing is a request to the BIM Manager."));
            return result;
        }
    }
}

namespace revit_mcp_plugin.Shell
{
    /// <summary>Setup › Families against the kit in Revit: fmc_library through the installed server.</summary>
    public sealed class RevitLibraryTools : ILibraryTools
    {
        private static FamilyVerdict Verdict(JObject v) => new FamilyVerdict(
            v.Value<string>("name"), v.Value<string>("category") ?? "", v.Value<string>("from") ?? "", v.Value<int?>("score") ?? 0,
            v.Value<string>("state") ?? "", ((v["checks"] as JArray) ?? new JArray()).OfType<JObject>()
                .Select(c => new FamilyCheckLine(c.Value<string>("check"), c.Value<string>("state"), c.Value<string>("detail") ?? "")).ToList(),
            v.Value<string>("next") ?? "");

        public async Task<ScanResult> ScanAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_library", new JObject { ["action"] = "scan", ["detail"] = "full" });
            var result = new ScanResult { Ok = r.Ok && r.Body["families"] != null };
            if (!result.Ok) { result.Message = "Scan refused: " + string.Join(" ", r.Reasons()); return result; }
            result.Document = r.Body.Value<string>("document") ?? "";
            foreach (JObject v in ((JArray)r.Body["families"]).OfType<JObject>()) result.Families.Add(Verdict(v));
            foreach (JObject c in (r.Body["summary"]?["by_check"] as JArray ?? new JArray()).OfType<JObject>())
                result.ByCheck.Add((c.Value<string>("check"), c.Value<int>("fail"), c.Value<int?>("pass") ?? 0, c.Value<int?>("not_checked") ?? 0));
            var kitProblems = RevitFamilyTools.Strings(r.Body["kit_problems"]);
            result.Message = $"Scanned {result.Families.Count} families in {result.Document}." + (kitProblems.Count > 0 ? " " + string.Join(" ", kitProblems) : "");
            return result;
        }

        private static JObject Args(string action, string path, string role, string description, string keynote) => new JObject
        {
            ["action"] = action, ["path"] = path, ["role"] = role, ["description"] = description, ["keynote"] = keynote,
        };

        public async Task<BringInPlan> InspectAsync(string path, string role, string description, string keynote)
        {
            CliResult r = await ServerCli.RunAsync("fmc_library", Args("inspect", path, role, description, keynote));
            var plan = new BringInPlan { Ok = r.Ok && r.Body["plan"] != null };
            if (!plan.Ok) { plan.Message = "Check refused: " + string.Join(" ", r.Reasons()); return plan; }
            var p = (JObject)r.Body["plan"];
            plan.Verdict = new FamilyVerdict(p.Value<string>("family"), p.Value<string>("category") ?? "", "Outside file", p.Value<int?>("score") ?? 0,
                p.Value<string>("state") ?? "", ((p["checks"] as JArray) ?? new JArray()).OfType<JObject>()
                    .Select(c => new FamilyCheckLine(c.Value<string>("check"), c.Value<string>("state"), c.Value<string>("detail") ?? "")).ToList(), "");
            plan.ProposedName = p.Value<string>("proposed_name") ?? "";
            plan.SavePath = p.Value<string>("save_path") ?? "";
            plan.SizeMb = p.Value<double?>("size_mb") ?? 0;
            plan.ImportedCad = p.Value<int?>("imported_cad") ?? 0;
            plan.AddParameters.AddRange(RevitFamilyTools.Strings(p["add_parameters"]));
            return plan;
        }

        public async Task<ToolResult> BringInAsync(string path, string role, string description, string keynote, bool dryRun)
        {
            var args = Args("bring_in", path, role, description, keynote);
            args["dry_run"] = dryRun;
            CliResult r = await ServerCli.RunAsync("fmc_library", args);
            if (!r.Ok) return ToolResult.Refused("Bring in refused: " + string.Join(" ", r.Reasons()));
            if (dryRun)
            {
                var p = r.Body["would_do"] as JObject ?? new JObject();
                var result = new ToolResult { Ok = true, Count = 1 };
                result.Details.Add("Rename → " + p.Value<string>("proposed_name"));
                var add = RevitFamilyTools.Strings(p["add_parameters"]);
                result.Details.Add(add.Count == 0 ? "Parameters: none to add" : "Add " + string.Join(", ", add));
                result.Details.Add("Keynote: " + (string.IsNullOrEmpty(p.Value<string>("keynote")) ? "none" : p.Value<string>("keynote")));
                result.Details.Add("Save to " + p.Value<string>("save_path"));
                return result;
            }
            var res = r.Body["result"] as JObject ?? new JObject();
            var done = new ToolResult { Ok = true };
            done.Messages.Add(new ToolMessage(ChipKind.Good, "Brought in: " + res.Value<string>("saved") + ". Release stays with the Family Librarian."));
            var warnings = RevitFamilyTools.Strings(res["warnings"]);
            if (warnings.Count > 0) done.Messages.Add(new ToolMessage(ChipKind.Warn, "Hand steps:\n• " + string.Join("\n• ", warnings)));
            return done;
        }

        public async Task<IReadOnlyList<KitParameter>> ParametersAsync(string query)
        {
            CliResult r = await ServerCli.RunAsync("fmc_library", new JObject { ["action"] = "parameters", ["query"] = query });
            return ((r.Body["parameters"] as JArray) ?? new JArray()).OfType<JObject>()
                .Select(p => new KitParameter(p.Value<string>("name"), p.Value<string>("group") ?? "", p.Value<string>("datatype") ?? "")).ToList();
        }

        public async Task<KeynoteSearch> KeynotesAsync(string query, string group)
        {
            CliResult r = await ServerCli.RunAsync("fmc_library", new JObject { ["action"] = "keynotes", ["query"] = query, ["group"] = group });
            var result = new KeynoteSearch { Ok = r.Ok, Message = r.Ok ? "" : string.Join(" ", r.Reasons()) };
            result.File = r.Body.Value<string>("file") ?? "";
            result.Groups.AddRange(RevitFamilyTools.Strings(r.Body["groups"]));
            foreach (JObject k in ((r.Body["keynotes"] as JArray) ?? new JArray()).OfType<JObject>())
                result.Keynotes.Add(new KeynoteEntry(k.Value<string>("code"), k.Value<string>("description") ?? ""));
            result.NextCode = r.Body.Value<string>("next_code") ?? "";
            return result;
        }

        public async Task<string> RequestKeynoteAsync(string group, string text)
        {
            CliResult r = await ServerCli.RunAsync("fmc_library", new JObject { ["action"] = "keynote_request", ["group"] = group, ["text"] = text });
            return r.Ok ? "Requested " + r.Body.Value<string>("requested") + ". The BIM Manager approves it into the kit's keynote file."
                        : "Keynote request refused: " + string.Join(" ", r.Reasons());
        }
    }
}

namespace revit_mcp_plugin.Shell
{
    /// <summary>Check › QA and Rules in Revit: fmc_qa through the installed server.</summary>
    public sealed class RevitQaTools : IQaTools
    {
        public async Task<RulebookSet> RulesAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_qa", new JObject { ["action"] = "rules", ["detail"] = "full" });
            var set = new RulebookSet { Ok = r.Ok };
            foreach (JObject b in (r.Body["books"] as JArray ?? new JArray()).OfType<JObject>())
                set.Books.Add((b.Value<string>("name"), b.Value<string>("version") ?? "", b.Value<int?>("count") ?? 0));
            foreach (JObject x in (r.Body["rules"] as JArray ?? new JArray()).OfType<JObject>())
                set.Rules.Add(new RuleInfo
                {
                    Id = x.Value<string>("id"), Rule = x.Value<string>("rule") ?? "", Severity = x.Value<string>("severity") ?? "", Status = x.Value<string>("status") ?? "",
                    Book = x.Value<string>("book") ?? "", Scope = x.Value<string>("scope") ?? "", Test = x.Value<string>("test") ?? "",
                    FixHint = x.Value<string>("fix_hint") ?? "", Version = x.Value<string>("version") ?? "", Why = x.Value<string>("why") ?? "",
                });
            foreach (JObject e in (r.Body["exceptions"] as JArray ?? new JArray()).OfType<JObject>())
                set.Exceptions.Add(new RuleException { Rule = e.Value<string>("rule"), Where = e.Value<string>("where") ?? "", ApprovedBy = e.Value<string>("approved_by") ?? "", Until = e.Value<string>("until") ?? "" });
            foreach (JObject d in (r.Body["decisions"] as JArray ?? new JArray()).OfType<JObject>())
                set.Decisions.Add((d.Value<string>("text") ?? "", d.Value<string>("state") ?? ""));
            set.Problems.AddRange(RevitFamilyTools.Strings(r.Body["problems"]));
            if (!r.Ok) set.Problems.AddRange(r.Reasons());
            return set;
        }

        public async Task<QaRun> RunAsync(string gate, string projectFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_qa", new JObject { ["action"] = "run", ["gate"] = gate, ["project_folder"] = projectFolder ?? "", ["detail"] = "full" });
            var run = new QaRun { Ok = r.Ok && r.Body["results"] != null };
            if (!run.Ok) { run.Message = "QA refused: " + string.Join(" ", r.Reasons()); return run; }
            var b = r.Body;
            run.Model = b.Value<string>("model") ?? "";
            run.GateName = b.Value<string>("gate_name") ?? gate;
            run.Ran = b.Value<int?>("ran") ?? 0; run.Pass = b.Value<int?>("pass") ?? 0; run.Fail = b.Value<int?>("fail") ?? 0;
            run.Warning = b.Value<int?>("warning") ?? 0; run.NotApplicable = b.Value<int?>("not_applicable") ?? 0; run.NotChecked = b.Value<int?>("not_checked") ?? 0;
            run.Summary = b.Value<string>("summary") ?? "";
            run.Verdict = b.Value<string>("verdict") ?? ((b["blocking"] as JArray)?.Count > 0 ? "Blocked" : "Not clear");
            run.Report = b.Value<string>("report") ?? "";
            run.Trend = (b["trend"]?.Value<int?>("new") ?? 0, b["trend"]?.Value<int?>("recurring") ?? 0, b["trend"]?.Value<int?>("resolved") ?? 0);
            foreach (JObject h in (b["history"] as JArray ?? new JArray()).OfType<JObject>()) run.History.Add((h.Value<string>("at") ?? "", h.Value<int?>("failing") ?? 0));
            foreach (JObject x in ((JArray)b["results"]).OfType<JObject>())
            {
                var q = new QaResult
                {
                    Id = x.Value<string>("id"), Rule = x.Value<string>("rule") ?? "", Severity = x.Value<string>("severity") ?? "", State = x.Value<string>("state") ?? "",
                    Where = x.Value<string>("where") ?? "", FixHint = x.Value<string>("fix_hint") ?? "", Excepted = x.Value<string>("excepted") ?? "",
                };
                q.ElementIds.AddRange((x["element_ids"] as JArray ?? new JArray()).Select(i => i.Value<long>()));
                run.Results.Add(q);
            }
            run.Message = $"QA ran on {run.Model}: {run.Ran} checks, {run.Fail} fail, {run.Warning} warnings. Report saved.";
            return run;
        }

        public async Task<string> SelectAsync(IReadOnlyList<long> elementIds)
        {
            CliResult r = await ServerCli.RunAsync("fmc_qa", new JObject { ["action"] = "select", ["element_ids"] = JArray.FromObject(elementIds) });
            return r.Ok ? $"Selected {r.Body.Value<int?>("selected") ?? elementIds.Count} elements in Revit." : "Zoom failed: " + string.Join(" ", r.Reasons());
        }

        public async Task<string> RequestAsync(string rule, string kind, string text, string severity)
        {
            var args = new JObject { ["action"] = "request", ["rule"] = rule, ["kind"] = kind, ["text"] = text };
            if (!string.IsNullOrEmpty(severity)) args["severity"] = severity;
            CliResult r = await ServerCli.RunAsync("fmc_qa", args);
            return r.Ok ? (kind == "approve" ? "Approval" : "Change request") + " for " + rule + " recorded for the BIM Manager: " + r.Body.Value<string>("next")
                        : "Request refused: " + string.Join(" ", r.Reasons());
        }
    }
}
