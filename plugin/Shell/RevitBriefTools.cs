using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Model › Start from brief in Revit: fmc_brief through the installed server.</summary>
    public sealed class RevitBriefTools : IBriefTools
    {
        public async Task<BriefPlan> PlanAsync(string cisFile, string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_brief", new JObject { ["action"] = "plan", ["cis_file"] = cisFile, ["kit_folder"] = kitFolder });
            var p = new BriefPlan { Ok = r.Ok && r.Body["plan"] != null };
            if (!p.Ok) { p.Message = "Can't read the CIS: " + string.Join(" ", r.Reasons()); return p; }
            var b = r.Body;
            var cis = b["cis"] as JObject ?? new JObject();
            p.Project = cis.Value<string>("project") ?? "";
            p.Revision = cis.Value<string>("revision") ?? "";
            p.Approved = cis.Value<string>("approved") ?? "";
            var c = b["counts"] as JObject ?? new JObject();
            p.Levels = c.Value<int?>("levels") ?? 0;
            p.ProjectInfo = c.Value<int?>("project_info") ?? 0;
            p.Rooms = c.Value<int?>("rooms") ?? 0;
            p.Families = c.Value<int?>("families") ?? 0;
            var plan = (JObject)b["plan"];
            p.Blanks.AddRange(RevitFamilyTools.Strings(plan["blanks"]));
            p.Problems.AddRange(RevitFamilyTools.Strings(plan["problems"]));
            p.Skipped.AddRange(RevitFamilyTools.Strings(plan["skipped"]));
            foreach (JObject room in (plan["rooms"] as JArray ?? new JArray()).OfType<JObject>().Take(6))
            {
                var par = room["params"] as JObject ?? new JObject();
                p.RoomRows.Add((room.Value<string>("number") ?? "", room.Value<string>("name") ?? "",
                    par["FMC_Target_Area"]?.ToString() ?? "", par["FMC_Finish_Set"]?.ToString() ?? ""));
            }
            p.Model = (b["model"] as JObject)?.Value<string>("title") ?? "";
            p.ModelProblem = b.Value<string>("model_problem") ?? "";
            p.Message = $"CIS {p.Revision} · approved {p.Approved}";
            return p;
        }

        public async Task<ToolResult> ApplyAsync(string cisFile, string kitFolder, bool dryRun)
        {
            var args = new JObject { ["action"] = "apply", ["cis_file"] = cisFile, ["kit_folder"] = kitFolder, ["dry_run"] = dryRun };
            CliResult r = await ServerCli.RunAsync("fmc_brief", args);
            if (!r.Ok) return ToolResult.Refused("Start from brief refused: " + string.Join(" ", r.Reasons()));
            var x = r.Body["result"] as JObject ?? new JObject();
            var result = new ToolResult { Ok = true };
            string counts = $"{x.Value<int?>("levels_created") ?? 0} levels ({x.Value<int?>("plans_created") ?? 0} floor plans), " +
                            $"{x.Value<int?>("rooms_created") ?? 0} rooms ({x.Value<int?>("room_values_set") ?? 0} room values), " +
                            $"{x.Value<int?>("project_info_set") ?? 0} Project Information values, {x.Value<int?>("families_loaded") ?? 0} families";
            var notes = RevitFamilyTools.Strings(x["notes"]).Concat(RevitFamilyTools.Strings(r.Body["skipped"])).ToList();
            if (dryRun)
            {
                result.Details.Add("Would create: " + counts);
                result.Details.AddRange(notes);
                result.Count = result.Details.Count;
            }
            else
            {
                result.Messages.Add(new ToolMessage(ChipKind.Good, "Model set up from the brief: " + counts + ". One Undo; logged in FMC_MCP_FileLog.csv."));
                result.Messages.AddRange(notes.Select(n => new ToolMessage(ChipKind.Info, n)));
            }
            return result;
        }
    }
}
