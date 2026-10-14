using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Ask Claude in Revit: the server's ask (read-only tools, the firm's own key) and its status.</summary>
    public sealed class RevitAskTools : IAskTools
    {
        public async Task<AskAnswer> AskAsync(string question, IReadOnlyList<(string Role, string Text)> history)
        {
            var args = new JObject
            {
                ["question"] = question,
                ["history"] = new JArray(history.Select(h => new JObject { ["role"] = h.Role, ["text"] = h.Text })),
            };
            CliResult r = await ServerCli.RunAsync("ask", args);
            var a = new AskAnswer { Ok = r.Ok && r.Body["answer"] != null };
            if (!a.Ok) { a.Text = string.Join(" ", r.Reasons()); return a; }
            a.Text = r.Body.Value<string>("answer") ?? "";
            a.Model = r.Body.Value<string>("model") ?? "";
            a.ToolsUsed.AddRange(RevitFamilyTools.Strings(r.Body["tools_used"]));
            var u = r.Body["usage"] as JObject ?? new JObject();
            a.Tokens = (u.Value<int?>("input_tokens") ?? 0) + (u.Value<int?>("output_tokens") ?? 0);
            a.BudgetLeft = r.Body.Value<int?>("budget_left") ?? 0;
            return a;
        }

        public async Task<AskStatus> StatusAsync()
        {
            CliResult r = await ServerCli.RunAsync("ask_status", new JObject());
            var s = new AskStatus { Ok = r.Ok && r.Body["key"] != null };
            if (!s.Ok) { s.Message = "Ask's status isn't readable: " + string.Join(" ", r.Reasons()); return s; }
            var b = r.Body;
            s.KeySaved = b.Value<string>("key") == "saved";
            s.KeyFile = b.Value<string>("key_file") ?? "";
            s.Model = b.Value<string>("model") ?? "";
            s.DailyTokens = b.Value<int?>("daily_tokens") ?? 0;
            s.UsedToday = b.Value<int?>("used_today") ?? 0;
            s.QuestionsToday = b.Value<int?>("questions_today") ?? 0;
            foreach (JObject t in (b["tools"] as JArray ?? new JArray()).OfType<JObject>()) s.Tools.Add((t.Value<string>("name") ?? "", t.Value<string>("description") ?? ""));
            foreach (JObject l in (b["log"] as JArray ?? new JArray()).OfType<JObject>())
                s.Log.Add((l.Value<string>("time") ?? "", l.Value<string>("tools") ?? "", l.Value<int?>("tokens") ?? 0, l.Value<string>("result") ?? ""));
            return s;
        }
    }
}
