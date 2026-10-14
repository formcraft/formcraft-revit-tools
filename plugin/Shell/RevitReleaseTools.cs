using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Families › Quality and release in Revit. Gate A goes through fmc_recipe; release and send-back are the server's
    /// pane-only commands (never MCP tools), as the Windows user running Revit.
    /// </summary>
    public sealed class RevitReleaseTools : IReleaseTools
    {
        public async Task<GateResult> GateAsync(string file)
        {
            CliResult r = await ServerCli.RunAsync("fmc_recipe", new JObject { ["action"] = "gate", ["file"] = file });
            var g = new GateResult { Ok = r.Ok && r.Body["lines"] != null };
            if (!g.Ok) { g.Message = "Gate A refused: " + string.Join(" ", r.Reasons()); return g; }
            g.Family = r.Body.Value<string>("family") ?? Path.GetFileNameWithoutExtension(file);
            g.Passed = r.Body.Value<string>("verdict") == "Pass";
            foreach (JObject l in ((JArray)r.Body["lines"]).OfType<JObject>())
                g.Lines.Add((l.Value<string>("check") ?? "", l.Value<string>("state") ?? "", l.Value<string>("detail") ?? ""));
            int fails = g.Lines.Count(l => l.State == "Fail");
            g.Message = g.Passed ? $"Gate A passed for {g.Family}." : $"Gate A: {fails} fail for {g.Family}.";
            return g;
        }

        public Task<ToolResult> ReleaseAsync(string file, string reviewer, string note) =>
            Run("family_release", file, reviewer, note, r => $"Released to {r.Value<string>("to")}. Logged in FMC_Release_Log.csv.");

        public Task<ToolResult> SendBackAsync(string file, string reviewer, string note) =>
            Run("family_sendback", file, reviewer, note, r => "Sent back; the note is in FMC_Release_Log.csv.");

        private static async Task<ToolResult> Run(string command, string file, string reviewer, string note, System.Func<JObject, string> done)
        {
            CliResult r = await ServerCli.RunAsync(command, new JObject { ["file"] = file, ["reviewer"] = reviewer, ["note"] = note });
            if (!r.Ok) return ToolResult.Refused(string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            result.Messages.Add(new ToolMessage(ChipKind.Good, done(r.Body)));
            return result;
        }
    }
}
