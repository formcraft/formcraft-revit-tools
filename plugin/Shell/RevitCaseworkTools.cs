using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Engineer › Casework in Revit (CW3): fmc_casework through the installed server, the very engine Claude uses. The run
    /// and, while the kit has none, the workshop standards come from the person's run file; the pane adds nothing (rule 7).
    /// Placing units is CW2 (fmc_casework_place): not in the add-in yet, so CanPlace is false and nothing is placed.
    /// </summary>
    public sealed class RevitCaseworkTools : ICaseworkTools
    {
        public bool CanPlace => false;
        public string SampleRunFile => null;

        public async Task<CaseworkLayout> LayOutAsync(CaseworkRequest request)
        {
            var layout = new CaseworkLayout { FromUnitList = request.Units != null };
            string problem;
            var args = Args("summary", request, out problem);
            if (args == null) { layout.Message = problem; return layout; }
            AddStandards(layout, args["standards"] as JObject);

            CliResult sum = await ServerCli.RunAsync("fmc_casework", args);
            if (!sum.Ok)
            {
                layout.Message = "Lay out refused: " + string.Join(" ", sum.Reasons());
                foreach (var m in (sum.Body["missing"] as JArray ?? new JArray())) layout.Missing.Add(m.ToString());
                layout.StandardsFrom = sum.Body.Value<string>("kit_standards") ?? "";
                return layout;
            }
            var b = sum.Body;
            layout.StandardsFrom = b.Value<string>("standards_from") ?? "";
            layout.Problems.AddRange(Strings(b["problems"]));
            layout.Notes.AddRange(Strings(b["notes"]));
            layout.UnitCount = b.Value<int?>("units") ?? 0;
            layout.PartLines = b.Value<int?>("part_lines") ?? 0;
            layout.Pieces = b.Value<int?>("pieces") ?? 0;
            layout.Sheets = b.Value<int?>("sheets") ?? 0;
            layout.EdgeM = b.Value<double?>("edge_m") ?? 0;
            layout.WorktopM = b.Value<double?>("worktop_m") ?? 0;
            foreach (JObject x in (b["boards"] as JArray ?? new JArray()).OfType<JObject>())
                layout.Boards.Add(new CaseworkBoard(x.Value<string>("material") ?? "", x.Value<int?>("sheets") ?? 0, x.Value<int?>("parts") ?? 0, x.Value<int?>("yield_pct") ?? 0));
            if (b["hardware"] is JObject hw)
                foreach (var p in hw.Properties()) layout.Hardware.Add((p.Name, p.Value.Type == JTokenType.Integer || p.Value.Type == JTokenType.Float ? (double)p.Value : 0));
            foreach (JObject f in (b["fillers"] as JArray ?? new JArray()).OfType<JObject>())
                layout.Fillers.Add("Wall " + f.Value<string>("wall") + ", " + f.Value<string>("layer") + ", " + f.Value<int?>("width") + " at " + f.Value<int?>("offset"));
            if (b["cost"] is JObject cost)
            {
                foreach (JObject l in (cost["lines"] as JArray ?? new JArray()).OfType<JObject>())
                    layout.Cost.Add(new CaseworkCostLine(l.Value<string>("item") ?? "", l.Value<string>("material") ?? "", l.Value<string>("price") ?? "price needed",
                                                         l.Value<string>("status") ?? "", l.Value<string>("source") ?? "", l.Value<string>("date") ?? ""));
                if (cost["total"] is JObject total)
                {
                    layout.CostLow = total.Value<long?>("ugx_low") ?? 0;
                    layout.CostHigh = total.Value<long?>("ugx_high") ?? 0;
                }
            }
            foreach (JObject k in (b["kit_requests"] as JArray ?? new JArray()).OfType<JObject>())
                layout.KitRequests.Add((k.Value<string>("item") ?? "") + ": " + (k.Value<string>("request") ?? ""));
            if (b["library"] != null) layout.KitRequests.Add(b.Value<string>("library"));

            args["action"] = "units";
            CliResult units = await ServerCli.RunAsync("fmc_casework", args);
            if (units.Ok)
            {
                foreach (JObject u in (units.Body["units"] as JArray ?? new JArray()).OfType<JObject>())
                    layout.Units.Add(new CaseworkUnit
                    {
                        Mark = u.Value<string>("mark") ?? "", Kind = u.Value<string>("kind") ?? "", Width = u.Value<int?>("width") ?? 0,
                        Wall = u.Value<string>("wall") ?? "", Offset = u.Value<int?>("offset") ?? 0, Fronts = u.Value<string>("fronts") ?? "",
                        Layer = u.Value<string>("layer") ?? "base",
                    });
                foreach (JObject w in (units.Body["worktop"] as JArray ?? new JArray()).OfType<JObject>())
                    layout.Worktop.Add(w.Value<string>("wall") + " " + w.Value<int?>("from") + "–" + w.Value<int?>("to"));
            }

            args["action"] = "cutlist";
            CliResult cut = await ServerCli.RunAsync("fmc_casework", args);
            if (cut.Ok)
                foreach (JObject r in (cut.Body["rows"] as JArray ?? new JArray()).OfType<JObject>())
                    layout.CutList.Add(new CaseworkCutRow(r.Value<string>("mark") ?? "", r.Value<string>("part") ?? "", r.Value<int?>("length") ?? 0,
                                                          r.Value<int?>("width") ?? 0, r.Value<int?>("qty") ?? 0, r.Value<string>("board") ?? "", r.Value<string>("edge") ?? ""));

            layout.Ok = units.Ok && cut.Ok;
            layout.Message = layout.Ok
                ? layout.UnitCount + " units, " + layout.Pieces + " panels on " + layout.Sheets + " sheets."
                : "The layout came back incomplete: " + string.Join(" ", units.Reasons().Concat(cut.Reasons()));
            return layout;
        }

        public async Task<CaseworkPack> PackAsync(CaseworkRequest request, string projectFolder, string projectCode, bool dryRun)
        {
            var pack = new CaseworkPack();
            string problem;
            var args = Args("pack", request, out problem);
            if (args == null) { pack.Messages.Add(new ToolMessage(ChipKind.Bad, problem)); return pack; }
            args["project_folder"] = projectFolder;
            args["project_code"] = projectCode;
            args["label"] = request.Label;
            args["dry_run"] = dryRun;
            CliResult r = await ServerCli.RunAsync("fmc_casework", args);
            if (!r.Ok)
            {
                pack.Messages.Add(new ToolMessage(ChipKind.Bad, "Workshop pack refused: " + string.Join(" ", r.Reasons())));
                return pack;
            }
            pack.Ok = true;
            pack.Done = r.Body.Value<bool?>("done") ?? false;
            pack.Folder = r.Body.Value<string>("folder") ?? "";
            foreach (JObject f in (r.Body["files"] as JArray ?? new JArray()).OfType<JObject>())
                pack.Files.Add((f.Value<string>("file") ?? "", f.Value<int?>("rows") ?? 0, f.Value<string>("action") ?? ""));
            var written = pack.Files.Count(f => f.Action != "unchanged");
            pack.Messages.Add(dryRun
                ? new ToolMessage(ChipKind.Info, "Dry run: " + pack.Files.Count + " files for " + pack.Folder + " (" + written + " new or replaced).")
                : new ToolMessage(ChipKind.Good, "Workshop pack written: " + written + " files in " + pack.Folder + ". Logged."));
            return pack;
        }

        public Task<ToolResult> PlaceAsync(CaseworkRequest request, bool dryRun) =>
            Task.FromResult(ToolResult.Refused("Placing units in Revit comes with CW2 (fmc_casework_place): the add-in can't place them yet. Nothing was changed."));

        /// <summary>The call's arguments: the run from the person's file (with fronts from the unit editor) or the editor's unit list, and the file's standards.</summary>
        private static JObject Args(string action, CaseworkRequest q, out string problem)
        {
            problem = null;
            if (string.IsNullOrWhiteSpace(q.RunFile)) { problem = "Choose the run file first."; return null; }
            JObject file;
            try { file = JObject.Parse(File.ReadAllText(q.RunFile)); }
            catch (Exception ex) { problem = "The run file can't be read (" + q.RunFile + "): " + ex.Message; return null; }
            var args = new JObject { ["action"] = action };
            if (q.Units != null)
            {
                args["units"] = new JArray(q.Units.Select(u => new JObject
                {
                    ["mark"] = u.Mark, ["kind"] = u.Kind, ["width"] = u.Width, ["wall"] = u.Wall, ["offset"] = u.Offset, ["fronts"] = u.Fronts, ["layer"] = u.Layer,
                }));
            }
            else
            {
                var run = file["run"] as JObject ?? (file["walls"] != null ? file : null);
                if (run == null) { problem = "The run file has no run: it needs walls and modules (see server\\src\\fmc\\fixtures\\cw_kitchen.json)."; return null; }
                run = (JObject)run.DeepClone();
                run.Remove("standards");
                if (q.Fronts.Count > 0)
                {
                    var fronts = run["fronts"] as JObject ?? new JObject();
                    foreach (var kv in q.Fronts) fronts[kv.Key] = kv.Value;
                    run["fronts"] = fronts;
                }
                args["run"] = run;
            }
            if (file["standards"] is JObject standards) args["standards"] = standards;
            return args;
        }

        /// <summary>The standards sent with the call, as the Room step shows them (the kit's own file is named, not read, here).</summary>
        private static void AddStandards(CaseworkLayout layout, JObject s)
        {
            if (s == null) return;
            string N(JToken t) => t == null ? "" : Convert.ToString(t, CultureInfo.InvariantCulture);
            var sheet = s["sheet"] as JObject;
            var b = s["base"] as JObject;
            var w = s["wall"] as JObject;
            var tall = s["tall"] as JObject;
            if (s["worktop_depth"] != null) layout.Standards.Add(("Worktop depth", N(s["worktop_depth"])));
            if (b != null) layout.Standards.Add(("Base units", N(b["height"]) + " high, " + N(b["depth"]) + " deep" + (s["plinth"] != null ? ", on " + N(s["plinth"]) + " legs" : "")));
            if (w != null) layout.Standards.Add(("Wall units", N(w["height"]) + " high, " + N(w["depth"]) + " deep"));
            if (tall != null) layout.Standards.Add(("Tall units", N(tall["height"]) + " high, " + N(tall["depth"]) + " deep"));
            if (s["carcass_board"] != null) layout.Standards.Add(("Carcass board", N(s["carcass_board"]) + (s["carcass_thickness"] != null ? " (" + N(s["carcass_thickness"]) + ")" : "")));
            if (s["front_board"] != null) layout.Standards.Add(("Fronts", N(s["front_board"])));
            if (s["back_board"] != null) layout.Standards.Add(("Backs", N(s["back_board"])));
            if (sheet != null) layout.Standards.Add(("Sheet", N(sheet["length"]) + " × " + N(sheet["width"]) + (s["kerf"] != null ? ", kerf " + N(s["kerf"]) : "")));
        }

        private static IEnumerable<string> Strings(JToken t) => (t as JArray ?? new JArray()).Select(x => x.ToString());
    }
}
