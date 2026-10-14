using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Team › Links in Revit: fmc_links through the installed server.</summary>
    public sealed class RevitLinkTools : ILinkTools
    {
        public async Task<LinkAudit> AuditAsync(string linkFrom)
        {
            CliResult r = await ServerCli.RunAsync("fmc_links", new JObject { ["action"] = "audit", ["link_from"] = linkFrom });
            var a = new LinkAudit { Ok = r.Ok && r.Body["links"] != null };
            if (!a.Ok) { a.Message = "Audit refused: " + string.Join(" ", r.Reasons()); return a; }
            var b = r.Body;
            a.Model = b.Value<string>("model") ?? "";
            a.Workshared = b.Value<bool?>("workshared") ?? false;
            var c = b["coordinates"] as JObject ?? new JObject();
            a.Site = c.Value<string>("site") ?? "";
            a.Crs = c.Value<string>("crs") ?? "";
            a.Easting = (c.Value<double?>("easting_mm") ?? 0).ToString("0");
            a.Northing = (c.Value<double?>("northing_mm") ?? 0).ToString("0");
            a.Elevation = (c.Value<double?>("elevation_mm") ?? 0).ToString("0");
            a.Angle = (c.Value<double?>("angle_deg") ?? 0).ToString("0.00");
            var problems = (b["audit"] as JArray ?? new JArray()).OfType<JObject>().ToDictionary(x => x.Value<long>("id"), x => RevitFamilyTools.Strings(x["problems"]));
            foreach (JObject l in ((JArray)b["links"]).OfType<JObject>())
            {
                long id = l.Value<long>("id");
                a.Links.Add(new LinkLine(id, l.Value<string>("name") ?? "", l.Value<bool?>("pinned") ?? false, l.Value<bool?>("loaded") ?? false,
                    l.Value<string>("workset") ?? "", problems.TryGetValue(id, out var p) ? p : new List<string>()));
            }
            foreach (JObject x in (b["candidates"] as JArray ?? new JArray()).OfType<JObject>())
                a.Candidates.Add(new LinkCandidate(x.Value<string>("path") ?? "", x.Value<string>("name") ?? "", x.Value<string>("role") ?? "",
                    x.Value<bool?>("linked") ?? false, x.Value<bool?>("own") ?? false));
            a.FolderProblem = b.Value<string>("link_from_problem") ?? "";
            int fix = b.Value<int?>("to_fix") ?? 0;
            a.Message = $"{a.Links.Count} links in {a.Model}" + (fix > 0 ? $", {fix} to fix." : ", all as the Manual asks.");
            return a;
        }

        public async Task<ToolResult> LinkAsync(IReadOnlyList<string> models, bool pin, bool dryRun)
        {
            var args = new JObject { ["action"] = "link", ["models"] = JArray.FromObject(models), ["pin"] = pin, ["dry_run"] = dryRun };
            CliResult r = await ServerCli.RunAsync("fmc_links", args);
            if (!r.Ok) return ToolResult.Refused("Link refused: " + string.Join(" ", r.Reasons()));
            var list = ((dryRun ? r.Body["would"] : r.Body["models"]) as JArray ?? new JArray()).OfType<JObject>().ToList();
            var result = new ToolResult { Ok = true, Count = list.Count };
            if (dryRun) result.Details.AddRange(list.Select(x => x.Value<string>("name") + ": " + x.Value<string>("result")));
            else foreach (var x in list)
                result.Messages.Add(new ToolMessage((x.Value<string>("result") ?? "").StartsWith("linked") ? ChipKind.Good : ChipKind.Bad, x.Value<string>("name") + ": " + x.Value<string>("result")));
            if (!dryRun && list.Count == 0) result.Messages.Add(new ToolMessage(ChipKind.Info, r.Body.Value<string>("message") ?? "Nothing to link."));
            return result;
        }

        public async Task<ToolResult> PinAsync(bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_links", new JObject { ["action"] = "pin", ["dry_run"] = dryRun });
            if (!r.Ok) return ToolResult.Refused("Pin refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            if (r.Body.Value<bool?>("nothing") == true) return result;
            if (dryRun) result.Details.AddRange((r.Body["would"] as JArray ?? new JArray()).OfType<JObject>().Select(x => x.Value<string>("name")));
            else result.Messages.Add(new ToolMessage(ChipKind.Good, $"{r.Body.Value<int?>("pinned") ?? 0} links pinned. Logged in FMC_MCP_FileLog.csv."));
            result.Count = result.Details.Count;
            return result;
        }
    }
}
