using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>What a Concept Information Set would set up, read and checked against the kit (fmc_brief plan).</summary>
    public sealed class BriefPlan
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Project { get; set; } = "";
        public string Revision { get; set; } = "";
        public string Approved { get; set; } = "";
        public int Levels { get; set; }
        public int ProjectInfo { get; set; }
        public int Rooms { get; set; }
        public int Families { get; set; }
        public List<string> Blanks { get; } = new List<string>();
        public List<string> Problems { get; } = new List<string>();
        public List<string> Skipped { get; } = new List<string>();
        /// <summary>The first rooms: number, name, target area, finish set.</summary>
        public List<(string Number, string Name, string Area, string Finish)> RoomRows { get; } = new List<(string, string, string, string)>();
        /// <summary>The active model's title, and whether it is new and unsaved (the only kind this runs on).</summary>
        public string Model { get; set; } = "";
        public string ModelProblem { get; set; } = "";
    }

    /// <summary>Model › Start from brief (U23): fmc_brief through the server.</summary>
    public interface IBriefTools
    {
        Task<BriefPlan> PlanAsync(string cisFile, string kitFolder);
        /// <summary>A dry run lists the counts and is rolled back; the real run is one Undo.</summary>
        Task<ToolResult> ApplyAsync(string cisFile, string kitFolder, bool dryRun);
    }

    /// <summary>Sample values from board model/PaneModelBrief.</summary>
    public sealed class MockBriefTools : IBriefTools
    {
        public List<bool> Applied { get; } = new List<bool>();
        public bool SavedModel { get; set; }

        public Task<BriefPlan> PlanAsync(string cisFile, string kitFolder)
        {
            var p = new BriefPlan { Ok = true, Project = "F26001", Revision = "R4", Approved = "2026-10-13", Levels = 5, ProjectInfo = 9, Rooms = 38, Families = 14,
                Model = SavedModel ? "F26001-FMC-ZZ-ZZ-M3-A-0001" : "Project1", ModelProblem = SavedModel ? "The active model is saved: Start from brief runs only on a new, unsaved model" : "" };
            p.Blanks.AddRange(new[] { "FMC_Building_Permit_Ref", "FMC_Benchmark" });
            p.Skipped.Add("21 materials: the kit has no materials library yet (F-011), so none are loaded");
            p.RoomRows.AddRange(new[] { ("G01", "Genkan", "9.0", "FS-01"), ("G02", "Living", "42.0", "FS-03"), ("G03", "Dining", "24.0", "FS-03"), ("G04", "Kitchen", "21.0", "FS-05") });
            p.Message = "CIS R4 · approved 2026-10-13";
            return Task.FromResult(p);
        }

        public Task<ToolResult> ApplyAsync(string cisFile, string kitFolder, bool dryRun)
        {
            Applied.Add(dryRun);
            var r = new ToolResult { Ok = !SavedModel };
            if (SavedModel) return Task.FromResult(ToolResult.Refused("Start from brief runs only on a new, unsaved model."));
            if (dryRun) { r.Details.AddRange(new[] { "Levels: 5", "Rooms (unplaced): 38", "Project Information values: 9", "Families: 14" }); r.Count = 4; }
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "Model set up from the brief: 5 levels, 38 rooms, 9 values, 14 families. One Undo; logged."));
            return Task.FromResult(r);
        }
    }
}
