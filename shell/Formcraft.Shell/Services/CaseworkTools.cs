using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One unit of a casework layout (fmc_casework units): a cabinet, or a gap for an appliance or hood.</summary>
    public sealed class CaseworkUnit
    {
        public string Mark { get; set; } = "";
        /// <summary>corner, base, sink, tall, wall or gap.</summary>
        public string Kind { get; set; } = "";
        public int Width { get; set; }
        public string Wall { get; set; } = "";
        public int Offset { get; set; }
        /// <summary>door, 2door, &lt;n&gt;drawer or none; for a gap, what stands there (cooker, fridge, hood…).</summary>
        public string Fronts { get; set; } = "";
        public string Layer { get; set; } = "base";

        public bool IsGap => Kind == "gap";
        public CaseworkUnit Copy() => (CaseworkUnit)MemberwiseClone();
    }

    /// <summary>A cut-list row (fmc_casework cutlist): one panel of one assembly mark.</summary>
    public sealed class CaseworkCutRow
    {
        public CaseworkCutRow(string mark, string part, int length, int width, int qty, string board, string edge)
        {
            Mark = mark; Part = part; Length = length; Width = width; Qty = qty; Board = board; Edge = edge;
        }
        public string Mark { get; }
        public string Part { get; }
        public int Length { get; }
        public int Width { get; }
        public int Qty { get; }
        public string Board { get; }
        public string Edge { get; }
    }

    public sealed class CaseworkBoard
    {
        public CaseworkBoard(string material, int sheets, int parts, int yieldPct) { Material = material; Sheets = sheets; Parts = parts; YieldPct = yieldPct; }
        public string Material { get; }
        public int Sheets { get; }
        public int Parts { get; }
        public int YieldPct { get; }
    }

    /// <summary>A cost line priced only from the kit's material library: "price needed" where it has no price, never a guess.</summary>
    public sealed class CaseworkCostLine
    {
        public CaseworkCostLine(string item, string material, string price, string status, string source, string date)
        {
            Item = item; Material = material; Price = price; Status = status; Source = source; Date = date;
        }
        public string Item { get; }
        public string Material { get; }
        public string Price { get; }
        public string Status { get; }
        public string Source { get; }
        public string Date { get; }
        public bool Priced => Price.StartsWith("UGX");
    }

    /// <summary>What to lay out: a run from a file (until CW2 reads the room from the model), or the unit editor's list.</summary>
    public sealed class CaseworkRequest
    {
        /// <summary>A JSON file holding a run (walls, openings, fixed items, modules) and, when the kit has none, the workshop standards.</summary>
        public string RunFile { get; set; } = "";
        /// <summary>What the pack is, e.g. K-01 Kitchen: the file names come from it.</summary>
        public string Label { get; set; } = "";
        /// <summary>Fronts by assembly mark, over the run's defaults (door, 2door, 2drawer…).</summary>
        public Dictionary<string, string> Fronts { get; } = new Dictionary<string, string>();
        /// <summary>The unit editor changed a width: the engine works from this unit list instead of the run.</summary>
        public List<CaseworkUnit>? Units { get; set; }
    }

    /// <summary>A casework layout and everything the engine computes from it (fmc_casework units, summary, cutlist).</summary>
    public sealed class CaseworkLayout
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        /// <summary>Where the workshop standards came from: the kit's file, or the call (the kit has none yet).</summary>
        public string StandardsFrom { get; set; } = "";
        /// <summary>The standards sent with the call, as label and value, to show on the Room step.</summary>
        public List<(string Label, string Value)> Standards { get; } = new List<(string, string)>();
        /// <summary>Refused: the standards that are missing (nothing is filled in, rules 5 and 7).</summary>
        public List<string> Missing { get; } = new List<string>();
        public List<string> Problems { get; } = new List<string>();
        public List<string> Notes { get; } = new List<string>();
        public List<CaseworkUnit> Units { get; } = new List<CaseworkUnit>();
        public List<string> Fillers { get; } = new List<string>();
        public List<string> Worktop { get; } = new List<string>();
        public bool FromUnitList { get; set; }
        public int UnitCount { get; set; }
        public int PartLines { get; set; }
        public int Pieces { get; set; }
        public int Sheets { get; set; }
        public double EdgeM { get; set; }
        public double WorktopM { get; set; }
        public List<CaseworkBoard> Boards { get; } = new List<CaseworkBoard>();
        public List<(string Item, double Qty)> Hardware { get; } = new List<(string, double)>();
        public List<CaseworkCostLine> Cost { get; } = new List<CaseworkCostLine>();
        public long CostLow { get; set; }
        public long CostHigh { get; set; }
        public List<string> KitRequests { get; } = new List<string>();
        public List<CaseworkCutRow> CutList { get; } = new List<CaseworkCutRow>();

        /// <summary>Hardware items counted (pieces, not metres of kick board).</summary>
        public int HardwareItems => (int)Hardware.Where(h => h.Item != "Kick board").Sum(h => h.Qty);
    }

    /// <summary>The workshop pack's dry run or write (fmc_casework pack): CSVs into &lt;project&gt;\01_WIP\_Casework.</summary>
    public sealed class CaseworkPack
    {
        public bool Ok { get; set; }
        public bool Done { get; set; }
        public string Folder { get; set; } = "";
        public List<(string File, int Rows, string Action)> Files { get; } = new List<(string, int, string)>();
        public List<ToolMessage> Messages { get; } = new List<ToolMessage>();
    }

    /// <summary>
    /// Engineer › Casework (CW3): fmc_casework through the server. Pure computation; the pack writes only into the project's
    /// 01_WIP after a dry run. Placing units in Revit is CW2 (fmc_casework place → fmc_casework_place: the dry run is the
    /// real run rolled back, the real run is behind the live-model lock, one Undo takes it out).
    /// </summary>
    public interface ICaseworkTools
    {
        Task<CaseworkLayout> LayOutAsync(CaseworkRequest request);
        Task<CaseworkPack> PackAsync(CaseworkRequest request, string projectFolder, string projectCode, bool dryRun);

        /// <summary>True when the add-in can place units (CW2). When false the pane's Place button stays disabled.</summary>
        bool CanPlace { get; }
        /// <summary>The dry run lists what it placed and rolled back in <see cref="ToolResult.Details"/>; the real run places them.</summary>
        Task<ToolResult> PlaceAsync(CaseworkRequest request, bool dryRun);

        /// <summary>The preview's sample run (the boards' kitchen); null in Revit, where the person picks the run.</summary>
        string? SampleRunFile { get; }
    }

    /// <summary>
    /// The boards' kitchen (CW_Pane, CW_Outputs): every number here is what fmc_casework computes from the engine's own
    /// example (server/src/fmc/fixtures/cw_kitchen.json) with the kit's library as it is on 15 Oct.
    /// </summary>
    public sealed class MockCaseworkTools : ICaseworkTools
    {
        public List<string> Ran { get; } = new List<string>();
        public CaseworkRequest? LastRequest { get; private set; }
        public bool CanPlace => true;
        public string? SampleRunFile => @"server\src\fmc\fixtures\cw_kitchen.json (sample)";

        public Task<CaseworkLayout> LayOutAsync(CaseworkRequest request)
        {
            LastRequest = request;
            Ran.Add(request.Units != null ? "layout units" : "layout run");
            var l = Kitchen();
            // The unit editor's changes come back as the engine would show them on the units; the panel counts stay the
            // sample's (in Revit the engine recomputes everything).
            foreach (var u in l.Units)
            {
                if (request.Fronts.TryGetValue(u.Mark, out var f)) u.Fronts = f;
                var edited = request.Units?.FirstOrDefault(x => x.Mark == u.Mark);
                if (edited != null) { u.Width = edited.Width; u.Fronts = edited.Fronts; }
            }
            if (request.Units != null)
            {
                l.FromUnitList = true;
                l.Notes.Add("A unit list has no walls, so the worktop isn't measured");
                l.WorktopM = 0;
            }
            return Task.FromResult(l);
        }

        public Task<CaseworkPack> PackAsync(CaseworkRequest request, string projectFolder, string projectCode, bool dryRun)
        {
            Ran.Add(dryRun ? "pack dry run" : "pack");
            var stem = projectCode + "_Casework_" + string.Join("-", (request.Label.Length > 0 ? request.Label : "K-01 Kitchen").Split(new[] { ' ', '_' }, System.StringSplitOptions.RemoveEmptyEntries));
            var p = new CaseworkPack { Ok = true, Done = !dryRun, Folder = projectFolder + @"\01_WIP\_Casework" };
            p.Files.Add((stem + "_CutList.csv", 88, "new"));
            p.Files.Add((stem + "_Nesting.csv", 120, "new"));
            p.Files.Add((stem + "_Hardware.csv", 7, "new"));
            p.Files.Add((stem + "_BoQ.csv", 12, "new"));
            p.Files.Add((stem + "_WorkshopPack.pdf", 23, "new"));
            p.Messages.Add(new ToolMessage(dryRun ? ChipKind.Info : ChipKind.Good,
                dryRun ? "Dry run: 5 files would be written to " + p.Folder + "." : "Workshop pack written: 5 files in " + p.Folder + ". Logged."));
            return Task.FromResult(p);
        }

        /// <summary>
        /// What fmc_casework place answers for the boards' kitchen with the kit as it is: the register's
        /// FMC_I_Casework_KitchenUnit has Base, Wall and Tall types only, so the corner and the sink are asked of the kit.
        /// </summary>
        public Task<ToolResult> PlaceAsync(CaseworkRequest request, bool dryRun)
        {
            Ran.Add(dryRun ? "place dry run" : "place");
            var r = new ToolResult { Ok = true, Count = 10 };
            if (dryRun)
            {
                r.Details.AddRange(new[] { "K02 Base 600", "K04 Base 450", "K05 Tall 600", "K06 Base 600", "K08 Base 600", "W01 Wall 600", "W02 Wall 600", "W03 Wall 450", "W04 Wall 600", "W06 Wall 600",
                    "Not placed: K01 (FMC_I_Casework_KitchenUnit has no corner type), K03 (no sink type), K07, K09, W05 (appliance spaces)" });
                r.Messages.Add(new ToolMessage(ChipKind.Info, "Dry run: 10 units placed in Revit and rolled back. Kit change requests: a Corner and a Sink type for FMC_I_Casework_KitchenUnit."));
            }
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "Placed 10 units of FMC_I_Casework_KitchenUnit with their assembly marks. One Undo takes them out. Logged."));
            return Task.FromResult(r);
        }

        public static CaseworkLayout Kitchen()
        {
            var l = new CaseworkLayout
            {
                Ok = true, StandardsFrom = "the call (the kit has none)", Message = "12 units, 120 panels on 15 sheets.",
                UnitCount = 12, PartLines = 88, Pieces = 120, Sheets = 15, EdgeM = 98.5, WorktopM = 4.8, CostLow = 540000, CostHigh = 810000,
            };
            l.Standards.AddRange(new[]
            {
                ("Worktop depth", "600"), ("Base units", "720 high, 560 deep, on 150 legs"), ("Wall units", "720 high, 320 deep"),
                ("Tall units", "2100 high, 560 deep"), ("Carcass board", "FMC_Board_Plywood_Marine18 (18)"), ("Fronts", "FMC_Board_MDF_Raw"),
                ("Backs", "FMC_Board_MDF_Back6"), ("Sheet", "2440 × 1220, kerf 4"),
            });
            l.Notes.Add("Wall B: no wall unit is placed over the cooker; gas and hood clearances are the professional's to confirm (rule 5)");
            l.Notes.Add("1 filler(s) (A base 50): scribed on site from offcuts, not in the cut list");
            foreach (var (mark, kind, width, wall, offset, fronts) in new[]
            {
                ("K01", "corner", 1000, "A", 0, "door"), ("K02", "base", 600, "A", 1000, "3drawer"), ("K03", "sink", 900, "A", 1600, "2door"),
                ("K04", "base", 450, "A", 2500, "door"), ("K05", "tall", 600, "A", 2950, "2door"), ("K06", "base", 600, "B", 600, "door"),
                ("K07", "gap", 600, "B", 1200, "cooker"), ("K08", "base", 600, "B", 1800, "2drawer"), ("K09", "gap", 600, "B", 2400, "fridge"),
                ("W01", "wall", 600, "A", 0, "door"), ("W02", "wall", 600, "A", 600, "door"), ("W03", "wall", 450, "A", 2500, "door"),
                ("W04", "wall", 600, "B", 600, "door"), ("W05", "gap", 600, "B", 1200, "hood"), ("W06", "wall", 600, "B", 1800, "door"),
            })
                l.Units.Add(new CaseworkUnit { Mark = mark, Kind = kind, Width = width, Wall = wall, Offset = offset, Fronts = fronts, Layer = kind == "wall" || fronts == "hood" ? "wall" : "base" });
            l.Fillers.Add("Wall A, base, 50 at 3550");
            l.Worktop.AddRange(new[] { "A 0–2950", "B 0–1200", "B 1800–2400" });
            l.Boards.Add(new CaseworkBoard("FMC_Board_Plywood_Marine18", 9, 86, 76));
            l.Boards.Add(new CaseworkBoard("FMC_Board_MDF_Back6", 3, 17, 84));
            l.Boards.Add(new CaseworkBoard("FMC_Board_MDF_Raw", 3, 17, 66));
            l.Hardware.AddRange(new[] { ("Hinges", 28.0), ("Drawer runners (pairs, 500 mm)", 5.0), ("Handles", 17.0), ("Legs (adjustable 150 mm)", 32.0),
                                        ("Shelf pins", 48.0), ("Wall-unit hangers", 10.0), ("Kick board", 4.8) });
            l.Cost.Add(new CaseworkCostLine("Board · 9 sheets", "FMC_Board_Plywood_Marine18", "UGX 540,000–810,000", "secondary", "https://jiji.ug/building-materials?query=plywood", "2026-10"));
            l.Cost.Add(new CaseworkCostLine("Board · 3 sheets", "FMC_Board_MDF_Back6", "price needed: not in the kit's material library", "", "", ""));
            l.Cost.Add(new CaseworkCostLine("Board · 3 sheets", "FMC_Board_MDF_Raw", "price needed", "", "", ""));
            l.Cost.Add(new CaseworkCostLine("Edge banding · 98.5 m", "", "price needed", "", "", ""));
            l.Cost.Add(new CaseworkCostLine("Worktop · 4.8 m", "FMC_Stone_Granite_Black_Polished", "price needed", "", "", ""));
            foreach (var h in l.Hardware) l.Cost.Add(new CaseworkCostLine(h.Item, "", "price needed", "", "", ""));
            l.KitRequests.Add("FMC_Board_MDF_Back6: Add FMC_Board_MDF_Back6 to 07_Materials\\FMC_Materials.json");
            l.KitRequests.Add("Edge band: Add an edge-band material (e.g. 2 mm ABS or PVC, per metre) to 07_Materials\\FMC_Materials.json");
            l.KitRequests.Add("Hardware: Add a hardware price list (hinges, runners, handles, legs, shelf pins, hangers, kick board) to the kit");
            const string ply = "FMC_Board_Plywood_Marine18", back = "FMC_Board_MDF_Back6", mdf = "FMC_Board_MDF_Raw";
            l.CutList.AddRange(new[]
            {
                new CaseworkCutRow("K01", "Side", 720, 560, 2, ply, "1 long edge"), new CaseworkCutRow("K01", "Bottom", 964, 560, 1, ply, "1 long edge"),
                new CaseworkCutRow("K01", "Top rail", 964, 100, 2, ply, "1 long edge"), new CaseworkCutRow("K01", "Back", 994, 714, 1, back, "—"),
                new CaseworkCutRow("K01", "Shelf", 962, 530, 1, ply, "1 long edge"), new CaseworkCutRow("K01", "Blind panel", 420, 720, 1, ply, "1 long edge"),
                new CaseworkCutRow("K01", "Door", 717, 577, 1, mdf, "4 sides"),
                new CaseworkCutRow("K02", "Side", 720, 560, 2, ply, "1 long edge"), new CaseworkCutRow("K02", "Bottom", 564, 560, 1, ply, "1 long edge"),
                new CaseworkCutRow("K02", "Top rail", 564, 100, 2, ply, "1 long edge"), new CaseworkCutRow("K02", "Back", 594, 714, 1, back, "—"),
                new CaseworkCutRow("K02", "Drawer front 1", 597, 137, 1, mdf, "4 sides"), new CaseworkCutRow("K02", "Drawer side 1", 500, 80, 2, ply, "1 long edge"),
                new CaseworkCutRow("K02", "Drawer back 1", 506, 80, 2, ply, "1 long edge"), new CaseworkCutRow("K02", "Drawer bottom 1", 538, 490, 1, back, "—"),
                new CaseworkCutRow("K02", "Drawer front 2", 597, 284, 1, mdf, "4 sides"), new CaseworkCutRow("K02", "Drawer side 2", 500, 227, 2, ply, "1 long edge"),
                new CaseworkCutRow("K02", "Drawer back 2", 506, 227, 2, ply, "1 long edge"), new CaseworkCutRow("K02", "Drawer bottom 2", 538, 490, 1, back, "—"),
                new CaseworkCutRow("K02", "Drawer front 3", 597, 284, 1, mdf, "4 sides"), new CaseworkCutRow("K02", "Drawer side 3", 500, 227, 2, ply, "1 long edge"),
                new CaseworkCutRow("K02", "Drawer back 3", 506, 227, 2, ply, "1 long edge"), new CaseworkCutRow("K02", "Drawer bottom 3", 538, 490, 1, back, "—"),
            });
            return l;
        }
    }
}
