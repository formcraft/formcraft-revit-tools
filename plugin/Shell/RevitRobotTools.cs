using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Engineer › Structural › Robot in Revit: everything goes through fmc_robot (track R).</summary>
    public sealed class RevitRobotTools : IRobotTools
    {
        public async Task<RobotResult> StatusAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_robot", new JObject { ["action"] = "status" });
            var s = new RobotResult { Ok = r.Ok };
            if (!r.Ok) { s.Message = "Robot status: " + string.Join(" ", r.Reasons()); return s; }
            s.Installed = r.Body.Value<bool?>("installed") == true;
            s.Running = r.Body.Value<bool?>("running") == true;
            s.Runs.AddRange((r.Body["runs"] as JArray ?? new JArray()).Select(x => x.ToString()));
            string error = r.Body.Value<string>("error") ?? "";
            s.Message = error.Length > 0 ? error : !s.Installed ? "Robot isn't installed on this PC." : s.Running ? "Robot is installed and running." : "Robot is installed, not running.";
            return s;
        }

        public async Task<RobotResult> SendAsync(RobotForm form, bool dryRun)
        {
            var input = new JObject
            {
                ["action"] = "send", ["supports"] = form.Supports, ["engineer"] = form.Engineer, ["dry_run"] = dryRun,
                ["cases"] = new JArray(form.Cases.Select(c => new JObject { ["name"] = c.Name, ["nature"] = c.Nature, ["self_weight"] = c.SelfWeight })),
            };
            CliResult r = await ServerCli.RunAsync("fmc_robot", input);
            var s = new RobotResult { Ok = r.Ok };
            if (!r.Ok) { s.Message = "Not sent: " + string.Join(" ", r.Reasons()); return s; }
            JObject b = r.Body;
            s.Run = b.Value<string>("run") ?? "";
            int skipped = (b["skipped"] as JArray)?.Count ?? 0, without = b.Value<int?>("without_analytical") ?? 0;
            s.Lines.Add(("Nodes", b.Value<string>("nodes") ?? "0", "ends merged within 1 mm"));
            s.Lines.Add(("Bars", b.Value<string>("bars") ?? "0", "columns and beams with an analytical member"));
            s.Lines.Add(("Supports", b.Value<string>("supports") ?? "", "column bases not on another column"));
            if (skipped + without > 0) s.Lines.Add(("Not sent", (skipped + without).ToString(CultureInfo.InvariantCulture), without + " without an analytical member, " + skipped + " with no length"));
            int unresolved = (b["robot"]?["unresolved_sections"] as JArray)?.Count ?? 0;
            if (unresolved > 0) s.Lines.Add(("Sections", unresolved.ToString(CultureInfo.InvariantCulture), "not found in Robot's databases: the engineer assigns them in Robot"));
            s.Message = dryRun
                ? $"{b.Value<string>("nodes")} nodes, {b.Value<string>("bars")} bars and {b.Value<string>("supports")} supports would go to Robot."
                : $"Sent as {s.Run}. In Robot, add the loads, combinations and code, then calculate.";
            return s;
        }

        public async Task<RobotResult> CalculateAsync(string run)
        {
            CliResult r = await ServerCli.RunAsync("fmc_robot", new JObject { ["action"] = "calculate", ["run"] = run });
            var s = new RobotResult { Ok = r.Ok && r.Body.Value<bool?>("calculated") == true, Run = run };
            s.Message = !r.Ok ? "Not calculated: " + string.Join(" ", r.Reasons())
                : s.Ok ? "Robot calculated " + run + "." : "Robot couldn't calculate " + run + " (status " + r.Body.Value<string>("status") + "): open it in Robot to see why.";
            return s;
        }

        public async Task<RobotResult> ResultsAsync(string run, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_robot", new JObject { ["action"] = "results", ["run"] = run, ["dry_run"] = dryRun });
            var s = new RobotResult { Ok = r.Ok, Run = run };
            if (!r.Ok) { s.Message = "No results: " + string.Join(" ", r.Reasons()); return s; }
            JObject revit = r.Body["revit"] as JObject ?? new JObject();
            foreach (JObject row in (revit["rows"] as JArray ?? new JArray()).OfType<JObject>())
            {
                if (row["after"] is not JObject after) continue;
                s.Lines.Add((row.Value<string>("id") ?? "", after.Value<string>("FMC_FEA_NEd_kN") ?? "", after.Value<string>("FMC_FEA_MEd_kNm") ?? ""));
            }
            s.Count = s.Lines.Count;
            var missing = (revit["not_in_model"] as JArray ?? new JArray()).Select(x => x.ToString()).ToList();
            string gap = missing.Count > 0 ? " Not in this model's parameters: " + string.Join(", ", missing) + "." : "";
            s.Message = dryRun ? $"{s.Count} members have results to write.{gap}" : $"Wrote {revit.Value<string>("values_set") ?? "0"} values for {s.Count} members ({run}).{gap}";
            return s;
        }
    }
}
