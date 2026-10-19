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

    /// <summary>
    /// Engineer › Systems › Diagrams (LD5, E2): one run of fmc_diagram. Views and sheets are rows of three cells
    /// (name, detail, state); Lines are Gate D's checks.
    /// </summary>
    public sealed class DiagramRun
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public List<CheckLine> Views { get; } = new List<CheckLine>();
        public List<CheckLine> Sheets { get; } = new List<CheckLine>();
        public List<CheckLine> Lines { get; } = new List<CheckLine>();
        public List<string> KitRequests { get; } = new List<string>();
        public string Verdict { get; set; } = "";
    }

    /// <summary>The diagram runs the pane offers. Plan and Generate cover the drafting views and the register sheets.</summary>
    public static class DiagramActions
    {
        public const string Scan = "scan";
        /// <summary>The draw and the sheets as dry runs: the real run rolled back in Revit, nothing changed.</summary>
        public const string Plan = "plan";
        /// <summary>The draw and the sheets for real, after a person's yes to the plan: one Undo each, never saved.</summary>
        public const string Generate = "generate";
        public const string Gate = "gate";
    }

    /// <summary>Engineer › Systems and Structural (U25): fmc_systems through the server, read-only; and the line diagrams (LD5).</summary>
    public interface ISystemTools
    {
        Task<SystemsCheck> ElectricalAsync(string projectFolder, bool save);
        Task<SystemsCheck> StructuralAsync(string kitFolder, string projectFolder, bool save);
        /// <summary>fmc_diagram for these kinds: scan, plan (dry runs), generate (real, after a yes) or gate (Gate D, read-only).</summary>
        Task<DiagramRun> DiagramAsync(string action, IReadOnlyList<string> kinds, string kitFolder);
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

        public Task<DiagramRun> DiagramAsync(string action, IReadOnlyList<string> kinds, string kitFolder)
        {
            Ran.Add("diagram " + action + " " + string.Join("+", kinds));
            var r = new DiagramRun { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-E-0001" };
            bool plan = action == DiagramActions.Plan;
            switch (action)
            {
                case DiagramActions.Scan:
                    r.Views.Add(new CheckLine("e_sld MDB", "14 nodes, 13 edges", "Info"));
                    r.Views.Add(new CheckLine("Gaps", "3: circuits with no cable", "Warn"));
                    r.Message = "Scanned: 1 diagram, 3 gaps. Read-only, nothing changed.";
                    break;
                case DiagramActions.Plan:
                case DiagramActions.Generate:
                    r.Views.Add(new CheckLine("E-SLD-MDB", "84 symbols, 120 lines, 96 texts · 3 TBC", plan ? "Would create" : "Created"));
                    r.Views.Add(new CheckLine("E-Power-Riser", "6 symbols, 14 lines, 18 texts", plan ? "Would create" : "Created"));
                    r.Sheets.Add(new CheckLine("E-0003 Single-Line Diagram & Load Summary", "E-SLD-MDB", plan ? "Would place" : "Placed"));
                    r.Sheets.Add(new CheckLine("E-6002 Riser Diagram", "E-Power-Riser", plan ? "Would place" : "Placed"));
                    r.KitRequests.Add("No Sheet Register row holds the m_controls diagram: add one");
                    r.Message = plan ? "Dry run: 2 views on 2 sheets would be made; nothing changed." : "2 views drawn and placed on 2 sheets. One Undo each; not saved.";
                    break;
                default:
                    r.Verdict = "Warn";
                    r.Lines.Add(new CheckLine("Items in the model are on the drawing", "Every item the scan finds is drawn", "Pass"));
                    r.Lines.Add(new CheckLine("TBC values", "3 texts with TBC on the drawings", "Warn"));
                    r.Message = "Gate D: Warn. Read-only, nothing changed.";
                    break;
            }
            return Task.FromResult(r);
        }

        public Task<SystemsCheck> StructuralAsync(string kitFolder, string projectFolder, bool save)
        {
            Ran.Add("structural" + (save ? " save" : ""));
            var c = new SystemsCheck { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-S-0001", Members = "48 columns, 166 beams, 32 foundations", Message = "214 members checked.",
                Saved = save ? projectFolder + @"\06_QA\Systems\FMC_Structural_Check.md" : "" };
            c.Checks.Add(new CheckLine("Members not joined at nodes", "3", "Warn"));
            c.Checks.Add(new CheckLine("Columns with nothing below (footing, beam, slab, wall or column)", "1", "Fail"));
            c.Checks.Add(new CheckLine("Physical and analytical out by more than 50 mm", "0", "Pass"));
            c.Checks.Add(new CheckLine("Members missing FMC_Concrete_Grade", "12", "Warn"));
            c.Checks.Add(new CheckLine("Load cases and combinations", "None yet", "Engineer"));
            c.Results.Add(new ResultLine { Mark = "B-1-07", Type = "230x450", Utilisation = 1.12, Run = "FEA-03" });
            c.Results.Add(new ResultLine { Mark = "B-1-12", Type = "230x450", Utilisation = 0.94, Run = "FEA-03" });
            return Task.FromResult(c);
        }
    }
}
