using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Check › Reports in Revit: fmc_report through the installed server.</summary>
    public sealed class RevitReportTools : IReportTools
    {
        private static JObject Args(ReportRequest q, bool dryRun)
        {
            var formats = new JArray();
            if (q.Markdown) formats.Add("markdown");
            if (q.Csv) formats.Add("csv");
            return new JObject
            {
                ["action"] = "make", ["project_folder"] = q.ProjectFolder, ["project_code"] = q.ProjectCode, ["originator"] = q.Originator,
                ["kind"] = q.Kind, ["period"] = q.Period, ["audience"] = q.Audience, ["disciplines"] = JArray.FromObject(q.Disciplines),
                ["formats"] = formats, ["dry_run"] = dryRun,
            };
        }

        public async Task<(bool Ok, string Message, string Preview, List<string> LeftOut)> PreviewAsync(ReportRequest q)
        {
            CliResult r = await ServerCli.RunAsync("fmc_report", Args(q, true));
            if (!r.Ok) return (false, "Report refused: " + string.Join(" ", r.Reasons()), "", new List<string>());
            return (true, "Preview of " + (r.Body.Value<string>("title") ?? q.Kind) + ".", r.Body.Value<string>("preview") ?? "", RevitFamilyTools.Strings(r.Body["left_out"]));
        }

        public async Task<ToolResult> MakeAsync(ReportRequest q)
        {
            CliResult r = await ServerCli.RunAsync("fmc_report", Args(q, false));
            if (!r.Ok) return ToolResult.Refused("Report refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true, Count = 1 };
            result.Messages.Add(new ToolMessage(ChipKind.Good, "Saved " + r.Body.Value<string>("name") + ": " +
                string.Join(", ", RevitFamilyTools.Strings(r.Body["files"]).Select(System.IO.Path.GetFileName)) + "."));
            return result;
        }

        public async Task<List<(string File, string Date)>> RecentAsync(string projectFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_report", new JObject { ["action"] = "list", ["project_folder"] = projectFolder });
            return (r.Body["reports"] as JArray ?? new JArray()).OfType<JObject>().Select(x => (x.Value<string>("file") ?? "", x.Value<string>("date") ?? "")).ToList();
        }
    }
}
