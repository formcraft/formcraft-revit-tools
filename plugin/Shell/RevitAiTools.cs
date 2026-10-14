using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Admin › AI involvement in Revit. Reading goes through fmc_ai; approve, reject, resume and the BIM Manager's
    /// settings go through the server's pane-only commands (never MCP tools), as the Windows user running Revit.
    /// </summary>
    public sealed class RevitAiTools : IAiTools
    {
        public async Task<AiPolicy> StatusAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_ai", new JObject { ["action"] = "status" });
            var p = new AiPolicy { Ok = r.Ok && r.Body["groups"] != null };
            if (!p.Ok) { p.Message = "The AI policy can't be read: " + string.Join(" ", r.Reasons()); return p; }
            var b = r.Body;
            p.On = b.Value<bool?>("on") ?? false;
            p.Stop = b.Value<bool?>("stop") ?? false;
            p.GuardSection = (b.Value<string>("guard_section") ?? "") == "present";
            p.Rulebook = b.Value<string>("rulebook") ?? "";
            p.RulebookProblems.AddRange(RevitFamilyTools.Strings(b["rulebook_problems"]));
            p.Involvement = b.Value<int?>("involvement") ?? 0;
            p.Model = b.Value<string>("model") ?? "";
            if (b["limits"] is JObject l)
                p.Limits = $"{l.Value<int?>("batch_elements")} per batch, {l.Value<int?>("daily_elements")} per model a day, off after {l.Value<int?>("failed_batches_per_day")} failed batches";
            foreach (JObject g in ((JArray)b["groups"]).OfType<JObject>())
                p.Groups.Add(new AiGroupLine
                {
                    Id = g.Value<string>("group") ?? "", Name = g.Value<string>("name") ?? "", Level = g.Value<string>("level") ?? "Suggest",
                    AutoAllowed = g.Value<bool?>("auto_allowed") ?? false, AllowedNow = g.Value<bool?>("allowed_now") ?? false, Why = g.Value<string>("why") ?? "",
                });
            if (b["never"] is JObject never) foreach (var kv in never.Properties()) p.Never.Add((kv.Name, kv.Value.ToString()));
            return p;
        }

        public async Task<List<AiQueueLine>> QueueAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_ai", new JObject { ["action"] = "queue" });
            return (r.Body?["queue"] as JArray ?? new JArray()).OfType<JObject>().Select(q => new AiQueueLine
            {
                Id = q.Value<string>("id") ?? "", Model = q.Value<string>("model") ?? "", Group = q.Value<string>("group") ?? "",
                Summary = q.Value<string>("summary") ?? "", Elements = q.Value<int?>("elements") ?? 0, Status = q.Value<string>("status") ?? "",
                Created = q.Value<string>("created") ?? "",
            }).ToList();
        }

        public Task<ToolResult> DecideAsync(string id, bool approve) =>
            Run(approve ? "ai_approve" : "ai_reject", new JObject { ["id"] = id }, (approve ? "Approved " : "Rejected ") + id + ". Logged when the batch runs.");

        public Task<ToolResult> StopAsync(bool stop) => stop
            ? Run("fmc_ai", new JObject { ["action"] = "stop" }, "Stop AI is on: every AI change is refused.")
            : Run("ai_resume", new JObject(), "AI resumed at the levels set.");

        public Task<ToolResult> SaveAsync(bool on, int involvement, IReadOnlyDictionary<string, string> levels) =>
            Run("ai_config", new JObject { ["on"] = on, ["involvement"] = involvement, ["levels"] = JObject.FromObject(levels) }, "AI policy saved to fmc_guard.json.");

        private static async Task<ToolResult> Run(string command, JObject args, string done)
        {
            CliResult r = await ServerCli.RunAsync(command, args);
            if (!r.Ok) return ToolResult.Refused(string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            result.Messages.Add(new ToolMessage(ChipKind.Good, done));
            return result;
        }
    }
}
