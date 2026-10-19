using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Check › Automation in Revit: fmc_balance through the installed server (F74). The server reads its own call ledger
    /// (%APPDATA%\Formcraft\ledger); the pane's own calls are recorded there as started by the pane (ServerCli sets it).
    /// Nothing here talks to Revit.
    /// </summary>
    public sealed class RevitBalanceTools : IBalanceTools
    {
        private static List<BalanceShare> Shares(JToken t) => (t as JArray ?? new JArray()).OfType<JObject>()
            .Select(x => new BalanceShare(x.Value<string>("key") ?? "", x.Value<string>("label") ?? "", x.Value<int?>("calls") ?? 0, x.Value<double?>("share") ?? 0))
            .ToList();

        public async Task<BalanceSummary> SummaryAsync(int weeks, string project)
        {
            CliResult r = await ServerCli.RunAsync("fmc_balance", new JObject { ["action"] = "summary", ["weeks"] = weeks, ["project"] = project ?? "" });
            if (!r.Ok) return new BalanceSummary { Ok = false, Message = "Can't read the call ledger: " + string.Join(" ", r.Reasons()) };
            var b = r.Body;
            var s = new BalanceSummary
            {
                Ok = true, From = b.Value<string>("from") ?? "", To = b.Value<string>("to") ?? "", Total = b.Value<int?>("total") ?? 0,
                AiShare = b.Value<double?>("ai_share") ?? 0,
            };
            s.Message = s.Total + " calls from " + s.From + " to " + s.To + ".";
            s.ByKind.AddRange(Shares(b["by_kind"]));
            s.PluginByStartedBy.AddRange(Shares(b["plugin_by_started_by"]));
            s.ExternalByKind.AddRange(Shares(b["external_by_kind"]));
            s.Weeks.AddRange((b["weeks"] as JArray ?? new JArray()).OfType<JObject>()
                .Select(w => new BalanceWeek(w.Value<string>("week") ?? "", w.Value<int?>("total") ?? 0, w.Value<double?>("ai_share") ?? 0)));
            return s;
        }

        public async Task<(bool Ok, string Message, List<BacklogItem> Items)> BacklogAsync(int weeks, string project)
        {
            CliResult r = await ServerCli.RunAsync("fmc_balance", new JObject { ["action"] = "backlog", ["weeks"] = weeks, ["project"] = project ?? "", ["limit"] = 30 });
            if (!r.Ok || !(r.Body["items"] is JArray items)) return (false, "Can't read the move list: " + string.Join(" ", r.Reasons()), new List<BacklogItem>());
            var list = items.OfType<JObject>().Select(x =>
            {
                var b = new BacklogItem
                {
                    Rank = x.Value<int?>("rank") ?? 0, Purpose = x.Value<string>("purpose") ?? "", Calls = x.Value<int?>("calls") ?? 0,
                    Errors = x.Value<int?>("errors") ?? 0, Ms = x.Value<long?>("ms") ?? 0, Home = x.Value<string>("home") ?? "",
                    Scripts = x.Value<string>("scripts") ?? "", Priority = x.Value<string>("priority") ?? "", Status = x.Value<string>("status") ?? "",
                    TrackerStatus = x.Value<string>("tracker_status") ?? "", Feature = x.Value<string>("feature") ?? "", Last = x.Value<string>("last") ?? "",
                };
                b.Projects.AddRange(RevitFamilyTools.Strings(x["projects"]));
                return b;
            }).ToList();
            return (true, list.Count == 0 ? "No AI code in the period." : (r.Body.Value<int?>("groups") ?? list.Count) + " groups of AI code.", list);
        }

        public async Task<ToolResult> ExportAsync(string projectFolder, int weeks, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_balance", new JObject
            {
                ["action"] = "export", ["project_folder"] = projectFolder, ["weeks"] = weeks, ["dry_run"] = dryRun,
            });
            if (!r.Ok) return ToolResult.Refused("Export: " + string.Join(" ", r.Reasons()));
            var res = new ToolResult { Ok = true };
            if (dryRun)
            {
                var rows = r.Body["rows"] as JObject;
                var files = RevitFamilyTools.Strings(r.Body["would_write"]);
                res.Count = files.Count;
                for (int i = 0; i < files.Count; i++)
                    res.Details.Add(files[i] + " (" + (i == 0 ? rows?.Value<int?>("calls") : rows?.Value<int?>("backlog")) + " rows)");
                return res;
            }
            res.Messages.Add(new ToolMessage(ChipKind.Good, "Saved for Power BI: " + string.Join(", ", RevitFamilyTools.Strings(r.Body["files"])) + "."));
            return res;
        }
    }
}
