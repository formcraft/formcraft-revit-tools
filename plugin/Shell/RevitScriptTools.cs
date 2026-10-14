using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Check › Scripts in Revit: fmc_scripts through the installed server.</summary>
    public sealed class RevitScriptTools : IScriptTools
    {
        public async Task<(bool Ok, string Message, List<ScriptInfo> Scripts)> ListAsync(string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_scripts", new JObject { ["action"] = "list", ["kit_folder"] = kitFolder });
            if (!r.Ok || !(r.Body["scripts"] is JArray list)) return (false, "Can't read the kit's scripts: " + string.Join(" ", r.Reasons()), new List<ScriptInfo>());
            var scripts = list.OfType<JObject>().Select(x =>
            {
                var s = new ScriptInfo
                {
                    Name = x.Value<string>("name") ?? "", Type = x.Value<string>("type") ?? "", File = x.Value<string>("file") ?? "",
                    Does = x.Value<string>("does") ?? "", Status = x.Value<string>("status") ?? "", Manual = x.Value<string>("manual") ?? "",
                    ChangesModel = x.Value<bool?>("changes_model") ?? false, RunsIn = x.Value<string>("runs_in") ?? "", Formcraft = x.Value<string>("formcraft") ?? "",
                };
                s.Inputs.AddRange(RevitFamilyTools.Strings(x["inputs"]));
                return s;
            }).ToList();
            return (true, scripts.Count + " scripts in the kit's 05_Scripts.", scripts);
        }

        public async Task<AutomationRun> RunAsync(Automation automation, string kitFolder, string projectFolder, string projectCode)
        {
            var args = new JObject
            {
                ["action"] = "run", ["name"] = automation.Name, ["steps"] = JArray.FromObject(automation.Steps), ["kit_folder"] = kitFolder,
                ["project_folder"] = projectFolder, ["project_code"] = projectCode,
            };
            CliResult r = await ServerCli.RunAsync("fmc_scripts", args);
            var run = new AutomationRun();
            if (!r.Ok || !(r.Body["results"] is JArray results)) { run.Message = "Refused: " + string.Join(" ", r.Reasons()); return run; }
            foreach (JObject x in results.OfType<JObject>())
                run.Steps.Add((x.Value<string>("title") ?? "", x.Value<bool?>("ok") ?? false, x.Value<string>("summary") ?? ""));
            run.Skipped.AddRange(RevitFamilyTools.Strings(r.Body["skipped"]));
            run.Ok = r.Body.Value<bool?>("done") ?? false;
            run.Message = run.Ok ? "Every step ran. Logged in FMC_MCP_FileLog.csv." : "Stopped at " + (r.Body.Value<string>("stopped_at") ?? "a step") + "; the steps after it didn't run.";
            return run;
        }
    }
}
