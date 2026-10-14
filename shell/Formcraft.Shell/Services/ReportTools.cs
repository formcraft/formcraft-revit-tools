using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class ReportRequest
    {
        public string ProjectFolder { get; set; } = "";
        public string ProjectCode { get; set; } = "";
        public string Originator { get; set; } = "FMC";
        public string Kind { get; set; } = "Weekly project report";
        public string Period { get; set; } = "Last 7 days";
        public string Audience { get; set; } = "Team";
        public List<string> Disciplines { get; set; } = new List<string>();
        public bool Markdown { get; set; } = true;
        public bool Csv { get; set; } = true;
    }

    /// <summary>Check › Reports: fmc_report through the server (reports traced to the plugin's own saved files).</summary>
    public interface IReportTools
    {
        /// <summary>The report's text without saving (the preview).</summary>
        Task<(bool Ok, string Message, string Preview, List<string> LeftOut)> PreviewAsync(ReportRequest q);
        Task<ToolResult> MakeAsync(ReportRequest q);
        Task<List<(string File, string Date)>> RecentAsync(string projectFolder);
    }

    /// <summary>Sample values from board manage/PaneReports.</summary>
    public sealed class MockReportTools : IReportTools
    {
        public List<ReportRequest> Made { get; } = new List<ReportRequest>();

        public Task<(bool Ok, string Message, string Preview, List<string> LeftOut)> PreviewAsync(ReportRequest q)
        {
            var leftOut = q.Audience == "Client" ? new List<string> { "Review owners' names" } : new List<string>();
            var text = "# F26001 · " + q.Kind + "\n\n- 7 open review items, 1 overdue\n- 12 syncs\n" + (q.Audience == "Client" ? "" : "\n| Item | Owner |\n| ISS-0014 | [NAME F] |\n");
            return Task.FromResult((true, "Preview ready.", text, leftOut));
        }

        public Task<ToolResult> MakeAsync(ReportRequest q)
        {
            Made.Add(q);
            var r = new ToolResult { Ok = true, Count = 1 };
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Saved F26001-FMC-ZZ-ZZ-RP-Z-000" + (6 + Made.Count) + " (Markdown and CSV)."));
            return Task.FromResult(r);
        }

        public Task<List<(string File, string Date)>> RecentAsync(string projectFolder) =>
            Task.FromResult(Made.Select((m, i) => ("F26001-FMC-ZZ-ZZ-RP-Z-000" + (7 + i) + ".md", "2026-10-14")).Reverse().ToList());
    }
}
