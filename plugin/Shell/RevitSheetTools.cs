using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Drawings › Sheets in Revit: fmc_sheets through the installed server.</summary>
    public sealed class RevitSheetTools : ISheetTools
    {
        private static JObject Args(string action, string register, string issueSet, IReadOnlyList<string> roles) =>
            new JObject { ["action"] = action, ["register"] = register, ["issue_set"] = issueSet, ["roles"] = JArray.FromObject(roles) };

        public async Task<SheetComparison> CompareAsync(string register, string issueSet, IReadOnlyList<string> roles)
        {
            CliResult r = await ServerCli.RunAsync("fmc_sheets", Args("compare", register, issueSet, roles));
            var c = new SheetComparison { Ok = r.Ok && r.Body["differences"] != null };
            if (!c.Ok) { c.Message = "Compare refused: " + string.Join(" ", r.Reasons()); return c; }
            var b = r.Body;
            c.Model = b.Value<string>("model") ?? "";
            c.Planned = b.Value<int?>("planned") ?? 0;
            c.InModel = b.Value<int?>("in_model") ?? 0;
            foreach (JObject d in ((JArray)b["differences"]).OfType<JObject>())
                c.Differences.Add(new SheetDiff(d.Value<string>("number"), d.Value<string>("difference"), d.Value<string>("register_name") ?? "", d.Value<string>("model_name") ?? ""));
            foreach (JObject x in (b["completeness"] as JArray ?? new JArray()).OfType<JObject>())
                c.Completeness.Add(new SheetProgress(x.Value<string>("number"), x.Value<string>("name") ?? "", x.Value<int?>("views") ?? 0, x.Value<int?>("filled") ?? 0,
                    x.Value<int?>("fields") ?? 0, x.Value<string>("status") ?? "", x.Value<int?>("percent") ?? 0));
            c.TitleBlocks.AddRange(RevitFamilyTools.Strings(b["title_blocks"]));
            c.Problems.AddRange(RevitFamilyTools.Strings(b["problems"]));
            c.Message = $"Compared {c.Planned} planned sheets with {c.Model}: {c.Differences.Count} differences.";
            return c;
        }

        public Task<ToolResult> CreateAsync(string register, string issueSet, IReadOnlyList<string> roles, string titleBlock, bool dryRun)
        {
            var args = Args("create", register, issueSet, roles);
            args["title_block"] = titleBlock;
            return Run(args, dryRun, "Created");
        }

        public Task<ToolResult> RenameAsync(string register, string issueSet, IReadOnlyList<string> roles, bool dryRun) =>
            Run(Args("rename", register, issueSet, roles), dryRun, "Renamed");

        private static async Task<ToolResult> Run(JObject args, bool dryRun, string verb)
        {
            args["dry_run"] = dryRun;
            CliResult r = await ServerCli.RunAsync("fmc_sheets", args);
            if (!r.Ok) return ToolResult.Refused(verb + " refused: " + string.Join(" ", r.Reasons()));
            if (r.Body.Value<bool?>("nothing") == true) return new ToolResult { Ok = true };
            var list = ((dryRun ? r.Body["would"] : r.Body["sheets"]) as JArray ?? new JArray()).OfType<JObject>().ToList();
            var result = new ToolResult { Ok = true, Count = list.Count };
            if (dryRun)
                result.Details.AddRange(list.Select(s => s.Value<string>("number") + "  " + (s["from"] != null ? s.Value<string>("from") + " → " : "") + s.Value<string>("name")));
            else
                result.Messages.Add(new ToolMessage(ChipKind.Good, $"{verb} {list.Count(s => (s.Value<string>("result") ?? "").StartsWith(verb.ToLowerInvariant()))} sheets. Logged in FMC_MCP_FileLog.csv."));
            return result;
        }
    }
}
