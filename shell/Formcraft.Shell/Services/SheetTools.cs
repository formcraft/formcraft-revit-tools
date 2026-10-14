using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class SheetDiff
    {
        public SheetDiff(string number, string difference, string registerName, string modelName)
        {
            Number = number; Difference = difference; RegisterName = registerName; ModelName = modelName;
        }
        public string Number { get; }
        public string Difference { get; }
        public string RegisterName { get; }
        public string ModelName { get; }
        public string Label => Number + " " + (RegisterName.Length > 0 ? RegisterName : ModelName);
    }

    public sealed class SheetProgress
    {
        public SheetProgress(string number, string name, int views, int filled, int fields, string status, int percent)
        {
            Number = number; Name = name; Views = views; Filled = filled; Fields = fields; Status = status; Percent = percent;
        }
        public string Number { get; }
        public string Name { get; }
        public int Views { get; }
        public int Filled { get; }
        public int Fields { get; }
        public string Status { get; }
        public int Percent { get; }
    }

    public sealed class SheetComparison
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public int Planned { get; set; }
        public int InModel { get; set; }
        public List<SheetDiff> Differences { get; } = new List<SheetDiff>();
        public List<SheetProgress> Completeness { get; } = new List<SheetProgress>();
        public List<string> TitleBlocks { get; } = new List<string>();
        public List<string> Problems { get; } = new List<string>();
    }

    /// <summary>Drawings › Sheets: fmc_sheets through the server (the project's register against the model).</summary>
    public interface ISheetTools
    {
        Task<SheetComparison> CompareAsync(string register, string issueSet, IReadOnlyList<string> roles);
        Task<ToolResult> CreateAsync(string register, string issueSet, IReadOnlyList<string> roles, string titleBlock, bool dryRun);
        Task<ToolResult> RenameAsync(string register, string issueSet, IReadOnlyList<string> roles, bool dryRun);
    }

    /// <summary>Sample values from board manage/PaneSheets.</summary>
    public sealed class MockSheetTools : ISheetTools
    {
        public List<(string Action, bool Dry)> Runs { get; } = new List<(string, bool)>();

        public Task<SheetComparison> CompareAsync(string register, string issueSet, IReadOnlyList<string> roles)
        {
            var c = new SheetComparison { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", Planned = 4, InModel = 4, Message = "Compared 4 planned sheets with the model." };
            c.Differences.AddRange(new[]
            {
                new SheetDiff("A-1002", "Missing", "First floor plan", ""), new SheetDiff("A-9001", "Extra", "", "Old option B"),
                new SheetDiff("S-1001", "Name differs", "Foundation plan", "Foundations"),
            });
            c.Completeness.AddRange(new[]
            {
                new SheetProgress("Z-0001", "Cover and index", 1, 5, 5, "Done", 100), new SheetProgress("A-1001", "Ground floor plan", 2, 3, 5, "In work", 80),
                new SheetProgress("A-1002", "First floor plan", 0, 0, 0, "Due", 0), new SheetProgress("S-1001", "Foundations", 1, 1, 5, "In work", 60),
            });
            c.TitleBlocks.AddRange(new[] { "FMC_TitleBlock : A1", "FMC_TitleBlock : A3" });
            return Task.FromResult(c);
        }

        public Task<ToolResult> CreateAsync(string register, string issueSet, IReadOnlyList<string> roles, string titleBlock, bool dryRun) => Run("create", dryRun, "A-1002 First floor plan");
        public Task<ToolResult> RenameAsync(string register, string issueSet, IReadOnlyList<string> roles, bool dryRun) => Run("rename", dryRun, "S-1001 Foundations → Foundation plan");

        private Task<ToolResult> Run(string action, bool dry, string line)
        {
            Runs.Add((action, dry));
            var r = new ToolResult { Ok = true, Count = 1 };
            if (dry) r.Details.Add(line);
            else r.Messages.Add(new ToolMessage(ChipKind.Good, (action == "create" ? "Created" : "Renamed") + " 1 sheet. Logged in FMC_MCP_FileLog.csv."));
            return Task.FromResult(r);
        }
    }
}
