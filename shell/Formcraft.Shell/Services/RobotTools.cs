using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One load case on the engineer's form: name, Robot's nature, and whether Robot adds the self-weight.</summary>
    public sealed class RobotCase
    {
        public RobotCase(string name, string nature, bool selfWeight) { Name = name; Nature = nature; SelfWeight = selfWeight; }
        public string Name { get; }
        public string Nature { get; }
        public bool SelfWeight { get; }
    }

    /// <summary>The engineer's form for a hand-off. Every field is the engineer's: the pane never fills one in.</summary>
    public sealed class RobotForm
    {
        public string Supports { get; set; } = "";
        public string Engineer { get; set; } = "";
        public List<RobotCase> Cases { get; } = new List<RobotCase>();
    }

    /// <summary>What fmc_robot answered: a message, table lines and, for status, the runs.</summary>
    public sealed class RobotResult
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public bool Installed { get; set; }
        public bool Running { get; set; }
        public string Run { get; set; } = "";
        public List<string> Runs { get; } = new List<string>();
        public List<(string A, string B, string C)> Lines { get; } = new List<(string, string, string)>();
        /// <summary>results dry run: members with values to write.</summary>
        public int Count { get; set; }
    }

    /// <summary>
    /// Engineer › Structural › Robot (U33, track R). Everything goes through fmc_robot: send the analytical model with the
    /// engineer's form, calculate in Robot, read the results and write them into the kit's FMC_FEA_ fields.
    /// </summary>
    public interface IRobotTools
    {
        Task<RobotResult> StatusAsync();
        Task<RobotResult> SendAsync(RobotForm form, bool dryRun);
        Task<RobotResult> CalculateAsync(string run);
        Task<RobotResult> ResultsAsync(string run, bool dryRun);
    }

    /// <summary>Sample values from board model/PaneModelStructural (Robot).</summary>
    public sealed class MockRobotTools : IRobotTools
    {
        public bool Installed { get; set; } = true;
        public List<string> Log { get; } = new List<string>();

        public Task<RobotResult> StatusAsync()
        {
            var r = new RobotResult { Ok = true, Installed = Installed, Message = Installed ? "Robot is installed, not running." : "Robot isn't installed on this PC." };
            if (Installed) r.Runs.AddRange(new[] { "FEA-20261015-0930", "FEA-20261014-1610" });
            return Task.FromResult(r);
        }

        public Task<RobotResult> SendAsync(RobotForm form, bool dryRun)
        {
            Log.Add((dryRun ? "send dry " : "send ") + form.Supports + " " + form.Cases.Count + " " + form.Engineer);
            var r = new RobotResult { Ok = true, Run = "FEA-20261015-0930",
                Message = dryRun ? "48 nodes, 64 bars and 12 Fixed supports would go to Robot." : "Sent as FEA-20261015-0930. In Robot, add the loads, combinations and code." };
            r.Lines.Add(("Nodes", "48", "ends merged within 1 mm"));
            r.Lines.Add(("Bars", "64", "24 columns, 40 beams"));
            r.Lines.Add(("Supports", "12 " + form.Supports, "ground-floor column bases"));
            r.Lines.Add(("Skipped", "1", "no analytical member: 2 beams"));
            return Task.FromResult(r);
        }

        public Task<RobotResult> CalculateAsync(string run)
        {
            Log.Add("calculate " + run);
            return Task.FromResult(new RobotResult { Ok = true, Run = run, Message = "Robot calculated " + run + "." });
        }

        public Task<RobotResult> ResultsAsync(string run, bool dryRun)
        {
            Log.Add((dryRun ? "results dry " : "results ") + run);
            var r = new RobotResult { Ok = true, Run = run, Count = 3,
                Message = dryRun ? "3 members have results to write." : "Wrote 9 values for 3 members (" + run + ")." };
            r.Lines.Add(("C1 (412088)", "812.4", "41.2"));
            r.Lines.Add(("C2 (412091)", "655.0", "38.7"));
            r.Lines.Add(("B1 (412120)", "12.3", "96.5"));
            return Task.FromResult(r);
        }
    }
}
