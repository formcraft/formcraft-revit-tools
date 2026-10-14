using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>What the pane sends for an issue: the five codes kept apart, the register, the project and the outputs.</summary>
    public sealed class IssueRequest
    {
        public string Register { get; set; } = "";
        public string ProjectFolder { get; set; } = "";
        public string Code { get; set; } = "";
        public string Originator { get; set; } = "FMC";
        public string IssueSet { get; set; } = "CONSTRUCTION";
        public List<string> Disciplines { get; set; } = new List<string>();
        public string Purpose { get; set; } = "For construction";
        public string CompanyRevision { get; set; } = "";
        public string SendTo { get; set; } = "";
        public bool Pdf { get; set; } = true;
        public bool RegisterCsv { get; set; } = true;
        public bool Transmittal { get; set; } = true;
    }

    public sealed class IssueCheckLine
    {
        public IssueCheckLine(string check, string state, string detail) { Check = check; State = state; Detail = detail; }
        public string Check { get; }
        public string State { get; }
        public string Detail { get; }
    }

    public sealed class IssueSheetLine
    {
        public IssueSheetLine(string number, string name, string status, IReadOnlyList<string> reasons, IReadOnlyList<string> excepted, IReadOnlyList<long> ids)
        {
            Number = number; Name = name; Status = status; Reasons = reasons; Excepted = excepted; Ids = ids;
        }
        public string Number { get; }
        public string Name { get; }
        public string Status { get; }
        /// <summary>"item: detail"; the item is what an exception names.</summary>
        public IReadOnlyList<string> Reasons { get; }
        public IReadOnlyList<string> Excepted { get; }
        public IReadOnlyList<long> Ids { get; }
    }

    public sealed class IssueExceptionLine
    {
        public IssueExceptionLine(string sheet, string item, string why, string approvedBy, string until)
        {
            Sheet = sheet; Item = item; Why = why; ApprovedBy = approvedBy; Until = until;
        }
        public string Sheet { get; }
        public string Item { get; }
        public string Why { get; }
        public string ApprovedBy { get; }
        public string Until { get; }
    }

    public sealed class IssueReadiness
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        /// <summary>Ready, Ready with exceptions or Blocked.</summary>
        public string Result { get; set; } = "";
        public string Summary { get; set; } = "";
        public string CheckedAgainst { get; set; } = "";
        public string RevitRevision { get; set; } = "";
        public List<IssueCheckLine> Checks { get; } = new List<IssueCheckLine>();
        public List<IssueSheetLine> Sheets { get; } = new List<IssueSheetLine>();
        public List<IssueExceptionLine> Exceptions { get; } = new List<IssueExceptionLine>();
        public List<string> Problems { get; } = new List<string>();
        public ChipKind Kind => Result == "Ready" ? ChipKind.Good : Result == "Blocked" ? ChipKind.Bad : ChipKind.Warn;
    }

    /// <summary>Drawings › Issue: fmc_issue through the server (the readiness check, exceptions, report and the issue itself).</summary>
    public interface IIssueTools
    {
        Task<IssueReadiness> CheckAsync(IssueRequest q);
        Task<ToolResult> ExceptAsync(IssueRequest q, IssueExceptionLine e);
        Task<ToolResult> ReportAsync(IssueRequest q);
        Task<ToolResult> IssueAsync(IssueRequest q, bool dryRun);
    }

    /// <summary>Sample values from board manage/PaneIssue.</summary>
    public sealed class MockIssueTools : IIssueTools
    {
        public List<IssueRequest> Checks { get; } = new List<IssueRequest>();
        public List<IssueExceptionLine> Recorded { get; } = new List<IssueExceptionLine>();
        public List<bool> Issues { get; } = new List<bool>();

        public Task<IssueReadiness> CheckAsync(IssueRequest q)
        {
            Checks.Add(q);
            bool fixedUp = Recorded.Any(e => e.Sheet == "M-1001");
            var r = new IssueReadiness { Ok = true, Result = fixedUp ? "Ready with exceptions" : "Blocked", CheckedAgainst = "FMC_Rules_Core v0.2 · 14 Oct 14:20", RevitRevision = "Seq 4 · C02 · open",
                Summary = fixedUp ? "5 sheets ready, 2 with an approved exception." : "1 sheet blocked (M-1001). Fix them, or record an approved exception." };
            r.Message = "Checked " + q.IssueSet + " " + q.CompanyRevision + ": " + r.Result + ".";
            r.Checks.AddRange(new[]
            {
                new IssueCheckLine("Sheets exist with valid numbers", "Pass", "5 / 5"),
                new IssueCheckLine("Title blocks filled", "Warn", "5 / 5, 1 excepted"),
                new IssueCheckLine("Mandatory rules pass", fixedUp ? "Warn" : "Fail", "1 fail"),
                new IssueCheckLine("Open reviews on these sheets", "N/A", "Review items arrive with Team › Review"),
                new IssueCheckLine("Links checked", "Pass", "2 pinned"),
                new IssueCheckLine("Sheet status codes valid", "Pass", "OK"),
                new IssueCheckLine("Revision and purpose valid", "Pass", "OK"),
                new IssueCheckLine("Approvals recorded", "Warn", "4 of 5, 1 excepted"),
            });
            r.Sheets.AddRange(new[]
            {
                new IssueSheetLine("Z-0001", "Sheet index", "Ready", new string[0], new string[0], new long[] { 1 }),
                new IssueSheetLine("A-1001", "GA ground floor", "Ready", new string[0], new string[0], new long[] { 2 }),
                new IssueSheetLine("A-2001", "Elevations", "Exception", new string[0], new[] { "approval: Approved By empty (NAME A)" }, new long[] { 3 }),
                new IssueSheetLine("S-1001", "Foundation plan", "Ready", new string[0], new string[0], new long[] { 4 }),
                fixedUp ? new IssueSheetLine("M-1001", "Ventilation L00", "Exception", new string[0], new[] { "rule SHT-019: Sheet status filled (NAME F)" }, new long[] { 5 })
                        : new IssueSheetLine("M-1001", "Ventilation L00", "Blocked", new[] { "rule SHT-019: Sheet status filled" }, new string[0], new long[] { 5 }),
            });
            r.Exceptions.Add(new IssueExceptionLine("A-2001", "approval", "Façade colour agreed by phone", "NAME A", "C03"));
            r.Exceptions.AddRange(Recorded);
            return Task.FromResult(r);
        }

        public Task<ToolResult> ExceptAsync(IssueRequest q, IssueExceptionLine e)
        {
            Recorded.Add(e);
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Exception recorded; result recalculated."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> ReportAsync(IssueRequest q)
        {
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, @"Readiness report saved to 06_QA\Issue."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> IssueAsync(IssueRequest q, bool dryRun)
        {
            Issues.Add(dryRun);
            var r = new ToolResult { Ok = true, Count = 7 };
            if (dryRun) r.Details.AddRange(new[] { "F26001-FMC-ZZ-ZZ-DR-Z-0001.pdf", "F26001-FMC-ZZ-ZZ-DR-A-1001.pdf", "F26001_Drawing_Register_C02.csv", "F26001_Transmittal_C02.md" });
            else r.Messages.Add(new ToolMessage(ChipKind.Good, @"Issued to 01_WIP\_Issue\2026-10-14_C02: 5 PDFs, register, transmittal and report."));
            return Task.FromResult(r);
        }
    }
}
