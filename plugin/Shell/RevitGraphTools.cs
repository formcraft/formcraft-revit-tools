using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Check › Graphs in Revit (D6, Builder 7): fmc_graph_lib, fmc_graph_form, fmc_dynamo plan and fmc_graph_guard through
    /// the installed server's CLI. A person's decision goes through the CLI's graph_approve / graph_refuse only.
    /// The active model's path is passed as "document" so drafts in its project (00_Formcraft\Graphs) resolve.
    /// </summary>
    public sealed class RevitGraphTools : IGraphTools
    {
        private readonly Func<string> _documentPath;

        public RevitGraphTools(Func<string> documentPath) { _documentPath = documentPath ?? (() => ""); }

        private JObject Args(JObject args)
        {
            string doc = _documentPath() ?? "";
            if (doc.Length > 0) args["document"] = doc;
            return args;
        }

        private static string Why(CliResult r) => string.Join(" ", r.Reasons().Concat(new[] { r.Body.Value<string>("message") ?? "" }).Where(s => s.Length > 0).Distinct());
        private static List<string> Strings(JToken t) => (t as JArray)?.Select(x => x.ToString()).ToList() ?? new List<string>();

        public async Task<(bool Ok, string Message, List<GraphEntry> Graphs)> ListAsync(string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_graph_lib", Args(new JObject { ["action"] = "list", ["kit_folder"] = kitFolder }));
            if (!r.Ok || !(r.Body["graphs"] is JArray list)) return (false, "Can't list the graphs: " + Why(r), new List<GraphEntry>());
            var graphs = list.OfType<JObject>().Select(x => new GraphEntry
            {
                Id = x.Value<string>("id") ?? "", File = x.Value<string>("file") ?? "", Tier = x.Value<string>("tier") ?? "",
                Status = x.Value<string>("status") ?? "", Python = x.Value<bool?>("python") ?? false, WritesModel = x.Value<bool?>("writes_model") ?? false,
                Lock = x["lock"]?.Type == JTokenType.String ? x.Value<string>("lock") : (x["lock"]?["state"]?.ToString() ?? ""), Problem = x.Value<string>("problem") ?? "",
            }).Where(g => g.File.Length > 0).ToList();
            return (true, graphs.Count + " graphs.", graphs);
        }

        public async Task<GraphForm> FormAsync(string file, string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_graph_form", Args(new JObject { ["action"] = "form", ["path"] = file, ["kit_folder"] = kitFolder }));
            var f = new GraphForm { File = file };
            if (!r.Ok || !(r.Body["form"] is JObject form)) { f.Message = "Refused: " + Why(r); return f; }
            f.Ok = true;
            f.Title = form.Value<string>("title") ?? "";
            f.Sha256 = form["graph"]?.Value<string>("sha256") ?? r.Body["spec"]?["graph"]?.Value<string>("sha256") ?? "";
            f.Python = r.Body["spec"]?.Value<bool?>("has_python") ?? false;
            foreach (JToken b in (form["banners"] as JArray) ?? new JArray())
            {
                string text = b.Type == JTokenType.String ? b.ToString() : b.Value<string>("text") ?? "";
                string kind = b.Type == JTokenType.Object ? b.Value<string>("kind") ?? "" : "";
                if (text.Length > 0) f.Banners.Add(new ToolMessage(kind == "bad" ? ChipKind.Bad : kind == "info" ? ChipKind.Info : ChipKind.Warn, text));
            }
            foreach (JObject c in ((form["controls"] as JArray) ?? new JArray()).OfType<JObject>())
            {
                var control = new GraphControl
                {
                    Id = c.Value<string>("id") ?? "", Label = c.Value<string>("label") ?? "", Control = c.Value<string>("control") ?? "text",
                    Value = c.Value<string>("value") ?? "", Rule = c.Value<string>("rule") ?? "", Disabled = c.Value<bool?>("disabled") ?? false,
                    DisabledWhy = c.Value<string>("disabled_why") ?? "", Hint = c.Value<string>("hint") ?? "",
                };
                control.Options.AddRange(Strings(c["options"]));
                f.Controls.Add(control);
            }
            foreach (JToken o in (form["outputs"] as JArray) ?? new JArray())
                f.Outputs.Add(o.Type == JTokenType.String ? o.ToString() : o.Value<string>("name") ?? "");
            f.PersonRequiredFor.AddRange(Strings(form["person_required_for"]));
            return f;
        }

        public async Task<GraphPlanView> PlanAsync(string file, string kitFolder, IReadOnlyDictionary<string, string> texts, string mode)
        {
            var p = new GraphPlanView { Mode = mode };
            var textArgs = new JObject();
            foreach (var kv in texts) textArgs[kv.Key] = kv.Value ?? "";
            CliResult bind = await ServerCli.RunAsync("fmc_graph_form", Args(new JObject { ["action"] = "bind", ["path"] = file, ["kit_folder"] = kitFolder, ["texts"] = textArgs, ["mode"] = mode }));
            if (!bind.Ok || !(bind.Body["request"]?["args"] is JObject request))
            {
                p.Message = "Can't plan: " + Why(bind);
                p.Problems.AddRange(Strings(bind.Body["problems"]));
                return p;
            }
            foreach (JObject b in ((bind.Body["binding"] as JArray) ?? new JArray()).OfType<JObject>())
                p.Binding.Add((b.Value<string>("name") ?? "") + " → " + (b.Value<string>("id") ?? ""));
            // The dry run: fmc_dynamo plan builds the GraphPlan and its plan_hash; nothing runs.
            var planArgs = (JObject)request.DeepClone();
            planArgs["kit_folder"] = kitFolder;
            CliResult plan = await ServerCli.RunAsync("fmc_dynamo", Args(planArgs));
            if (!plan.Ok || string.IsNullOrEmpty(plan.Body.Value<string>("plan_hash"))) { p.Message = "The dry run was refused: " + Why(plan); return p; }
            // planSummary has no graph path or inputs: carry the request's, which the plan_hash was made from.
            var body = (JObject)plan.Body.DeepClone();
            body["graph"] = request.Value<string>("path");
            body["inputs_by_id"] = request["inputs"]?.DeepClone() ?? new JObject();
            p.Ok = true;
            p.PlanJson = body.ToString(Newtonsoft.Json.Formatting.None);
            p.PlanHash = body.Value<string>("plan_hash") ?? "";
            p.Mode = body.Value<string>("mode") ?? mode;
            p.Python = body.Value<bool?>("python") ?? false;
            p.ApprovalKind = body.Value<string>("approval_kind") ?? "";
            p.Lock = body["lock"]?.Type == JTokenType.String ? body.Value<string>("lock") : "";
            p.Why.AddRange(Strings(body["approval_why"]));
            p.NeedsApproval = (body.Value<bool?>("needs_approval") ?? true) || p.Python || p.Mode != "preview";
            p.Message = p.NeedsApproval ? "Dry run planned. A person must approve before Run." : "Dry run planned. No approval needed for this preview.";
            return p;
        }

        public async Task<GraphApprovalView> AskApprovalAsync(GraphPlanView plan, string kitFolder, string reason)
        {
            CliResult step = await ServerCli.RunAsync("fmc_graph_form", Args(new JObject { ["action"] = "approval", ["plan"] = JObject.Parse(plan.PlanJson), ["reason"] = reason ?? "", ["kit_folder"] = kitFolder }));
            if (!step.Ok) return new GraphApprovalView { Message = "Refused: " + Why(step) };
            if (!(step.Body["request_approval"]?["args"] is JObject ask)) return new GraphApprovalView { Ok = true, Status = "none", Message = "This run needs no approval." };
            var args = (JObject)ask.DeepClone();
            args["kit_folder"] = kitFolder;
            CliResult r = await ServerCli.RunAsync("fmc_graph_guard", Args(args));
            string id = r.Body.Value<string>("approval_id") ?? "";
            if (!r.Ok || id.Length == 0) return new GraphApprovalView { Message = "Can't ask for approval: " + Why(r) };
            if ((r.Body.Value<string>("plan_hash") ?? plan.PlanHash) != plan.PlanHash)
                return new GraphApprovalView { Message = "The approval is for another plan_hash: press Plan again." };
            return new GraphApprovalView { Ok = true, Id = id, Status = r.Body.Value<string>("status") ?? "pending", ExpiresAt = r.Body.Value<string>("expires_at") ?? "", Message = "Waiting for a person to approve or refuse." };
        }

        public async Task<GraphApprovalView> DecideAsync(string approvalId, bool approve)
        {
            CliResult r = await ServerCli.RunAsync(approve ? "graph_approve" : "graph_refuse", new JObject { ["id"] = approvalId });
            if (!r.Ok) return new GraphApprovalView { Id = approvalId, Message = "Not decided: " + Why(r) };
            return new GraphApprovalView
            {
                Ok = true, Id = approvalId, Status = r.Body.Value<string>("status") ?? (approve ? "approved" : "refused"), ExpiresAt = r.Body.Value<string>("expires_at") ?? "",
                Message = approve ? "Approved by you. Single use, for this plan_hash only." : "Refused. Plan again to ask anew.",
            };
        }

        private async Task<(bool Ok, string Message, JObject Run)> Check(GraphPlanView plan, string approvalId, string kitFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_graph_form", Args(new JObject { ["action"] = "run_check", ["plan"] = JObject.Parse(plan.PlanJson), ["approval_id"] = approvalId ?? "", ["kit_folder"] = kitFolder }));
            if (!r.Ok || !(r.Body["request"]?["args"] is JObject run)) return (false, "Run refused: " + Why(r), null);
            return (true, "Run may go.", run);
        }

        public async Task<(bool Ok, string Message)> RunCheckAsync(GraphPlanView plan, string approvalId, string kitFolder)
        {
            var c = await Check(plan, approvalId, kitFolder);
            return (c.Ok, c.Message);
        }

        public async Task<(bool Ok, string Message)> RunAsync(GraphPlanView plan, string approvalId, string kitFolder)
        {
            var c = await Check(plan, approvalId, kitFolder);
            if (!c.Ok) return (false, c.Message);
            var args = (JObject)c.Run.DeepClone();
            if (!string.IsNullOrEmpty(approvalId)) args["approval_id"] = approvalId;
            args["kit_folder"] = kitFolder;
            // The server's run gate claims the single-use approval and checks the plan_hash again.
            CliResult r = await ServerCli.RunAsync("fmc_dynamo", Args(args));
            if (!r.Ok) return (false, "The run was refused: " + Why(r));
            return (true, "Ran (" + plan.Mode + "). Logged in FMC_MCP_FileLog.csv.");
        }
    }
}
