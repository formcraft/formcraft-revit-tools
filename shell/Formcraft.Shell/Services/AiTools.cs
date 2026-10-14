using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One operation group of the AI-assisted modeller, for the model in front of the person.</summary>
    public sealed class AiGroupLine
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Level { get; set; } = "Suggest";
        public bool AutoAllowed { get; set; }
        public bool AllowedNow { get; set; }
        public string Why { get; set; } = "";
    }

    public sealed class AiQueueLine
    {
        public string Id { get; set; } = "";
        public string Model { get; set; } = "";
        public string Group { get; set; } = "";
        public string Summary { get; set; } = "";
        public int Elements { get; set; }
        public string Status { get; set; } = "";
        public string Created { get; set; } = "";
    }

    /// <summary>The policy as the server applies it (fmc_ai status), with the reasons it is Off when it is.</summary>
    public sealed class AiPolicy
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public bool On { get; set; }
        public bool Stop { get; set; }
        public bool GuardSection { get; set; }
        public string Rulebook { get; set; } = "";
        public List<string> RulebookProblems { get; } = new List<string>();
        public int Involvement { get; set; }
        public string Model { get; set; } = "";
        public string Limits { get; set; } = "";
        public List<AiGroupLine> Groups { get; } = new List<AiGroupLine>();
        public List<(string Command, string Why)> Never { get; } = new List<(string, string)>();
    }

    /// <summary>
    /// Admin › AI involvement (U28; docs/AI_ASSISTED_MODELLER.md). Reading the policy and Stop AI go through fmc_ai; a
    /// person's approve, reject, resume and the BIM Manager's settings go through the pane's own commands only, so the
    /// AI can never approve its own batch or switch itself back on.
    /// </summary>
    public interface IAiTools
    {
        Task<AiPolicy> StatusAsync();
        Task<List<AiQueueLine>> QueueAsync();
        Task<ToolResult> DecideAsync(string id, bool approve);
        Task<ToolResult> StopAsync(bool stop);
        Task<ToolResult> SaveAsync(bool on, int involvement, IReadOnlyDictionary<string, string> levels);
    }

    /// <summary>Sample values from board core/PaneAdminAI.</summary>
    public sealed class MockAiTools : IAiTools
    {
        public bool On { get; set; } = true;
        public bool Stopped { get; set; }
        public int Involvement { get; set; } = 20;
        public Dictionary<string, string> Levels { get; } = new Dictionary<string, string> { ["views"] = "Auto in WIP", ["create_from_brief"] = "Fix with approval" };
        public List<AiQueueLine> Queue { get; } = new List<AiQueueLine>
        {
            new AiQueueLine { Id = "3fa91c0e", Model = "F26001-FMC-ZZ-ZZ-M3-A-0001", Group = "create_from_brief", Summary = "create_room: 12 data", Elements = 12, Status = "pending", Created = "2026-10-14T15:10:00Z" },
        };

        public Task<AiPolicy> StatusAsync()
        {
            var p = new AiPolicy { Ok = true, On = On && !Stopped, Stop = Stopped, GuardSection = true, Rulebook = @"Z:\00_Standards\03_Master_Data\FMC_Rulebook\FMC_Rulebook_AIUse.json",
                Involvement = Involvement, Model = "F26001-FMC-ZZ-ZZ-M3-A-0001", Limits = "50 per batch, 500 per model a day, off after 3 failed batches" };
            foreach (var (id, name, auto) in new[] { ("data", "Data", true), ("views", "Views and annotation", true), ("create_from_brief", "Create from brief", false), ("fixtures", "Fixtures and devices", false) })
            {
                string level = Levels.TryGetValue(id, out var l) ? l : "Suggest";
                bool unlocked = id != "fixtures" || Involvement > 20;
                p.Groups.Add(new AiGroupLine { Id = id, Name = name, AutoAllowed = auto, Level = level,
                    AllowedNow = p.On && unlocked && (level == "Auto in WIP" || level == "Fix with approval"),
                    Why = !p.On ? "AI modelling is off" : !unlocked ? "Unlocks at 21% (Co-model)" : level == "Suggest" ? "At Suggest: a person does the work" : "allowed" });
            }
            p.Never.Add(("create_grid", "grids"));
            p.Never.Add(("create_structural_framing_system", "structure"));
            return Task.FromResult(p);
        }

        public Task<List<AiQueueLine>> QueueAsync() => Task.FromResult(Queue.ToList());

        public Task<ToolResult> DecideAsync(string id, bool approve)
        {
            var q = Queue.FirstOrDefault(x => x.Id == id);
            if (q == null) return Task.FromResult(ToolResult.Refused("No batch " + id + " in the queue."));
            q.Status = approve ? "approved" : "rejected";
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, (approve ? "Approved " : "Rejected ") + id + "."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> StopAsync(bool stop)
        {
            Stopped = stop;
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(stop ? ChipKind.Warn : ChipKind.Good, stop ? "Stop AI is on: every AI change is refused." : "AI resumed."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> SaveAsync(bool on, int involvement, IReadOnlyDictionary<string, string> levels)
        {
            On = on;
            Involvement = involvement;
            foreach (var kv in levels) Levels[kv.Key] = kv.Value;
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Policy saved."));
            return Task.FromResult(r);
        }
    }
}
