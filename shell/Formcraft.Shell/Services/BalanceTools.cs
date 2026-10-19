using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One share of the calls: a kind (AI code, plugin tools…) or who started them (ai, pane, job…).</summary>
    public sealed class BalanceShare
    {
        public BalanceShare(string key, string label, int calls, double share) { Key = key; Label = label; Calls = calls; Share = share; }
        public string Key { get; }
        public string Label { get; }
        public int Calls { get; }
        /// <summary>Per cent of the calls, 0–100.</summary>
        public double Share { get; }
    }

    /// <summary>One week of the trend.</summary>
    public sealed class BalanceWeek
    {
        public BalanceWeek(string week, int total, double aiShare) { Week = week; Total = total; AiShare = aiShare; }
        /// <summary>The week's Monday, YYYY-MM-DD.</summary>
        public string Week { get; }
        public int Total { get; }
        public double AiShare { get; }
    }

    /// <summary>fmc_balance summary: the shares by kind and by who started them, and the trend by week.</summary>
    public sealed class BalanceSummary
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public int Total { get; set; }
        public double AiShare { get; set; }
        public List<BalanceShare> ByKind { get; } = new List<BalanceShare>();
        /// <summary>The plugin tools alone, by who started them.</summary>
        public List<BalanceShare> PluginByStartedBy { get; } = new List<BalanceShare>();
        public List<BalanceShare> ExternalByKind { get; } = new List<BalanceShare>();
        public List<BalanceWeek> Weeks { get; } = new List<BalanceWeek>();
    }

    /// <summary>One group of the move list: AI-code calls with the same purpose (or code), and where they should move.</summary>
    public sealed class BacklogItem
    {
        public int Rank { get; set; }
        public string Purpose { get; set; } = "";
        public int Calls { get; set; }
        public int Errors { get; set; }
        public long Ms { get; set; }
        public List<string> Projects { get; } = new List<string>();
        public string Home { get; set; } = "";
        public string Scripts { get; set; } = "";
        public string Priority { get; set; } = "";
        /// <summary>planned, in progress, built or tested ("" when no home matched).</summary>
        public string Status { get; set; } = "";
        public string TrackerStatus { get; set; } = "";
        public string Feature { get; set; } = "";
        public string Last { get; set; } = "";
    }

    /// <summary>Check › Automation (F74): fmc_balance through the server. Counts calls and runs, never people (rule 9).</summary>
    public interface IBalanceTools
    {
        /// <summary>The last <paramref name="weeks"/> whole weeks; one project's calls when <paramref name="project"/> is set.</summary>
        Task<BalanceSummary> SummaryAsync(int weeks, string project);
        Task<(bool Ok, string Message, List<BacklogItem> Items)> BacklogAsync(int weeks, string project);
        /// <summary>Tidy CSVs for Power BI into the project's 01_WIP\_Exchange\Balance (dry run first).</summary>
        Task<ToolResult> ExportAsync(string projectFolder, int weeks, bool dryRun);
    }

    /// <summary>Sample values: a KISIC-like month, AI code falling from 80% to 40% as tools take over.</summary>
    public sealed class MockBalanceTools : IBalanceTools
    {
        public List<(string Op, bool Dry)> Calls { get; } = new List<(string, bool)>();
        public string? LastProject { get; private set; }
        public bool Empty { get; set; }

        public Task<BalanceSummary> SummaryAsync(int weeks, string project)
        {
            LastProject = project;
            Calls.Add(("summary", false));
            var s = new BalanceSummary { Ok = true, From = "2026-09-28", To = "2026-10-19" };
            if (Empty) { s.Message = "No calls recorded in the period."; return Task.FromResult(s); }
            s.Total = 160;
            s.AiShare = 55;
            s.Message = "160 calls from 2026-09-28 to 2026-10-19.";
            s.ByKind.AddRange(new[]
            {
                new BalanceShare("ai_code", "AI code", 88, 55), new BalanceShare("plugin_tool", "Plugin tools", 52, 32.5),
                new BalanceShare("saved_addon", "Saved add-ons", 4, 2.5), new BalanceShare("external", "External automation", 16, 10),
            });
            s.PluginByStartedBy.AddRange(new[]
            {
                new BalanceShare("ai", "ai", 30, 57.7), new BalanceShare("pane", "pane", 16, 30.8), new BalanceShare("job", "job", 4, 7.7),
                new BalanceShare("schedule", "schedule", 2, 3.8),
            });
            s.ExternalByKind.AddRange(new[] { new BalanceShare("pyrevit", "pyrevit", 10, 62.5), new BalanceShare("dynamo", "dynamo", 6, 37.5) });
            s.Weeks.AddRange(new[]
            {
                new BalanceWeek("2026-09-28", 20, 80), new BalanceWeek("2026-10-05", 40, 70), new BalanceWeek("2026-10-12", 78, 63), new BalanceWeek("2026-10-19", 22, 40.9),
            });
            return Task.FromResult(s);
        }

        public Task<(bool Ok, string Message, List<BacklogItem> Items)> BacklogAsync(int weeks, string project)
        {
            Calls.Add(("backlog", false));
            if (Empty) return Task.FromResult((true, "No AI code in the period.", new List<BacklogItem>()));
            var a = new BacklogItem { Rank = 1, Purpose = "Export sheet PNGs", Calls = 14, Errors = 2, Ms = 52000, Home = "fmc_view screenshot and fmc_sheets export pdf",
                Scripts = "03_check_views.cs, 24_export_png_pdf.cs", Priority = "P1", Status = "planned", Last = "2026-10-19T07:10:00Z" };
            a.Projects.Add("KISIC");
            var b = new BacklogItem { Rank = 2, Purpose = "LED strips on room walls", Calls = 9, Ms = 7000, Home = "Add-on strips_on_room_walls",
                Scripts = "06_lighting.cs, 12_*, 18_veranda_switching.cs", Priority = "P2", Status = "planned", Last = "2026-10-18T22:00:00Z" };
            b.Projects.Add("KISIC");
            var c = new BacklogItem { Rank = 3, Purpose = "Legend views from the seed", Calls = 6, Errors = 1, Ms = 310000, Home = "fmc_legend build",
                Scripts = "20a_legends_sheet.cs, 22b_legend_relayout.cs", Priority = "P2", Status = "built", TrackerStatus = "Built, Revit check due", Feature = "F67",
                Last = "2026-10-19T02:00:00Z" };
            var d = new BacklogItem { Rank = 4, Purpose = "(no purpose) code 3f2a9c1b7d40", Calls = 3, Ms = 900, Home = "Unknown: ask the AI to pass purpose" };
            return Task.FromResult((true, "4 groups of AI code.", new List<BacklogItem> { a, b, c, d }));
        }

        public Task<ToolResult> ExportAsync(string projectFolder, int weeks, bool dryRun)
        {
            Calls.Add(("export", dryRun));
            var r = new ToolResult { Ok = true };
            var dir = projectFolder + @"\01_WIP\_Exchange\Balance";
            if (dryRun) { r.Count = 2; r.Details.Add(dir + @"\FMC_Balance_Calls.csv (31 rows)"); r.Details.Add(dir + @"\FMC_Balance_Backlog.csv (4 rows)"); return Task.FromResult(r); }
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Saved for Power BI: FMC_Balance_Calls.csv and FMC_Balance_Backlog.csv in " + dir + "."));
            return Task.FromResult(r);
        }
    }
}
