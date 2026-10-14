using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>Gate A on a staged family (fmc_recipe gate): each check's state and detail.</summary>
    public sealed class GateResult
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Family { get; set; } = "";
        public bool Passed { get; set; }
        public List<(string Check, string State, string Detail)> Lines { get; } = new List<(string, string, string)>();
    }

    /// <summary>
    /// Families › Quality and release (U30, Phase 2). Gate A goes through fmc_recipe; release and send-back are the
    /// pane's own commands (never MCP tools): a person, with a reviewer and a note, decides.
    /// </summary>
    public interface IReleaseTools
    {
        Task<GateResult> GateAsync(string file);
        Task<ToolResult> ReleaseAsync(string file, string reviewer, string note);
        Task<ToolResult> SendBackAsync(string file, string reviewer, string note);
    }

    /// <summary>Sample values from board manage/PaneFamiliesRelease.</summary>
    public sealed class MockReleaseTools : IReleaseTools
    {
        public bool Pass { get; set; } = true;
        public List<string> Log { get; } = new List<string>();

        public Task<GateResult> GateAsync(string file)
        {
            var g = new GateResult { Ok = true, Family = System.IO.Path.GetFileNameWithoutExtension(file), Passed = Pass, Message = Pass ? "Gate A passed." : "Gate A: 1 fails." };
            g.Lines.Add(("Name follows the kit", "Pass", "FMC_A_Door_SteelFanlight"));
            g.Lines.Add(("Every type flexes", "Pass", "4 types regenerate"));
            g.Lines.Add(("Clear opening at least 900 mm", Pass ? "Pass" : "Fail", Pass ? "every type's Width is 900 mm or more" : "800x2100 800 mm"));
            g.Lines.Add(("Values from a verified source", "Warn", "Assumed (the reviewer accepts them): Fanlight height"));
            g.Lines.Add(("Tag, schedule and legend; Coarse, Medium and Fine", "Not checked", "Run the load test in the role's chain-test project"));
            return Task.FromResult(g);
        }

        public Task<ToolResult> ReleaseAsync(string file, string reviewer, string note)
        {
            Log.Add("released " + reviewer + " " + note);
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Released to 04_Families\\A and logged in FMC_Release_Log.csv."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> SendBackAsync(string file, string reviewer, string note)
        {
            Log.Add("sent back " + reviewer + " " + note);
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Info, "Sent back; the note is in FMC_Release_Log.csv."));
            return Task.FromResult(r);
        }
    }
}
