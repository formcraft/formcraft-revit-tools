using System;
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
        /// <summary>How an approved batch went when it ran (done, failed) and why.</summary>
        public string Result { get; set; } = "";
        public string Detail { get; set; } = "";
        /// <summary>Estimated seconds, from past runs of the same command (0 when unknown).</summary>
        public int EstimateS { get; set; }
        /// <summary>What approving lets AI do, in plain lines (owner 26 Oct), from the server's explainer.</summary>
        public System.Collections.Generic.List<string> Details { get; set; } = new System.Collections.Generic.List<string>();
    }

    /// <summary>The policy as the server applies it (fmc_ai status), with the reasons it is Off when it is.</summary>
    public sealed class AiPolicy
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public bool On { get; set; }
        public bool Stop { get; set; }
        /// <summary>The General AI switch for the open model's project: On, Off or Stopped (owner 26 Oct).</summary>
        public string General { get; set; } = "Off";
        /// <summary>The plain line a person sees for it, never the lock's wording.</summary>
        public string GeneralLine { get; set; } = "AI is off. Turn it on with the AI switch.";
        public string Project { get; set; } = "";
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
        /// <summary>The General AI switch for the open model's project (any user; Stop AI still overrides it).</summary>
        Task<ToolResult> SetGeneralAsync(bool on);
        /// <summary>Send to AI (owner 26 Oct): the active view with the selection in red, the ids and a note, into the AI's inbox.</summary>
        Task<ToolResult> SendToAiAsync(string note);
        /// <summary>Raised when the approval queue changes (a new batch, a decision, a result), so pages refresh themselves.</summary>
        event EventHandler? QueueChanged;
    }

    /// <summary>Sample values from board core/PaneAdminAI.</summary>
    public sealed class MockAiTools : IAiTools
    {
        public bool On { get; set; } = true;
        public bool Stopped { get; set; }
        public bool GeneralOn { get; set; }
        public event EventHandler? QueueChanged;
        /// <summary>Tests: a new batch arrives.</summary>
        public void Add(AiQueueLine q) { Queue.Insert(0, q); QueueChanged?.Invoke(this, EventArgs.Empty); }
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
            p.Never.Add(("create_structural_framing_system", "structure"));
            p.Never.Add(("delete_element", "deleting"));
            p.General = Stopped ? "Stopped" : GeneralOn ? "On" : "Off";
            p.GeneralLine = p.General == "On" ? "AI is on for this project: every change waits for your approval."
                : p.General == "Stopped" ? "AI is stopped. Resume it with the AI switch." : "AI is off. Turn it on with the AI switch.";
            p.Project = "F26001";
            return Task.FromResult(p);
        }

        public Task<List<AiQueueLine>> QueueAsync() => Task.FromResult(Queue.ToList());

        public List<string> Sent { get; } = new List<string>();
        public Task<ToolResult> SendToAiAsync(string note)
        {
            Sent.Add(note);
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Sent to AI. In the Claude chat, ask it to check its inbox."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> SetGeneralAsync(bool on)
        {
            GeneralOn = on;
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(on ? ChipKind.Good : ChipKind.Info, on ? "AI is on for this project: every change waits for your approval." : "AI is off. Turn it on with the AI switch."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> DecideAsync(string id, bool approve)
        {
            var q = Queue.FirstOrDefault(x => x.Id == id);
            if (q == null) return Task.FromResult(ToolResult.Refused("No batch " + id + " in the queue."));
            q.Status = approve ? "used" : "rejected";
            if (approve) q.Result = "done";
            QueueChanged?.Invoke(this, EventArgs.Empty);
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
