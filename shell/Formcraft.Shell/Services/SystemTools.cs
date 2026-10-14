using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class CheckLine
    {
        public CheckLine(string check, string found, string state) { Check = check; Found = found; State = state; }
        public string Check { get; }
        public string Found { get; }
        /// <summary>Pass, Warn, Fail, Engineer or Info.</summary>
        public string State { get; }
    }

    public sealed class BoardLine
    {
        public string Name { get; set; } = "";
        public double ConnectedVa { get; set; }
        public double DemandVa { get; set; }
        public int Circuits { get; set; }
        public string FedBy { get; set; } = "";
        public string Check { get; set; } = "";
        public string Note { get; set; } = "";
    }

    public sealed class ResultLine
    {
        public string Mark { get; set; } = "";
        public string Type { get; set; } = "";
        public double Utilisation { get; set; }
        public string Run { get; set; } = "";
    }

    /// <summary>A read-only systems check (fmc_systems), with the saved list when asked.</summary>
    public sealed class SystemsCheck
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public List<CheckLine> Checks { get; } = new List<CheckLine>();
        public List<BoardLine> Boards { get; } = new List<BoardLine>();
        public List<ResultLine> Results { get; } = new List<ResultLine>();
        public List<string> NotInKit { get; } = new List<string>();
        public string Members { get; set; } = "";
        public string Saved { get; set; } = "";
    }

    /// <summary>Engineer › Systems and Structural (U25): fmc_systems through the server. Read-only.</summary>
    public interface ISystemTools
    {
        Task<SystemsCheck> ElectricalAsync(string projectFolder, bool save);
        Task<SystemsCheck> StructuralAsync(string kitFolder, string projectFolder, bool save);
    }

    /// <summary>Sample values from boards model/PaneModelSystems and PaneModelStructural.</summary>
    public sealed class MockSystemTools : ISystemTools
    {
        public List<string> Ran { get; } = new List<string>();

        public Task<SystemsCheck> ElectricalAsync(string projectFolder, bool save)
        {
            Ran.Add("electrical" + (save ? " save" : ""));
            var c = new SystemsCheck { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-E-0001", Message = "3 boards checked.", Saved = save ? projectFolder + @"\06_QA\Systems\FMC_Electrical_Check.md" : "" };
            c.Boards.Add(new BoardLine { Name = "MDB", ConnectedVa = 86000, DemandVa = 61000, Circuits = 6, Check = "Pass", Note = "Fed by no other board (the main board?)" });
            c.Boards.Add(new BoardLine { Name = "DB-L1", ConnectedVa = 18400, DemandVa = 14200, Circuits = 0, FedBy = "MDB / 3", Check = "Warn", Note = "No circuits on this board" });
            c.Boards.Add(new BoardLine { Name = "DB-MECH", ConnectedVa = 22000, DemandVa = 22000, Circuits = 4, FedBy = "MDB / 5", Check = "Pass" });
            c.Checks.Add(new CheckLine("Boards with no circuits", "1", "Warn"));
            c.Checks.Add(new CheckLine("Electrical Fixtures on no circuit", "6 of 40", "Warn"));
            return Task.FromResult(c);
        }

        public Task<SystemsCheck> StructuralAsync(string kitFolder, string projectFolder, bool save)
        {
            Ran.Add("structural" + (save ? " save" : ""));
            var c = new SystemsCheck { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-S-0001", Members = "48 columns, 166 beams, 32 foundations", Message = "214 members checked.",
                Saved = save ? projectFolder + @"\06_QA\Systems\FMC_Structural_Check.md" : "" };
            c.Checks.Add(new CheckLine("Members not joined at nodes", "3", "Warn"));
            c.Checks.Add(new CheckLine("Columns with no footing, beam, slab or wall below", "1", "Fail"));
            c.Checks.Add(new CheckLine("Physical and analytical out by more than 50 mm", "0", "Pass"));
            c.Checks.Add(new CheckLine("Members missing FMC_Concrete_Grade", "12", "Warn"));
            c.Checks.Add(new CheckLine("Load cases and combinations", "None yet", "Engineer"));
            c.Results.Add(new ResultLine { Mark = "B-1-07", Type = "230x450", Utilisation = 1.12, Run = "FEA-03" });
            c.Results.Add(new ResultLine { Mark = "B-1-12", Type = "230x450", Utilisation = 0.94, Run = "FEA-03" });
            return Task.FromResult(c);
        }
    }
}
