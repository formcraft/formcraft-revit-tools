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
    /// Engineer › Options in Revit: fmc_tree options through the installed server (docs/PLAN_OPTIONS.md). The nodes with
    /// variants are read straight from the tree file (01_WIP\_Tree\FMC_Recipe_Tree.json): fmc_tree show lists ids and kinds
    /// only, and reading a JSON file needs no server call. Everything else goes through the server.
    /// </summary>
    public sealed class RevitOptionsTools : IOptionsTools
    {
        public Task<(bool Ok, string Message, List<OptionNode> Nodes)> NodesAsync(string projectFolder)
        {
            string file = Path.Combine(Environment.ExpandEnvironmentVariables(projectFolder), "01_WIP", "_Tree", "FMC_Recipe_Tree.json");
            if (!File.Exists(file)) return Task.FromResult((false, "No recipe tree yet: " + file + " (ask Claude: fmc_tree brief or init).", new List<OptionNode>()));
            try
            {
                var nodes = new List<OptionNode>();
                void Walk(JObject n)
                {
                    if (n["variants"] is JArray v && v.Count > 0)
                        nodes.Add(new OptionNode(n.Value<string>("id") ?? "", n.Value<string>("name") ?? "", n.Value<string>("kind") ?? "", n.Value<string>("active") ?? "base", v.Count));
                    foreach (var c in (n["children"] as JArray ?? new JArray()).OfType<JObject>()) Walk(c);
                }
                if (JObject.Parse(File.ReadAllText(file))["root"] is JObject root) Walk(root);
                return Task.FromResult((true, nodes.Count + " nodes with options.", nodes));
            }
            catch (Exception e)
            {
                return Task.FromResult((false, "The recipe tree can't be read: " + e.Message, new List<OptionNode>()));
            }
        }

        private static List<string> Strings(JToken t) => (t as JArray ?? new JArray()).Select(x => x.ToString()).ToList();

        private static OptionMeasures Measures(JObject o) => new OptionMeasures
        {
            Variant = o.Value<string>("variant") ?? "", Name = o.Value<string>("name") ?? "",
            Rooms = o.Value<int?>("rooms") ?? 0, AreaM2 = o.Value<double?>("area_m2") ?? 0, TargetM2 = o.Value<double?>("target_m2") ?? 0,
            OffTarget = Strings(o["off_target"]), WallsM2 = o.Value<double?>("walls_m2") ?? 0, CeilingsM2 = o.Value<double?>("ceilings_m2") ?? 0,
            Doors = o.Value<int?>("doors") ?? 0, Windows = o.Value<int?>("windows") ?? 0,
            GlazingM2 = o.Value<double?>("glazing_m2"), DaylightPct = o.Value<double?>("daylight_pct"), DaylightNote = o.Value<string>("daylight_note") ?? "",
            Families = (o["families"] as JObject ?? new JObject()).Properties().ToDictionary(p => p.Name, p => p.Value.Value<int?>() ?? 0),
            Problems = Strings(o["problems"]),
        };

        public async Task<OptionsComparison> CompareAsync(string projectFolder, string node)
        {
            CliResult r = await ServerCli.RunAsync("fmc_tree", new JObject
            {
                ["action"] = "options", ["op"] = "compare", ["project_folder"] = projectFolder, ["id"] = node, ["dry_run"] = true,
            });
            if (!r.Ok || !(r.Body["options"] is JArray options)) return new OptionsComparison { Ok = false, Node = node, Message = "Options: " + string.Join(" ", r.Reasons()) };
            var list = options.OfType<JObject>().Select(Measures).ToList();
            return new OptionsComparison
            {
                Ok = true, Node = r.Body.Value<string>("node") ?? node, Active = r.Body.Value<string>("active") ?? "base",
                Options = list, Differs = Strings(r.Body["differs"]), Message = list.Count + " options of " + node + ".",
            };
        }

        /// <summary>The dry run's would_rebuild list as the confirm dialog's lines; the real run's messages.</summary>
        private static ToolResult Result(CliResult r, string op, bool dryRun)
        {
            if (!r.Ok) return ToolResult.Refused(op + " refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            if (dryRun)
            {
                var lines = Strings(r.Body["would_rebuild"]);
                result.Count = lines.Count;
                result.Details.AddRange(lines);
                return result;
            }
            var rebuild = Strings(r.Body["to_rebuild"]);
            string node = r.Body.Value<string>("node"), variant = r.Body.Value<string>("variant");
            result.Messages.Add(new ToolMessage(ChipKind.Good, (op == "Choose" ? $"{variant} is now {node}; the node as it was is kept as a variant." : $"{variant} is the active option of {node}.")
                + (rebuild.Count > 0 ? $" {rebuild.Count} to rebuild: fmc_tree plan, then build (dry run first)." : "") + " Logged in FMC_MCP_FileLog.csv."));
            if (r.Body.Value<string>("revit") is string revit) result.Messages.Add(new ToolMessage(ChipKind.Warn, revit + "."));
            return result;
        }

        public async Task<ToolResult> ActivateAsync(string projectFolder, string node, string variant, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_tree", new JObject
            {
                ["action"] = "options", ["op"] = "activate", ["project_folder"] = projectFolder, ["id"] = node, ["variant"] = variant == "base" ? "" : variant, ["dry_run"] = dryRun,
            });
            return Result(r, "Make active", dryRun);
        }

        public async Task<ToolResult> ChooseAsync(string projectFolder, string node, string variant, string by, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_tree", new JObject
            {
                ["action"] = "options", ["op"] = "choose", ["project_folder"] = projectFolder, ["id"] = node, ["variant"] = variant, ["by"] = by, ["dry_run"] = dryRun,
            });
            return Result(r, "Choose", dryRun);
        }

        public async Task<(bool Ok, string Message, string Folder)> SaveAsync(string projectFolder, string node)
        {
            CliResult r = await ServerCli.RunAsync("fmc_tree", new JObject
            {
                ["action"] = "options", ["op"] = "compare", ["project_folder"] = projectFolder, ["id"] = node, ["dry_run"] = false,
            });
            string folder = r.Body.Value<string>("folder") ?? "";
            if (!r.Ok || folder.Length == 0) return (false, "Save refused: " + string.Join(" ", r.Reasons()), "");
            int n = (r.Body["options"] as JArray)?.Count ?? 0;
            return (true, $"Comparison saved: a sheet, a CSV and {n} plan sketches. Logged in FMC_MCP_FileLog.csv.", folder);
        }
    }
}
