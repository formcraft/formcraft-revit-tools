using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One rule from the kit's rulebooks (rule schema v1).</summary>
    public sealed class RuleInfo
    {
        public string Id { get; set; } = "";
        public string Rule { get; set; } = "";
        public string Severity { get; set; } = "";
        public string Status { get; set; } = "";
        public string Book { get; set; } = "";
        public string Scope { get; set; } = "";
        public string Test { get; set; } = "";
        public string FixHint { get; set; } = "";
        public string Version { get; set; } = "";
        public string Why { get; set; } = "";
    }

    public sealed class RuleException
    {
        public string Rule { get; set; } = "";
        public string Where { get; set; } = "";
        public string ApprovedBy { get; set; } = "";
        public string Until { get; set; } = "";
    }

    public sealed class RulebookSet
    {
        public bool Ok { get; set; }
        public List<(string Name, string Version, int Count)> Books { get; } = new List<(string, string, int)>();
        public List<RuleInfo> Rules { get; } = new List<RuleInfo>();
        public List<RuleException> Exceptions { get; } = new List<RuleException>();
        public List<(string Text, string State)> Decisions { get; } = new List<(string, string)>();
        public List<string> Problems { get; } = new List<string>();
    }

    public sealed class QaResult
    {
        public string Id { get; set; } = "";
        public string Rule { get; set; } = "";
        public string Severity { get; set; } = "";
        public string State { get; set; } = "";
        public string Where { get; set; } = "";
        public List<long> ElementIds { get; } = new List<long>();
        public string FixHint { get; set; } = "";
        public string Excepted { get; set; } = "";
        public ChipKind Kind => State == "Fail" ? ChipKind.Bad : State == "Warning" ? ChipKind.Warn : State == "Pass" ? ChipKind.Good : ChipKind.Grey;
    }

    public sealed class QaRun
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public string GateName { get; set; } = "";
        public int Ran { get; set; }
        public int Pass { get; set; }
        public int Fail { get; set; }
        public int Warning { get; set; }
        public int NotApplicable { get; set; }
        public int NotChecked { get; set; }
        public string Summary { get; set; } = "";
        public List<QaResult> Results { get; } = new List<QaResult>();
        public (int New, int Recurring, int Resolved) Trend { get; set; }
        public List<(string At, int Failing)> History { get; } = new List<(string, int)>();
        public string Report { get; set; } = "";
    }

    /// <summary>QA and Rules: fmc_qa through the server (rulebooks from the kit, facts from Revit).</summary>
    public interface IQaTools
    {
        Task<RulebookSet> RulesAsync();
        Task<QaRun> RunAsync(string gate, string projectFolder);
        Task<string> SelectAsync(IReadOnlyList<long> elementIds);
        Task<string> RequestAsync(string rule, string kind, string text, string severity);
    }

    /// <summary>Sample values from boards manage/PaneQA and manage/PaneRules.</summary>
    public sealed class MockQaTools : IQaTools
    {
        public List<string> Requests { get; } = new List<string>();
        public List<long> Selected { get; } = new List<long>();

        public Task<RulebookSet> RulesAsync()
        {
            var r = new RulebookSet { Ok = true };
            r.Books.AddRange(new[] { ("Annotation", "0.2", 3), ("Naming", "0.2", 1), ("Sheets", "0.2", 1) });
            r.Rules.AddRange(new[]
            {
                new RuleInfo { Id = "ANN-003", Rule = "Notes are Arial 2.5 mm", Severity = "Must", Status = "Standard", Book = "Annotation", Scope = "All disciplines", Test = "Text types", FixHint = "Use FMC_Arial_2.5", Version = "v0.2" },
                new RuleInfo { Id = "ANN-030", Rule = "Tags never overlap", Severity = "Should", Status = "Proposed", Book = "Annotation", Scope = "Drawings", Test = "Tag extents", FixHint = "Tag Tidy", Version = "v0.2" },
                new RuleInfo { Id = "ANN-034", Rule = "Tags on live models: Leads only", Severity = "Must", Status = "Plugin", Book = "Annotation", Scope = "All disciplines · all stages",
                    Test = "Role from the team file + discipline of the view + preview shown", FixHint = "Ask your discipline lead, or run on a test copy", Version = "v0.2 · changed 13 Oct · Decision 3",
                    Why = "Tags on live models change sheets other people are printing." },
                new RuleInfo { Id = "NAM-012", Rule = "View name pattern", Severity = "Must", Status = "Standard", Book = "Naming", FixHint = "Rename to A_FP_Lxx_Purpose", Version = "v0.2" },
                new RuleInfo { Id = "SHT-022", Rule = "Sheet parameter empty", Severity = "Should", Status = "Standard", Book = "Sheets", FixHint = "Fill FMC_Sheet_Status", Version = "v0.2" },
            });
            r.Exceptions.Add(new RuleException { Rule = "SHT-022", Where = "A-2001", ApprovedBy = "[NAME A]", Until = "C03" });
            r.Decisions.AddRange(new[] { ("Stages: gates and issue sets drive; RIBA a label", "decided"), ("Rename the gates in the Manual (G1 clash)", "change request") });
            return Task.FromResult(r);
        }

        public Task<QaRun> RunAsync(string gate, string projectFolder)
        {
            var r = new QaRun
            {
                Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", GateName = "WIP → Shared (Discipline Lead)", Ran = 41, Pass = 36, Fail = 2, Warning = 0, NotApplicable = 3, NotChecked = 0,
                Summary = "2 Must rules block the move: QA-011 (12 types), NAM-012 (3 views).", Trend = (2, 15, 6),
                Report = @"%USERPROFILE%\FMC_Reports\QA\FMC_QA_F26001-FMC-ZZ-ZZ-M3-A-0001_20261014-1042.md", Message = "QA ran: 41 checks, 2 fail.",
            };
            var a = new QaResult { Id = "NAM-012", Rule = "View name pattern", Severity = "Must", State = "Fail", Where = "3 views", FixHint = "Rename to A_FP_Lxx_Purpose" };
            a.ElementIds.AddRange(new long[] { 101, 102, 103 });
            var b = new QaResult { Id = "QA-011", Rule = "Type without a code", Severity = "Must", State = "Fail", Where = "12 types", FixHint = "Set the keynote and element code" };
            b.ElementIds.AddRange(Enumerable.Range(200, 12).Select(i => (long)i));
            r.Results.AddRange(new[] { a, b,
                new QaResult { Id = "SHT-022", Rule = "Sheet parameter empty", Severity = "Should", State = "Pass", Where = "" },
                new QaResult { Id = "QA-050", Rule = "Coordinates shared", Severity = "Must", State = "Not checked", Where = "The plugin doesn't run check kind \"survey_point_shared\" yet" } });
            r.History.AddRange(new[] { ("2026-10-13", 17), ("2026-10-06", 21), ("2026-09-29", 17) });
            return Task.FromResult(r);
        }

        public Task<string> SelectAsync(IReadOnlyList<long> elementIds)
        {
            Selected.AddRange(elementIds);
            return Task.FromResult("Selected " + elementIds.Count + " elements in Revit.");
        }

        public Task<string> RequestAsync(string rule, string kind, string text, string severity)
        {
            Requests.Add(kind + " " + rule + " " + severity + " " + text);
            return Task.FromResult((kind == "approve" ? "Approval" : "Change request") + " for " + rule + " recorded for the BIM Manager.");
        }
    }
}
