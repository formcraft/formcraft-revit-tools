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
            if (b["general"] is JObject gs)
            {
                p.General = gs.Value<string>("state") ?? "Off";
                p.GeneralLine = gs.Value<string>("line") ?? p.GeneralLine;
                p.Project = gs.Value<string>("project") ?? "";
            }
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
                Result = q.Value<string>("result") ?? "", Detail = q.Value<string>("detail") ?? "", EstimateS = q.Value<int?>("estimate_s") ?? 0,
                Details = (q["details"] as JArray ?? new JArray()).Select(x => x.ToString()).ToList(),
            }).ToList();
        }

        /// <summary>Approve runs the batch now (owner 26 Oct); the server says how it went.</summary>
        public async Task<ToolResult> DecideAsync(string id, bool approve)
        {
            CliResult r = await ServerCli.RunAsync(approve ? "ai_approve" : "ai_reject", new JObject { ["id"] = id });
            if (!r.Ok && r.Body?["message"] == null) return ToolResult.Refused(string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = r.Ok && (r.Body.Value<string>("result") ?? "done") != "failed" };
            result.Messages.Add(new ToolMessage(result.Ok ? ChipKind.Good : ChipKind.Bad, r.Body.Value<string>("message") ?? ((approve ? "Approved " : "Rejected ") + id + ".")));
            return result;
        }

        // The queue lives in %APPDATA%\Formcraft\ai_queue: watching the folder refreshes the pane with no AI and no polling.
        private System.IO.FileSystemWatcher _watcher;
        private event System.EventHandler _queueChanged;
        public event System.EventHandler QueueChanged
        {
            add { EnsureWatcher(); _queueChanged += value; }
            remove { _queueChanged -= value; }
        }

        private void EnsureWatcher()
        {
            if (_watcher != null) return;
            try
            {
                string dir = System.IO.Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.ApplicationData), "Formcraft", "ai_queue");
                System.IO.Directory.CreateDirectory(dir);
                _watcher = new System.IO.FileSystemWatcher(dir, "*.json") { NotifyFilter = System.IO.NotifyFilters.FileName | System.IO.NotifyFilters.LastWrite };
                System.IO.FileSystemEventHandler raise = (s, e) => _queueChanged?.Invoke(this, System.EventArgs.Empty);
                _watcher.Created += raise; _watcher.Changed += raise; _watcher.Deleted += raise;
                _watcher.EnableRaisingEvents = true;
            }
            catch { /* the Refresh button still works */ }
        }

        public Task<ToolResult> StopAsync(bool stop) => stop
            ? Run("fmc_ai", new JObject { ["action"] = "stop" }, "Stop AI is on: every AI change is refused.")
            : Run("ai_resume", new JObject(), "AI resumed at the levels set.");

        public Task<ToolResult> SaveAsync(bool on, int involvement, IReadOnlyDictionary<string, string> levels) =>
            Run("ai_config", new JObject { ["on"] = on, ["involvement"] = involvement, ["levels"] = JObject.FromObject(levels) }, "AI policy saved to fmc_guard.json.");

        /// <summary>The General AI switch for the open model (pane-only command ai_general, as the Windows user running Revit).</summary>
        public async Task<ToolResult> SetGeneralAsync(bool on)
        {
            AiPolicy p = await StatusAsync();
            if (p.Model.Length == 0) return ToolResult.Refused("Open the project model first: the AI switch is set per project.");
            // No project key: strict mode and a non-compliant model (testing mode keys every file).
            if (p.Project.Length == 0) return ToolResult.Refused(p.GeneralLine);
            CliResult r = await ServerCli.RunAsync("ai_general", new JObject { ["on"] = on, ["project"] = p.Project });
            if (!r.Ok) return ToolResult.Refused(string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            result.Messages.Add(new ToolMessage(on ? ChipKind.Good : ChipKind.Info, r.Body.Value<string>("line") ?? (on ? "AI is on." : "AI is off.")));
            return result;
        }

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
