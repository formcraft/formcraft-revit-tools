using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Team › Workshare in Revit: fmc_workshare through the installed server. Never syncs or saves (rule 6).</summary>
    public sealed class RevitWorkshareTools : IWorkshareTools
    {
        public async Task<WorkshareFacts> FactsAsync(IReadOnlyList<string> linkedRoles)
        {
            CliResult r = await ServerCli.RunAsync("fmc_workshare", new JObject { ["action"] = "facts", ["linked_roles"] = JArray.FromObject(linkedRoles) });
            var f = new WorkshareFacts { Ok = r.Ok && r.Body["model"] != null };
            if (!f.Ok) { f.Message = "Workshare refused: " + string.Join(" ", r.Reasons()); return f; }
            var b = r.Body;
            f.Model = b.Value<string>("model") ?? "";
            f.Role = b.Value<string>("role") ?? "";
            f.Workshared = b.Value<bool?>("workshared") ?? false;
            f.Central = b.Value<string>("central") ?? "";
            f.User = b.Value<string>("user") ?? "";
            foreach (JObject w in (b["worksets"] as JArray ?? new JArray()).OfType<JObject>())
                f.Worksets.Add(new WorksetLine(w.Value<string>("name") ?? "", w.Value<string>("owner") ?? "", w.Value<bool?>("open") ?? true, w.Value<string>("problem") ?? ""));
            f.StandardSet.AddRange(RevitFamilyTools.Strings(b["standard_set"]));
            f.Missing.AddRange(RevitFamilyTools.Strings(b["missing"]));
            foreach (JObject p in (b["preflight"] as JArray ?? new JArray()).OfType<JObject>())
                f.Preflight.Add(new PreflightLine(p.Value<string>("check") ?? "", p.Value<string>("state") ?? "", p.Value<string>("detail") ?? ""));
            f.Message = !f.Workshared ? f.Model + " isn't workshared."
                : $"{f.Worksets.Count} worksets in {f.Model}" + (f.Missing.Count > 0 ? $", {f.Missing.Count} of the standard set missing." : ", standard set complete.");
            return f;
        }

        public async Task<ToolResult> CreateAsync(IReadOnlyList<string> names, IReadOnlyList<string> linkedRoles, bool dryRun)
        {
            var args = new JObject { ["action"] = "create", ["names"] = JArray.FromObject(names), ["linked_roles"] = JArray.FromObject(linkedRoles), ["dry_run"] = dryRun };
            CliResult r = await ServerCli.RunAsync("fmc_workshare", args);
            if (!r.Ok) return ToolResult.Refused("Worksets refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            if (r.Body.Value<bool?>("nothing") == true) return result;
            var list = ((dryRun ? r.Body["would"] : r.Body["worksets"]) as JArray ?? new JArray()).OfType<JObject>().ToList();
            result.Count = list.Count;
            if (dryRun) result.Details.AddRange(list.Select(x => x.Value<string>("name") + ": " + x.Value<string>("result")));
            else result.Messages.Add(new ToolMessage(ChipKind.Good,
                "Worksets: " + string.Join(", ", list.Select(x => x.Value<string>("name") + " " + x.Value<string>("result"))) + ". A person syncs to share them."));
            return result;
        }

        public async Task<(bool Ok, string Message, string Text)> MessageAsync(SyncMessageRequest q, bool record)
        {
            var args = new JObject
            {
                ["action"] = "message", ["project_code"] = q.ProjectCode, ["project_folder"] = q.ProjectFolder, ["revision"] = q.Revision,
                ["worked"] = JArray.FromObject(q.Worked), ["raised"] = JArray.FromObject(q.Raised), ["what"] = q.What, ["record"] = record,
            };
            CliResult r = await ServerCli.RunAsync("fmc_workshare", args);
            if (!r.Ok) return (false, string.Join(" ", r.Reasons()), "");
            string recorded = r.Body.Value<string>("recorded") ?? "";
            return (true, recorded.Length > 0 ? "Saved to the sync log: " + recorded : "Message ready: copy it into Synchronize with Central.", r.Body.Value<string>("message") ?? "");
        }
    }
}
