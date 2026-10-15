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
    /// Engineer › Ceilings in Revit (CL3): fmc_ceiling through the installed server, the very engine Claude uses. The room is
    /// typed in the pane until CL2 reads it from the model; fixtures come from an optional file. Empty values are left
    /// out so the engine's own rules apply. Placing ceilings is CL2: CanPlace is false and nothing is placed.
    /// </summary>
    public sealed class RevitCeilingTools : ICeilingTools
    {
        public bool CanPlace => false;
        public CeilingRequest Sample => null;

        public async Task<CeilingDesigns> DesignsAsync(CeilingRequest request)
        {
            var d = new CeilingDesigns();
            string problem;
            var args = Args("designs", request, "", out problem);
            if (args == null) { d.Message = problem; return d; }
            CliResult r = await ServerCli.RunAsync("fmc_ceiling", args);
            if (!r.Ok) { d.Message = Refusal("Designs", r); return d; }
            var b = r.Body;
            foreach (JObject o in (b["options"] as JArray ?? new JArray()).OfType<JObject>())
            {
                var option = new CeilingOption
                {
                    Id = o.Value<string>("id") ?? "", Kind = o.Value<string>("kind") ?? "", Label = o.Value<string>("label") ?? "",
                    Recommended = o.Value<bool?>("recommended") ?? false, BoardM2 = o.Value<double?>("board_m2") ?? 0, Sheets = o.Value<int?>("sheets") ?? 0,
                    Lux = o.Value<int?>("light_lx_indicative") ?? 0, Why = o.Value<string>("why") ?? "",
                };
                foreach (var h in (o["heights_mm"] as JArray ?? new JArray())) option.Heights.Add((int)Math.Round((double)h));
                if (o["checks"] is JObject c)
                {
                    option.Fail = c.Value<int?>("fail") ?? 0;
                    option.Decide = c.Value<int?>("decide") ?? 0;
                    option.Engineer = c.Value<int?>("engineer") ?? 0;
                    option.OkCount = c.Value<int?>("ok") ?? 0;
                }
                option.Flags.AddRange(Strings(o["flags"]));
                d.Options.Add(option);
            }
            foreach (JObject s in (b["skipped"] as JArray ?? new JArray()).OfType<JObject>())
                d.Skipped.Add((s.Value<string>("kind") ?? "") + ": " + (s.Value<string>("why") ?? ""));
            d.Note = b.Value<string>("note") ?? "";
            d.KitRequests.AddRange(Strings(b["kit_change_requests"]));
            d.KitProblems.AddRange(Strings(b["kit_problems"]));
            d.Ok = d.Options.Count > 0;
            d.Message = d.Ok ? d.Options.Count + " designs for " + request.Room + "." : "No design fits this room: " + string.Join("; ", d.Skipped);
            return d;
        }

        public async Task<CeilingEvaluation> EvaluateAsync(CeilingRequest request, string design)
        {
            var e = new CeilingEvaluation { Kind = design };
            string problem;
            var args = Args("checks", request, design, out problem);
            if (args == null) { e.Message = problem; return e; }

            CliResult checks = await ServerCli.RunAsync("fmc_ceiling", args);
            if (!checks.Ok) { e.Message = Refusal("Checks", checks); return e; }
            if (checks.Body["design"] is JObject head)
            {
                e.Label = head.Value<string>("label") ?? "";
                foreach (var h in (head["heights_mm"] as JArray ?? new JArray())) e.Heights.Add((int)Math.Round((double)h));
            }
            foreach (JObject c in (checks.Body["checks"] as JArray ?? new JArray()).OfType<JObject>())
                e.Checks.Add(new CeilingCheck(c.Value<string>("id") ?? "", c.Value<string>("check") ?? "", c.Value<string>("result") ?? "", c.Value<string>("detail") ?? ""));
            var kcr = new List<string>(Strings(checks.Body["kit_change_requests"]));

            args["action"] = "quantities";
            CliResult quantities = await ServerCli.RunAsync("fmc_ceiling", args);
            var areas = new Dictionary<string, double>();
            if (quantities.Ok && quantities.Body["quantities"] is JObject q)
            {
                e.FaceM2 = q.Value<double?>("face_m2") ?? 0;
                e.BoardM2 = q.Value<double?>("board_m2") ?? 0;
                e.Sheets = q.Value<int?>("sheets") ?? 0;
                e.Sheet = q.Value<string>("sheet") ?? "";
                e.MainM = q.Value<double?>("main_m") ?? 0;
                e.FurringM = q.Value<double?>("furring_m") ?? 0;
                e.Hangers = q.Value<int?>("hangers") ?? 0;
                e.CorniceM = q.Value<double?>("cornice_m") ?? 0;
                e.CoveLedM = q.Value<double?>("cove_led_m") ?? 0;
                e.JointTapeM = q.Value<double?>("joint_tape_m") ?? 0;
                e.PaintM2 = q.Value<double?>("paint_m2") ?? 0;
                e.Downlights = q.Value<int?>("downlights") ?? 0;
                e.Screws = q.Value<int?>("screws") ?? 0;
                e.Lux = quantities.Body.Value<int?>("light_lx_indicative") ?? 0;
                foreach (JObject z in (q["zones"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    var key = (z.Value<string>("zone") ?? "") + "@" + (z.Value<int?>("height_mm") ?? 0);
                    double prev;
                    areas[key] = (areas.TryGetValue(key, out prev) ? prev : 0) + (z.Value<double?>("area_m2") ?? 0);
                }
            }

            args["action"] = "setout";
            CliResult setout = await ServerCli.RunAsync("fmc_ceiling", args);
            if (setout.Ok && setout.Body["setout"] is JObject so)
                foreach (JObject z in (so["zones"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    var boards = (z["boards"] as JArray ?? new JArray()).OfType<JObject>().Select(x => x.Value<string>("id") ?? "").ToList();
                    var zone = z.Value<string>("zone") ?? "";
                    var height = z.Value<int?>("height_mm") ?? 0;
                    double area;
                    areas.TryGetValue(zone + "@" + height, out area);
                    e.Zones.Add(new CeilingZone(zone, height, area, boards.Count, boards.FirstOrDefault() ?? "", boards.LastOrDefault() ?? "", (z["slivers"] as JArray)?.Count ?? 0));
                }

            args["action"] = "boq";
            CliResult boq = await ServerCli.RunAsync("fmc_ceiling", args);
            if (boq.Ok)
            {
                foreach (JObject l in (boq.Body["lines"] as JArray ?? new JArray()).OfType<JObject>())
                    e.Boq.Add(new CeilingBoqLine
                    {
                        Item = l.Value<string>("item") ?? "", Qty = l.Value<double?>("qty") ?? 0, Unit = l.Value<string>("unit") ?? "", Keynote = l.Value<string>("keynote") ?? "",
                        Rate = l.Value<string>("rate_ugx") ?? "", PriceStatus = l.Value<string>("price_status") ?? "", TotalUgx = l.Value<long?>("total_ugx"), Note = l.Value<string>("note") ?? "",
                    });
                e.PricedTotalUgx = boq.Body.Value<long?>("priced_total_ugx") ?? 0;
                e.PriceNeeded = boq.Body.Value<int?>("lines_price_needed") ?? 0;
                kcr = Strings(boq.Body["kit_change_requests"]).ToList();
            }
            e.KitRequests.AddRange(kcr.Distinct());

            e.Ok = quantities.Ok && setout.Ok && boq.Ok;
            int fail = e.Checks.Count(c => c.Result == "Fail"), decide = e.Checks.Count(c => c.Result == "Decide");
            e.Message = e.Ok
                ? (e.Label.Length > 0 ? e.Label : design) + ": " + fail + " to fix, " + decide + " to decide."
                : "The answer came back incomplete: " + string.Join(" ", quantities.Reasons().Concat(setout.Reasons()).Concat(boq.Reasons()));
            return e;
        }

        public async Task<CeilingPack> PackAsync(CeilingRequest request, string design, string projectFolder, bool dryRun)
        {
            var pack = new CeilingPack();
            string problem;
            var args = Args("pack", request, design, out problem);
            if (args == null) { pack.Messages.Add(new ToolMessage(ChipKind.Bad, problem)); return pack; }
            args["project_folder"] = projectFolder;
            args["dry_run"] = dryRun;
            // dry_run=false writes only after the person said yes to the dry run in the pane's dialog.
            if (!dryRun) args["confirm"] = true;
            CliResult r = await ServerCli.RunAsync("fmc_ceiling", args);
            if (!r.Ok) { pack.Messages.Add(new ToolMessage(ChipKind.Bad, Refusal("Ceiling pack", r))); return pack; }
            pack.Ok = true;
            pack.Done = r.Body.Value<bool?>("done") ?? false;
            pack.Folder = r.Body.Value<string>("folder") ?? "";
            var rows = r.Body["rows"] as JObject;
            if (r.Body["files"] is JObject files)
                foreach (var p in files.Properties())
                {
                    var n = rows?.Value<int?>(p.Name);
                    pack.Files.Add(Path.GetFileName(p.Value.ToString()) + (n.HasValue ? " (" + n.Value + " rows)" : ""));
                }
            pack.Messages.Add(dryRun
                ? new ToolMessage(ChipKind.Info, "Dry run: " + pack.Files.Count + " files would be written to " + pack.Folder + ".")
                : new ToolMessage(ChipKind.Good, "Ceiling pack written: " + pack.Files.Count + " files in " + pack.Folder + ". Logged."));
            return pack;
        }

        public Task<ToolResult> PlaceAsync(CeilingRequest request, string design, bool dryRun) =>
            Task.FromResult(ToolResult.Refused("Placing ceilings in Revit comes with CL2 (fmc_ceiling_place): the add-in can't place them yet. Nothing was changed."));

        /// <summary>fmc_ceiling's room, fixtures and brief from the pane's fields; only what the person gave is sent.</summary>
        private static JObject Args(string action, CeilingRequest q, string design, out string problem)
        {
            problem = null;
            var room = new JObject
            {
                ["name"] = q.Room, ["width_mm"] = q.WidthMm, ["depth_mm"] = q.DepthMm,
                ["structure_height_mm"] = q.StructureHeightMm, ["structure"] = q.Structure,
            };
            if (q.TieSpacingMm.HasValue) room["tie_spacing_mm"] = q.TieSpacingMm.Value;

            var fixtures = new JObject();
            if (!string.IsNullOrWhiteSpace(q.FixturesFile))
            {
                try
                {
                    var file = JObject.Parse(File.ReadAllText(q.FixturesFile));
                    fixtures = (JObject)((file["fixtures"] as JObject) ?? file).DeepClone();
                }
                catch (Exception ex) { problem = "The fixtures file can't be read (" + q.FixturesFile + "): " + ex.Message; return null; }
            }
            if (q.FanAtCentre && fixtures["fan"] == null) fixtures["fan"] = new JObject { ["x"] = q.WidthMm / 2, ["y"] = q.DepthMm / 2 };

            var brief = new JObject { ["styles"] = new JArray(q.Styles.Distinct()) };
            if (!string.IsNullOrWhiteSpace(q.Board)) brief["board"] = q.Board.Trim();
            if (q.BulkheadWidthMm.HasValue) brief["bulkhead_width_mm"] = q.BulkheadWidthMm.Value;
            if (q.BulkheadDropMm.HasValue) brief["bulkhead_drop_mm"] = q.BulkheadDropMm.Value;
            if (q.RaftDropMm.HasValue) brief["raft_drop_mm"] = q.RaftDropMm.Value;
            if (q.CofferDropMm.HasValue) brief["coffer_drop_mm"] = q.CofferDropMm.Value;

            var args = new JObject { ["action"] = action, ["room"] = room, ["fixtures"] = fixtures, ["brief"] = brief };
            if (!string.IsNullOrEmpty(design)) args["design"] = design;
            return args;
        }

        /// <summary>A refusal in plain words; a server without fmc_ceiling says so instead of its usage line.</summary>
        private static string Refusal(string what, CliResult r)
        {
            var reasons = r.Reasons();
            if (reasons.Any(x => x.Contains("Usage:")))
                return "This server has no fmc_ceiling yet: the ceiling engine (PR #118) and its pane entry in the server's command line come first. Nothing was changed.";
            return what + " refused: " + string.Join(" ", reasons);
        }

        private static IEnumerable<string> Strings(JToken t) => (t as JArray ?? new JArray()).Select(x => x.ToString());
    }
}
