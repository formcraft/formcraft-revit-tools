using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class WorksetLine
    {
        public WorksetLine(string name, string owner, bool open, string problem) { Name = name; Owner = owner; Open = open; Problem = problem; }
        public string Name { get; }
        /// <summary>Who is editing it now (empty: nobody).</summary>
        public string Owner { get; }
        public bool Open { get; }
        /// <summary>Naming problem against [Role]_[Content] (MAN 4.6); empty when the name is right.</summary>
        public string Problem { get; }
    }

    public sealed class PreflightLine
    {
        public PreflightLine(string check, string state, string detail) { Check = check; State = state; Detail = detail; }
        public string Check { get; }
        public string State { get; }
        public string Detail { get; }
    }

    public sealed class WorkshareFacts
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public string Role { get; set; } = "";
        public bool Workshared { get; set; }
        public string Central { get; set; } = "";
        public string User { get; set; } = "";
        public List<WorksetLine> Worksets { get; } = new List<WorksetLine>();
        public List<string> StandardSet { get; } = new List<string>();
        public List<string> Missing { get; } = new List<string>();
        public List<PreflightLine> Preflight { get; } = new List<PreflightLine>();
    }

    public sealed class SyncMessageRequest
    {
        public string ProjectCode { get; set; } = "";
        public string ProjectFolder { get; set; } = "";
        public string Revision { get; set; } = "";
        public List<string> Worked { get; set; } = new List<string>();
        public List<string> Raised { get; set; } = new List<string>();
        public string What { get; set; } = "";
    }

    /// <summary>Team › Workshare: fmc_workshare through the server. Nothing here syncs or saves (rule 6).</summary>
    public interface IWorkshareTools
    {
        Task<WorkshareFacts> FactsAsync(IReadOnlyList<string> linkedRoles);
        Task<ToolResult> CreateAsync(IReadOnlyList<string> names, IReadOnlyList<string> linkedRoles, bool dryRun);
        Task<(bool Ok, string Message, string Text)> MessageAsync(SyncMessageRequest q, bool record);
    }

    /// <summary>Sample values from board manage/PaneWorkshare.</summary>
    public sealed class MockWorkshareTools : IWorkshareTools
    {
        public List<(IReadOnlyList<string> Names, bool Dry)> Created { get; } = new List<(IReadOnlyList<string>, bool)>();
        public List<(SyncMessageRequest Q, bool Record)> Messages { get; } = new List<(SyncMessageRequest, bool)>();

        public Task<WorkshareFacts> FactsAsync(IReadOnlyList<string> linkedRoles)
        {
            var f = new WorkshareFacts { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", Role = "A", Workshared = true,
                Central = @"Z:\Projects\F26001\01_WIP\A\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", User = "[name.b]", Message = "4 worksets, 2 of the standard set missing." };
            f.Worksets.AddRange(new[]
            {
                new WorksetLine("Z_Grids_Levels", "", true, ""),
                new WorksetLine("A_Shell", "[name.b]", true, ""),
                new WorksetLine("A_Interior", "[name.c]", true, ""),
                new WorksetLine("Workset1", "", true, "Workset1 doesn't follow [Role]_[Content], e.g. A_Facade (MAN 4.6)"),
            });
            f.StandardSet.AddRange(new[] { "Z_Grids_Levels" }.Concat(linkedRoles.Where(r => r != "A").Select(r => "Z_Links_" + r)).Concat(new[] { "A_Shell", "A_Interior", "A_Site" }));
            f.Missing.AddRange(f.StandardSet.Where(s => !f.Worksets.Any(w => w.Name == s)));
            f.Preflight.AddRange(new[]
            {
                new PreflightLine("Central model reachable", "Pass", "OK"),
                new PreflightLine("Warnings added since your last check", "Warn", "+3 (41 now)"),
                new PreflightLine("Worksets you're editing", "Warn", "A_Shell: relinquish after syncing"),
            });
            return Task.FromResult(f);
        }

        public Task<ToolResult> CreateAsync(IReadOnlyList<string> names, IReadOnlyList<string> linkedRoles, bool dryRun)
        {
            Created.Add((names, dryRun));
            var r = new ToolResult { Ok = true, Count = names.Count == 0 ? 2 : names.Count };
            var list = names.Count == 0 ? new[] { "Z_Links_S", "A_Site" } : names.ToArray();
            if (dryRun) r.Details.AddRange(list.Select(n => n + ": would create"));
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "Created " + string.Join(", ", list) + ". A person syncs to share them."));
            return Task.FromResult(r);
        }

        public Task<(bool Ok, string Message, string Text)> MessageAsync(SyncMessageRequest q, bool record)
        {
            Messages.Add((q, record));
            if (q.What.Trim().Length == 0) return Task.FromResult((false, "Say what you did: the sync message needs it.", ""));
            var parts = new List<string> { q.ProjectCode.Length > 0 ? q.ProjectCode : "PROJ", "A", q.Revision.Length > 0 ? q.Revision : "No revision" };
            if (q.Worked.Count > 0) parts.Add("Worked: " + string.Join(", ", q.Worked));
            if (q.Raised.Count > 0) parts.Add("New: " + string.Join(", ", q.Raised));
            parts.Add(q.What.Trim());
            parts.Add("[name.b]");
            return Task.FromResult((true, record ? "Saved to the sync log." : "Message ready.", string.Join(" | ", parts)));
        }
    }
}
