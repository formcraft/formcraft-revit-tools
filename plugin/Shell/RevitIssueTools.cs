using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Drawings › Issue in Revit: fmc_issue through the installed server.</summary>
    public sealed class RevitIssueTools : IIssueTools
    {
        private static JObject Args(string action, IssueRequest q) => new JObject
        {
            ["action"] = action, ["register"] = q.Register, ["project_folder"] = q.ProjectFolder, ["project_code"] = q.Code, ["originator"] = q.Originator,
            ["issue_set"] = q.IssueSet, ["disciplines"] = JArray.FromObject(q.Disciplines), ["purpose"] = q.Purpose, ["company_revision"] = q.CompanyRevision,
            ["send_to"] = q.SendTo, ["outputs"] = new JObject { ["pdf"] = q.Pdf, ["register"] = q.RegisterCsv, ["transmittal"] = q.Transmittal },
        };

        public async Task<IssueReadiness> CheckAsync(IssueRequest q)
        {
            CliResult r = await ServerCli.RunAsync("fmc_issue", Args("check", q));
            var c = new IssueReadiness { Ok = r.Ok && r.Body["result"] != null };
            if (!c.Ok) { c.Message = "Check refused: " + string.Join(" ", r.Reasons()); return c; }
            var b = r.Body;
            c.Result = b.Value<string>("result") ?? "";
            c.Summary = b.Value<string>("summary") ?? "";
            c.CheckedAgainst = (b.Value<string>("checked_against") ?? "") + " · " + System.DateTime.Now.ToString("d MMM HH:mm");
            c.RevitRevision = b.Value<string>("revit_revision") ?? "";
            foreach (JObject x in (b["checklist"] as JArray ?? new JArray()).OfType<JObject>())
                c.Checks.Add(new IssueCheckLine(x.Value<string>("check") ?? "", x.Value<string>("state") ?? "", x.Value<string>("detail") ?? ""));
            foreach (JObject s in (b["sheets"] as JArray ?? new JArray()).OfType<JObject>())
                c.Sheets.Add(new IssueSheetLine(s.Value<string>("number") ?? "", s.Value<string>("name") ?? "", s.Value<string>("status") ?? "",
                    RevitFamilyTools.Strings(s["reasons"]), RevitFamilyTools.Strings(s["excepted"]),
                    (s["element_ids"] as JArray ?? new JArray()).Select(i => (long)i).Concat(s["id"] != null ? new[] { s.Value<long>("id") } : new long[0]).Distinct().ToList()));
            foreach (JObject e in (b["exceptions_used"] as JArray ?? new JArray()).OfType<JObject>())
                c.Exceptions.Add(new IssueExceptionLine(e.Value<string>("sheet") ?? "", e.Value<string>("item") ?? "", e.Value<string>("why") ?? "",
                    e.Value<string>("approved_by") ?? "", e.Value<string>("until") ?? ""));
            c.Problems.AddRange(RevitFamilyTools.Strings(b["problems"]));
            c.Message = $"Checked {c.Sheets.Count} sheets of {b.Value<string>("model")}: {c.Result}.";
            return c;
        }

        public async Task<ToolResult> ExceptAsync(IssueRequest q, IssueExceptionLine e)
        {
            var args = Args("except", q);
            args["exception"] = new JObject { ["sheet"] = e.Sheet, ["item"] = e.Item, ["why"] = e.Why, ["approved_by"] = e.ApprovedBy, ["until"] = e.Until };
            CliResult r = await ServerCli.RunAsync("fmc_issue", args);
            if (!r.Ok) return ToolResult.Refused("Exception not recorded: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            result.Messages.Add(new ToolMessage(ChipKind.Good, "Exception recorded in " + r.Body.Value<string>("file") + "."));
            return result;
        }

        public async Task<ToolResult> ReportAsync(IssueRequest q)
        {
            CliResult r = await ServerCli.RunAsync("fmc_issue", Args("report", q));
            if (!r.Ok) return ToolResult.Refused("Report not saved: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            result.Messages.Add(new ToolMessage(ChipKind.Good, $"Readiness report ({r.Body.Value<string>("result")}) saved to {r.Body.Value<string>("saved")}."));
            return result;
        }

        public async Task<ToolResult> IssueAsync(IssueRequest q, bool dryRun)
        {
            var args = Args("issue", q);
            args["dry_run"] = dryRun;
            CliResult r = await ServerCli.RunAsync("fmc_issue", args);
            if (!r.Ok) return ToolResult.Refused("Issue refused: " + string.Join(" ", r.Reasons()));
            var b = r.Body;
            var result = new ToolResult { Ok = true };
            if (dryRun)
            {
                var files = (b["files"] as JArray ?? new JArray()).OfType<JObject>().Select(f => f.Value<string>("name")).ToList();
                result.Count = files.Count;
                result.Details.Add(b.Value<string>("folder"));
                result.Details.AddRange(files.Select(f => "  " + f));
                return result;
            }
            int failed = b.Value<int?>("failed") ?? 0;
            result.Messages.Add(new ToolMessage(failed > 0 ? ChipKind.Warn : ChipKind.Good,
                $"Issued to {b.Value<string>("folder")}" + (failed > 0 ? $": {failed} PDFs didn't export, see the readiness report." : ". Logged in FMC_MCP_FileLog.csv.")));
            foreach (JObject p in (b["pdfs"] as JArray ?? new JArray()).OfType<JObject>().Where(p => p.Value<string>("result") != "exported"))
                result.Messages.Add(new ToolMessage(ChipKind.Warn, p.Value<string>("file") + ": " + p.Value<string>("result")));
            return result;
        }
    }
}
