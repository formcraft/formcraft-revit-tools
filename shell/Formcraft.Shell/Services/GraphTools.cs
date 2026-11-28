using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>A graph in the kit (05_Scripts) or the project's drafts (00_Formcraft\Graphs), from fmc_graph_lib list.</summary>
    public sealed class GraphEntry
    {
        public string Id { get; set; } = "";
        public string File { get; set; } = "";
        public string Tier { get; set; } = "";
        public string Status { get; set; } = "";
        public bool Python { get; set; }
        public bool WritesModel { get; set; }
        public string Lock { get; set; } = "";
        public string Problem { get; set; } = "";
    }

    /// <summary>One control of the graph's form (fmc_graph_form form): the pane draws it by Control.</summary>
    public sealed class GraphControl
    {
        public string Id { get; set; } = "";
        public string Label { get; set; } = "";
        /// <summary>text, number, slider, toggle, choice, file, folder, element or date.</summary>
        public string Control { get; set; } = "text";
        public string Value { get; set; } = "";
        public List<string> Options { get; } = new List<string>();
        public string Rule { get; set; } = "";
        public bool Disabled { get; set; }
        public string DisabledWhy { get; set; } = "";
        public string Hint { get; set; } = "";
    }

    public sealed class GraphForm
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Title { get; set; } = "";
        public string File { get; set; } = "";
        public string Sha256 { get; set; } = "";
        public bool Python { get; set; }
        public List<ToolMessage> Banners { get; } = new List<ToolMessage>();
        public List<GraphControl> Controls { get; } = new List<GraphControl>();
        public List<string> Outputs { get; } = new List<string>();
        /// <summary>The modes a person must approve (Python graphs: every mode).</summary>
        public List<string> PersonRequiredFor { get; } = new List<string>();
    }

    /// <summary>The dry-run plan (fmc_dynamo plan) and what a run needs. Plan is the raw GraphPlan JSON the server checks again.</summary>
    public sealed class GraphPlanView
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public List<string> Problems { get; } = new List<string>();
        public string Mode { get; set; } = "preview";
        public string PlanHash { get; set; } = "";
        public bool NeedsApproval { get; set; }
        public string ApprovalKind { get; set; } = "";
        public List<string> Why { get; } = new List<string>();
        public bool Python { get; set; }
        public string Lock { get; set; } = "";
        public List<string> Binding { get; } = new List<string>();
        public string PlanJson { get; set; } = "";
    }

    public sealed class GraphApprovalView
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Id { get; set; } = "";
        /// <summary>pending, approved, refused, used or expired; "none" when the run needs no approval.</summary>
        public string Status { get; set; } = "";
        public string ExpiresAt { get; set; } = "";
    }

    /// <summary>
    /// Check › Graphs (D6): Dynamo graphs as staff forms. Reading, binding, the dry-run plan and the run check are the
    /// server's (fmc_graph_form, fmc_dynamo plan, fmc_graph_guard); a person approves or refuses in the pane only
    /// (server CLI graph_approve / graph_refuse). Run claims the single-use approval in the server's run gate.
    /// </summary>
    public interface IGraphTools
    {
        Task<(bool Ok, string Message, List<GraphEntry> Graphs)> ListAsync(string kitFolder);
        Task<GraphForm> FormAsync(string file, string kitFolder);
        /// <summary>Text values by control id -> fmc_graph_form bind -> fmc_dynamo plan (dry run, nothing runs).</summary>
        Task<GraphPlanView> PlanAsync(string file, string kitFolder, IReadOnlyDictionary<string, string> texts, string mode);
        /// <summary>fmc_graph_form approval, then fmc_graph_guard request_approval when a person is needed.</summary>
        Task<GraphApprovalView> AskApprovalAsync(GraphPlanView plan, string kitFolder, string reason);
        /// <summary>The person's decision: server CLI graph_approve or graph_refuse. Never an MCP tool.</summary>
        Task<GraphApprovalView> DecideAsync(string approvalId, bool approve);
        /// <summary>fmc_graph_form run_check: may Run go now (approved by a person, unused, unexpired, same plan_hash)?</summary>
        Task<(bool Ok, string Message)> RunCheckAsync(GraphPlanView plan, string approvalId, string kitFolder);
        /// <summary>run_check, then fmc_dynamo run with the approval id. Never called by tests.</summary>
        Task<(bool Ok, string Message)> RunAsync(GraphPlanView plan, string approvalId, string kitFolder);
    }

    /// <summary>Sample graphs for the preview app: the kit's FMC_ModelHealth (Python) and a draft with every input kind.</summary>
    public sealed class MockGraphTools : IGraphTools
    {
        private readonly Dictionary<string, string> _approvals = new Dictionary<string, string>();
        private int _next = 1;

        public Task<(bool Ok, string Message, List<GraphEntry> Graphs)> ListAsync(string kitFolder) =>
            Task.FromResult((true, "2 graphs.", new List<GraphEntry>
            {
                new GraphEntry { Id = "FMC_ModelHealth", File = @"K:\Kit\05_Scripts\Dynamo\FMC_ModelHealth.dyn", Tier = "K", Status = "kit", Python = true, Lock = "match" },
                new GraphEntry { Id = "form_inputs", File = @"P:\F26001\00_Formcraft\Graphs\form_inputs.dyn", Tier = "P", Status = "draft", Lock = "absent" },
            }));

        public Task<GraphForm> FormAsync(string file, string kitFolder)
        {
            bool python = file.Contains("ModelHealth");
            var f = new GraphForm { Ok = true, Title = python ? "FMC_ModelHealth" : "form_inputs", File = file, Sha256 = python ? "721a9f3d…6f3c23" : "0b5e…", Python = python };
            if (python)
            {
                f.Banners.Add(new ToolMessage(ChipKind.Warn, "This graph has Python: a person approves every run, preview too."));
                f.Controls.Add(new GraphControl { Id = "n1", Label = "Report title", Value = "Model health" });
                f.PersonRequiredFor.AddRange(new[] { "preview", "apply", "offline" });
            }
            else
            {
                f.Controls.Add(new GraphControl { Id = "a1", Label = "Count", Control = "slider", Value = "5", Rule = "whole number 1 to 10, step 1" });
                f.Controls.Add(new GraphControl { Id = "a3", Label = "Dry run only", Control = "toggle", Value = "true" });
                var mode = new GraphControl { Id = "a6", Label = "Mode", Control = "choice", Value = "Rooms" };
                mode.Options.AddRange(new[] { "Rooms", "Areas", "Spaces" });
                f.Controls.Add(mode);
                f.Controls.Add(new GraphControl { Id = "a5", Label = "Output folder", Control = "folder", Hint = "Must already exist inside the project; for a new output file, pick the folder it goes in." });
                f.Controls.Add(new GraphControl { Id = "a8", Label = "Pick a wall", Control = "element", Disabled = true, DisabledWhy = "Picked in Revit." });
                f.PersonRequiredFor.AddRange(new[] { "apply", "offline" });
            }
            f.Outputs.Add("Result");
            return Task.FromResult(f);
        }

        public Task<GraphPlanView> PlanAsync(string file, string kitFolder, IReadOnlyDictionary<string, string> texts, string mode)
        {
            bool python = file.Contains("ModelHealth");
            var p = new GraphPlanView { Ok = true, Mode = mode, PlanHash = "sha256:" + (python ? "9c1f" : "4ab2") + mode.Length + "e7…", Python = python, Lock = "match", ApprovalKind = python ? "python_run" : "graph_run" };
            p.NeedsApproval = python || mode != "preview";
            if (python) p.Why.Add("The graph has Python: a person approves every run.");
            if (mode != "preview") p.Why.Add("An " + mode + " run keeps its changes: a person approves it.");
            p.Binding.AddRange(texts.Keys.Select(k => k + " → " + k));
            p.Message = p.NeedsApproval ? "Needs a person's approval before Run." : "No approval needed for this preview.";
            return Task.FromResult(p);
        }

        public Task<GraphApprovalView> AskApprovalAsync(GraphPlanView plan, string kitFolder, string reason)
        {
            if (!plan.NeedsApproval) return Task.FromResult(new GraphApprovalView { Ok = true, Status = "none", Message = "This run needs no approval." });
            string id = "gap-" + (_next++);
            _approvals[id] = "pending";
            return Task.FromResult(new GraphApprovalView { Ok = true, Id = id, Status = "pending", ExpiresAt = "in 30 min", Message = "Waiting for a person." });
        }

        public Task<GraphApprovalView> DecideAsync(string approvalId, bool approve)
        {
            if (!_approvals.TryGetValue(approvalId, out var s) || s != "pending")
                return Task.FromResult(new GraphApprovalView { Ok = false, Id = approvalId, Message = "No pending approval " + approvalId + "." });
            _approvals[approvalId] = approve ? "approved" : "refused";
            return Task.FromResult(new GraphApprovalView { Ok = true, Id = approvalId, Status = _approvals[approvalId], Message = approve ? "Approved by you." : "Refused." });
        }

        public Task<(bool Ok, string Message)> RunCheckAsync(GraphPlanView plan, string approvalId, string kitFolder)
        {
            if (!plan.NeedsApproval) return Task.FromResult((true, "Run may go."));
            if (approvalId.Length == 0 || !_approvals.TryGetValue(approvalId, out var s)) return Task.FromResult((false, "[FMC-GRAPH-APPROVAL-NEEDED] A person approves this run first."));
            return Task.FromResult(s == "approved" ? (true, "Run may go.") : (false, "[FMC-GRAPH-APPROVAL-" + s.ToUpperInvariant() + "] The approval is " + s + "."));
        }

        public async Task<(bool Ok, string Message)> RunAsync(GraphPlanView plan, string approvalId, string kitFolder)
        {
            var check = await RunCheckAsync(plan, approvalId, kitFolder);
            if (!check.Ok) return check;
            if (approvalId.Length > 0) _approvals[approvalId] = "used";
            return (true, "Preview app: nothing runs.");
        }
    }
}
