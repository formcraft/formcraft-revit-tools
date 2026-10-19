using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Engineer › Systems and Structural in Revit: fmc_systems through the installed server (read-only).</summary>
    public sealed class RevitSystemTools : ISystemTools
    {
        public Task<SystemsCheck> ElectricalAsync(string projectFolder, bool save) =>
            Run(new JObject { ["action"] = "electrical", ["project_folder"] = projectFolder, ["save"] = save });

        public Task<SystemsCheck> StructuralAsync(string kitFolder, string projectFolder, bool save) =>
            Run(new JObject { ["action"] = "structural", ["kit_folder"] = kitFolder, ["project_folder"] = projectFolder, ["save"] = save });

        /// <summary>
        /// Engineer › Systems › Diagrams (LD5): fmc_diagram through the installed server, the very code Claude uses. Plan is
        /// the draw and the sheets as dry runs; Generate sends both for real with confirm, which the pane sends only after
        /// the person's yes in its dialog; the live-model lock decides on the server as for Claude.
        /// </summary>
        public async Task<DiagramRun> DiagramAsync(string action, IReadOnlyList<string> kinds, string kitFolder)
        {
            var run = new DiagramRun();
            JObject Args(string a, bool? dry = null)
            {
                var o = new JObject { ["action"] = a, ["kinds"] = new JArray(kinds) };
                if (!string.IsNullOrWhiteSpace(kitFolder)) o["kit_folder"] = kitFolder;
                if (dry.HasValue) { o["dry_run"] = dry.Value; if (!dry.Value) o["confirm"] = true; }
                return o;
            }
            if (action == DiagramActions.Scan || action == DiagramActions.Gate)
            {
                CliResult r = await ServerCli.RunAsync("fmc_diagram", Args(action));
                if (!r.Ok) { run.Message = Refusal(action == DiagramActions.Scan ? "Scan" : "Gate D", r); return run; }
                var b = r.Body;
                run.Ok = true;
                run.Model = b.Value<string>("model") ?? "";
                if (action == DiagramActions.Scan)
                {
                    foreach (JObject d in (b["diagrams"] as JArray ?? new JArray()).OfType<JObject>())
                        run.Views.Add(new CheckLine((d.Value<string>("kind") ?? "") + " " + (d.Value<string>("system") ?? ""), $"{d.Value<int?>("nodes") ?? 0} nodes, {d.Value<int?>("edges") ?? 0} edges", "Info"));
                    int gaps = 0;
                    if (b["gaps"] is JObject g)
                        foreach (var p in g.Properties())
                        {
                            int n = p.Value.Value<int?>("count") ?? 0;
                            gaps += n;
                            run.Views.Add(new CheckLine("Gaps · " + p.Name, n + ": " + string.Join("; ", RevitFamilyTools.Strings(p.Value["first"]).Take(3)), "Warn"));
                        }
                    run.Message = $"{run.Model}: {run.Views.Count(v => v.State == "Info")} diagrams, {gaps} gaps. Read-only, nothing changed.";
                }
                else
                {
                    run.Verdict = b.Value<string>("verdict") ?? "";
                    foreach (JObject l in (b["lines"] as JArray ?? new JArray()).OfType<JObject>())
                        run.Lines.Add(new CheckLine(l.Value<string>("check") ?? "", l.Value<string>("detail") ?? "", l.Value<string>("state") ?? ""));
                    foreach (JObject v in (b["views"] as JArray ?? new JArray()).OfType<JObject>())
                        run.Views.Add(new CheckLine(v.Value<string>("view") ?? "",
                            $"{v.Value<int?>("missing_count") ?? 0} missing, {v.Value<int?>("gone_count") ?? 0} gone, {v.Value<int?>("tbc_drawn") ?? 0} TBC" + (string.IsNullOrEmpty(v.Value<string>("sheet")) ? "" : " · on " + v.Value<string>("sheet")),
                            v.Value<string>("state") ?? ""));
                    run.Message = $"{run.Model}: Gate D {run.Verdict}. {b.Value<string>("summary")} Read-only, nothing changed.";
                }
                return run;
            }

            bool dryRun = action != DiagramActions.Generate;
            CliResult draw = await ServerCli.RunAsync("fmc_diagram", Args("draw", dryRun));
            if (!draw.Ok) { run.Message = Refusal(dryRun ? "Plan" : "Generate", draw); return run; }
            run.Model = draw.Body.Value<string>("model") ?? "";
            foreach (JObject v in (draw.Body["result"]?["views"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = v.Value<string>("name") ?? "";
                int tbc = (draw.Body["views"] as JArray ?? new JArray()).OfType<JObject>().Where(x => x.Value<string>("name") == name).Select(x => x.Value<int?>("tbc") ?? 0).FirstOrDefault();
                string result = v.Value<string>("result") ?? "";
                run.Views.Add(new CheckLine(name, $"{v.Value<int?>("symbols") ?? 0} symbols, {v.Value<int?>("lines") ?? 0} lines, {v.Value<int?>("texts") ?? 0} texts" + (tbc > 0 ? $" · {tbc} TBC" : ""),
                    dryRun ? (result == "skip" ? "Skip" : "Would " + result) : result));
            }
            CliResult sheets = await ServerCli.RunAsync("fmc_diagram", Args("sheets", dryRun));
            if (!sheets.Ok) { run.Ok = !dryRun; run.Message = Refusal("Sheets", sheets) + (dryRun ? "" : " The views were drawn; the sheets weren't made."); return run; }
            var placed = (sheets.Body["revit"]?["sheets"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            foreach (JObject s in (sheets.Body["sheets"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string number = s.Value<string>("number") ?? "";
                var views = RevitFamilyTools.Strings(s["views"]).ToList();
                var rv = placed.FirstOrDefault(x => x.Value<string>("number") == number);
                string state = views.Count == 0 ? "Nothing to place" : rv == null ? (dryRun ? "Not reached" : "") : dryRun ? "Would " + (rv.Value<string>("result") ?? "") : rv.Value<string>("result") ?? "";
                int left = (s["left_off"] as JArray)?.Count ?? 0;
                run.Sheets.Add(new CheckLine(number + " " + (s.Value<string>("name") ?? ""), views.Count == 0 ? "—" : string.Join(", ", views) + (left > 0 ? $" ({left} don't fit)" : ""), state));
            }
            run.KitRequests.AddRange(RevitFamilyTools.Strings(sheets.Body["kit_change_requests"]));
            foreach (JObject t in (sheets.Body["tbc"] as JArray ?? new JArray()).OfType<JObject>())
                run.Sheets.Add(new CheckLine(string.Join(", ", RevitFamilyTools.Strings(t["sheets"])), (t.Value<string>("kind") ?? "") + ": TBC, the scan doesn't read inverts, lengths or manholes yet", "TBC"));
            run.Ok = true;
            int onSheets = run.Sheets.Count(x => x.State != "Nothing to place" && x.State != "TBC");
            run.Message = dryRun
                ? $"Dry run: {run.Views.Count} views and {onSheets} sheets would be made or updated; nothing changed. Press Generate once you agree."
                : $"{run.Views.Count} views drawn and placed on {onSheets} sheets. One Undo each; the model isn't saved. Run Gate D next.";
            return run;
        }

        /// <summary>A refusal in plain words; a server without fmc_diagram in its command line says so.</summary>
        private static string Refusal(string what, CliResult r)
        {
            var reasons = r.Reasons();
            if (reasons.Any(x => x.Contains("Usage:")))
                return "This server has no fmc_diagram in its command line yet (LD5): update the server. Nothing was changed.";
            return what + " refused: " + string.Join(" ", reasons);
        }

        private static async Task<SystemsCheck> Run(JObject args)
        {
            CliResult r = await ServerCli.RunAsync("fmc_systems", args);
            var c = new SystemsCheck { Ok = r.Ok && r.Body["checks"] != null };
            if (!c.Ok) { c.Message = "Check refused: " + string.Join(" ", r.Reasons()); return c; }
            var b = r.Body;
            c.Model = b.Value<string>("model") ?? "";
            c.Saved = b.Value<string>("saved") ?? "";
            foreach (JObject x in ((JArray)b["checks"]).OfType<JObject>())
                c.Checks.Add(new CheckLine(x.Value<string>("check") ?? "", x.Value<string>("found") ?? "", x.Value<string>("state") ?? ""));
            foreach (JObject x in (b["boards"] as JArray ?? new JArray()).OfType<JObject>())
                c.Boards.Add(new BoardLine
                {
                    Name = x.Value<string>("name") ?? "", ConnectedVa = x.Value<double?>("connected_va") ?? 0, DemandVa = x.Value<double?>("demand_va") ?? 0,
                    Circuits = x.Value<int?>("circuits") ?? 0, FedBy = x.Value<string>("fed_by") ?? "", Check = x.Value<string>("check") ?? "", Note = x.Value<string>("note") ?? "",
                });
            foreach (JObject x in (b["results"] as JArray ?? new JArray()).OfType<JObject>())
                c.Results.Add(new ResultLine { Mark = x.Value<string>("mark") ?? "", Type = x.Value<string>("type") ?? "", Utilisation = x.Value<double?>("utilisation") ?? 0, Run = x.Value<string>("run") ?? "" });
            c.NotInKit.AddRange(RevitFamilyTools.Strings(b["not_in_kit"]));
            if (b["members"] is JObject m)
                c.Members = $"{m.Value<int?>("columns") ?? 0} columns, {m.Value<int?>("framing") ?? 0} beams, {m.Value<int?>("foundations") ?? 0} foundations";
            int warn = c.Checks.Count(x => x.State == "Warn"), fail = c.Checks.Count(x => x.State == "Fail");
            c.Message = $"{c.Model}: {fail} fail, {warn} warn. Read-only, nothing changed.";
            return c;
        }
    }
}
