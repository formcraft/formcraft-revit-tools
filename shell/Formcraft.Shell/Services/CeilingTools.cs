using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>
    /// The room and brief for the Ceiling Design Assistant (fmc_ceiling's room, fixtures and brief). Typed in the pane until
    /// CL2 reads the room from the model. Empty values are left out, so the engine's own rules apply, never the pane's.
    /// </summary>
    public sealed class CeilingRequest
    {
        public string Room { get; set; } = "";
        public double WidthMm { get; set; }
        public double DepthMm { get; set; }
        /// <summary>Underside of the truss ties or slab above, from the floor.</summary>
        public double StructureHeightMm { get; set; }
        /// <summary>ties or slab.</summary>
        public string Structure { get; set; } = "ties";
        public double? TieSpacingMm { get; set; }
        /// <summary>The engine's styles: flat, tray, bulkhead, cove, raft, coffer, cornice.</summary>
        public List<string> Styles { get; } = new List<string>();
        /// <summary>The ceiling build-up as a kit keynote (I.CLG_…); empty: the engine's default.</summary>
        public string Board { get; set; } = "";
        public double? BulkheadWidthMm { get; set; }
        public double? BulkheadDropMm { get; set; }
        public double? RaftDropMm { get; set; }
        public double? CofferDropMm { get; set; }
        /// <summary>A fan hangs in the middle of the room.</summary>
        public bool FanAtCentre { get; set; }
        /// <summary>A JSON file with fmc_ceiling fixtures (downlights, detectors, AC grilles, hatch, sprinklers, fan).</summary>
        public string FixturesFile { get; set; } = "";
    }

    public sealed class CeilingOption
    {
        public string Id { get; set; } = "";
        /// <summary>tray, raft, coffer or flat.</summary>
        public string Kind { get; set; } = "";
        public string Label { get; set; } = "";
        public bool Recommended { get; set; }
        public List<int> Heights { get; } = new List<int>();
        public double BoardM2 { get; set; }
        public int Sheets { get; set; }
        public int Lux { get; set; }
        public int Fail { get; set; }
        public int Decide { get; set; }
        public int Engineer { get; set; }
        public int OkCount { get; set; }
        public List<string> Flags { get; } = new List<string>();
        public string Why { get; set; } = "";
        public string HeightsText => string.Join(" / ", Heights);
        public string ChecksText => Fail > 0 ? Fail + " to fix" : Decide > 0 ? Decide + " to decide" : "OK" + (Engineer > 0 ? " · " + Engineer + " for the engineer" : "");
    }

    public sealed class CeilingDesigns
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public List<CeilingOption> Options { get; } = new List<CeilingOption>();
        public List<string> Skipped { get; } = new List<string>();
        public string Note { get; set; } = "";
        public List<string> KitRequests { get; } = new List<string>();
        public List<string> KitProblems { get; } = new List<string>();
    }

    public sealed class CeilingCheck
    {
        public CeilingCheck(string id, string check, string result, string detail) { Id = id; Check = check; Result = result; Detail = detail; }
        public string Id { get; }
        public string Check { get; }
        /// <summary>Fail, Decide, Engineer, Info, OK or N/A. They flag; the person decides.</summary>
        public string Result { get; }
        public string Detail { get; }
    }

    public sealed class CeilingBoqLine
    {
        public string Item { get; set; } = "";
        public double Qty { get; set; }
        public string Unit { get; set; } = "";
        public string Keynote { get; set; } = "";
        public string Rate { get; set; } = "";
        public string PriceStatus { get; set; } = "";
        public long? TotalUgx { get; set; }
        public string Note { get; set; } = "";
    }

    public sealed class CeilingZone
    {
        public CeilingZone(string zone, int heightMm, double areaM2, int boards, string first, string last, int slivers)
        {
            Zone = zone; HeightMm = heightMm; AreaM2 = areaM2; Boards = boards; First = first; Last = last; Slivers = slivers;
        }
        public string Zone { get; }
        public int HeightMm { get; }
        public double AreaM2 { get; }
        public int Boards { get; }
        public string First { get; }
        public string Last { get; }
        public int Slivers { get; }
    }

    /// <summary>One design checked, set out, measured and priced (fmc_ceiling checks, setout, quantities, boq).</summary>
    public sealed class CeilingEvaluation
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Label { get; set; } = "";
        public List<int> Heights { get; } = new List<int>();
        public List<CeilingCheck> Checks { get; } = new List<CeilingCheck>();
        public List<CeilingZone> Zones { get; } = new List<CeilingZone>();
        public double FaceM2 { get; set; }
        public double BoardM2 { get; set; }
        public int Sheets { get; set; }
        public string Sheet { get; set; } = "";
        public double MainM { get; set; }
        public double FurringM { get; set; }
        public int Hangers { get; set; }
        public double CorniceM { get; set; }
        public double CoveLedM { get; set; }
        public double JointTapeM { get; set; }
        public double PaintM2 { get; set; }
        public int Downlights { get; set; }
        public int Screws { get; set; }
        public int Lux { get; set; }
        public List<CeilingBoqLine> Boq { get; } = new List<CeilingBoqLine>();
        public long PricedTotalUgx { get; set; }
        public int PriceNeeded { get; set; }
        public List<string> KitRequests { get; } = new List<string>();
        public double ChannelsM => System.Math.Round(MainM + FurringM, 1);
    }

    public sealed class CeilingPack
    {
        public bool Ok { get; set; }
        public bool Done { get; set; }
        public string Folder { get; set; } = "";
        public List<string> Files { get; } = new List<string>();
        public List<ToolMessage> Messages { get; } = new List<ToolMessage>();
    }

    /// <summary>
    /// Engineer › Ceilings (CL3): fmc_ceiling through the server. Pure computation; the pack writes CSVs into the project's
    /// 01_WIP after a dry run and a person's yes. Placing ceilings and fixtures in Revit is CL2 (behind the live-model lock).
    /// </summary>
    public interface ICeilingTools
    {
        Task<CeilingDesigns> DesignsAsync(CeilingRequest request);
        Task<CeilingEvaluation> EvaluateAsync(CeilingRequest request, string design);
        Task<CeilingPack> PackAsync(CeilingRequest request, string design, string projectFolder, bool dryRun);

        /// <summary>True once the add-in can place ceilings (CL2). Until then the pane's Place button stays disabled.</summary>
        bool CanPlace { get; }
        Task<ToolResult> PlaceAsync(CeilingRequest request, string design, bool dryRun);

        /// <summary>The preview's sample room (the boards' living room); null in Revit, where the person gives the room.</summary>
        CeilingRequest? Sample { get; }
    }

    /// <summary>
    /// The boards' living room (CL_Pane, CL_Pack): 6.0 × 4.5 m under truss ties at 3000, tray with a 600 bulkhead dropped
    /// 300, cove and cornice. Every number is what fmc_ceiling computes for it (its golden test), with the kit's library.
    /// </summary>
    public sealed class MockCeilingTools : ICeilingTools
    {
        public List<string> Ran { get; } = new List<string>();
        public CeilingRequest? LastRequest { get; private set; }
        public bool CanPlace => false;

        public CeilingRequest? Sample
        {
            get
            {
                var r = new CeilingRequest { Room = "L-01 Living", WidthMm = 6000, DepthMm = 4500, StructureHeightMm = 3000, Structure = "ties", FanAtCentre = true,
                                             FixturesFile = @"server\src\fmc\ceiling\golden fixtures (sample)" };
                r.Styles.AddRange(new[] { "tray", "cove", "cornice" });
                return r;
            }
        }

        public Task<CeilingDesigns> DesignsAsync(CeilingRequest request)
        {
            LastRequest = request;
            Ran.Add("designs");
            var d = new CeilingDesigns { Ok = true, Message = "3 designs for L-01 Living.",
                Note = "Light levels are indicative (lumen method, CA-E-03); the electrical engineer confirms the lighting design." };
            var a = new CeilingOption { Id = "A", Kind = "tray", Label = "Tray with 600 bulkhead and cove", Recommended = true, BoardM2 = 31.86, Sheets = 13, Lux = 258, Engineer = 1, OkCount = 5,
                Why = "The bulkhead hides AC grilles and ducts; the cove gives soft light; a fan hangs in the middle of the tray." };
            a.Heights.AddRange(new[] { 2850, 2550 });
            var b = new CeilingOption { Id = "B", Kind = "raft", Label = "Flat with a floating raft", BoardM2 = 28.53, Sheets = 11, Lux = 186, Decide = 2, Engineer = 1, OkCount = 3,
                Why = "Lightest build; the raft (3000 × 2100) marks the seating with a cove round it; AC ducts need a separate box-out." };
            b.Heights.AddRange(new[] { 2850, 2700 });
            b.Flags.Add("AC supply in the ceiling: Grille 600 × 160 in the ceiling: the duct (150 high) has 0 mm, so it shows: box it out or move it into a bulkhead");
            b.Flags.Add("Detector placement: smoke at (1500, 2250): 0 mm from a ceiling step (cove)");
            var c = new CeilingOption { Id = "C", Kind = "coffer", Label = "Coffered 3 × 2", BoardM2 = 34.7, Sheets = 14, Lux = 64, Fail = 1, Decide = 1, Engineer = 1, OkCount = 3,
                Why = "Most formal; the coffer grid sets where the fan and lights can hang." };
            c.Heights.AddRange(new[] { 2850, 2650 });
            c.Flags.Add("Fan position, sweep and height: Fan off-centre: it falls on the coffer grid (a beam), so it can't hang centred in a coffer; move the grid or the fan; blades about 2.30 m above the floor; no downlight within the sweep; the blades reach within 125 mm of a wall or ceiling step (sweep 1200)");
            c.Flags.Add("Detector placement: smoke at (1500, 2250): at 2650, below the highest ceiling (2850): smoke gathers there, 125 mm from a ceiling step");
            d.Options.AddRange(new[] { a, b, c });
            d.KitRequests.AddRange(StandardRequests);
            return Task.FromResult(d);
        }

        private static readonly string[] StandardRequests =
        {
            @"03_Master_Data\FMC_Ceiling_Standard.json (proposed): set main_channel_cc_mm = 1200, furring_cc_mm = 450, hanger_grid_mm = 1200, min_void_mm = 150, min_board_piece_mm = 300, end_joint_stagger_mm = 1200, board_waste = 0.1, screws_per_m2 = 25, joint_tape_factor = 0.55, hanger_tie_tolerance_mm = 50, fan_min_blade_height_mm = 2300, fan_centre_tolerance_mm = 150, detector_wall_clearance_mm = 500, detector_grille_clearance_mm = 1000, lumens_per_downlight = 800, cove_lumens_per_m = 900, utilisation_factor = 0.45, maintenance_factor = 0.8; the engine uses these reference values until the kit has them",
            @"03_Master_Data\FMC_Ceiling_Standard.json (proposed): minimum ceiling height per room use (min_ceiling_height_mm); headroom isn't checked until it is set",
        };

        public Task<CeilingEvaluation> EvaluateAsync(CeilingRequest request, string design)
        {
            LastRequest = request;
            Ran.Add("evaluate " + design);
            if (design != "tray")
                return Task.FromResult(new CeilingEvaluation { Kind = design, Message = "The preview's sample has the full answer for design A (tray) only; in Revit fmc_ceiling computes every design." });
            return Task.FromResult(Tray());
        }

        public Task<CeilingPack> PackAsync(CeilingRequest request, string design, string projectFolder, bool dryRun)
        {
            Ran.Add(dryRun ? "pack dry run" : "pack");
            var folder = projectFolder + @"\01_WIP\_Ceilings\2026-10-15_L-01-Living_" + design;
            var p = new CeilingPack { Ok = true, Done = !dryRun, Folder = folder };
            p.Files.Add("FMC_Ceiling_L-01-Living_" + design + "_SetOut.csv (67 rows)");
            p.Files.Add("FMC_Ceiling_L-01-Living_" + design + "_BoQ.csv (11 rows)");
            p.Files.Add("FMC_Ceiling_L-01-Living_" + design + "_Checks.csv (10 rows)");
            p.Messages.Add(new ToolMessage(dryRun ? ChipKind.Info : ChipKind.Good,
                dryRun ? "Dry run: 3 files would be written to " + folder + "." : "Ceiling pack written: 3 files in " + folder + ". Logged."));
            return Task.FromResult(p);
        }

        public Task<ToolResult> PlaceAsync(CeilingRequest request, string design, bool dryRun)
        {
            Ran.Add("place");
            return Task.FromResult(ToolResult.Refused("Placing ceilings in Revit comes with CL2."));
        }

        /// <summary>fmc_ceiling's golden answer for the tray design (checks, quantities, set-out and BoQ).</summary>
        public static CeilingEvaluation Tray()
        {
            var e = new CeilingEvaluation
            {
                Ok = true, Kind = "tray", Label = "Tray with 600 bulkhead and cove", Message = "Tray with 600 bulkhead and cove: 0 to fix, 0 to decide.",
                FaceM2 = 4.86, BoardM2 = 31.86, Sheets = 13, Sheet = "2400 × 1200", MainM = 30, FurringM = 99.9, Hangers = 30, CorniceM = 21, CoveLedM = 16.2,
                JointTapeM = 21.9, PaintM2 = 31.9, Downlights = 6, Screws = 796, Lux = 258, PricedTotalUgx = 364000, PriceNeeded = 9,
            };
            e.Heights.AddRange(new[] { 2850, 2550 });
            e.Checks.AddRange(new[]
            {
                new CeilingCheck("clearance", "Clearance to the truss ties", "OK", "Highest ceiling at 2850, truss ties at 3000: 150 mm for mains and hangers"),
                new CeilingCheck("hangers", "Hangers fix to the ties", "Info", "30 hangers on a 1200 grid; tie positions not given: check each lands on a tie or add noggins"),
                new CeilingCheck("ac", "AC supply in the ceiling", "OK", "Grille 600 × 160 in the bulkhead; duct 150 high fits the 300 mm below the framing zone"),
                new CeilingCheck("fan", "Fan position, sweep and height", "OK", "Centred in the tray; blades about 2.50 m above the floor; no downlight within the sweep"),
                new CeilingCheck("detectors", "Detector placement", "OK", "smoke at (1500, 2250): at the highest ceiling, clear of walls, steps and the cove, the fan airflow and AC grilles"),
                new CeilingCheck("access", "Access to drivers", "Info", "Cove LED drivers, downlight drivers and the fan box reachable from the 600 hatch at (5100, 2250)"),
                new CeilingCheck("light", "Light level", "Engineer", "About 258 lx average (indicative lumen method: 6 downlights × 800 lm + 16.2 m cove × 900 lm/m, UF 0.45, MF 0.8): the electrical engineer designs the lighting and confirms (CA-E-03)"),
                new CeilingCheck("joints", "Board joints", "OK", "Long edges across the furring; end joints staggered 1200; no sliver under 300"),
                new CeilingCheck("sprinklers", "Sprinklers", "N/A", "None in this room"),
                new CeilingCheck("headroom", "Headroom", "Info", "Lowest ceiling 2550; the kit has no minimum ceiling height per room use yet (kit change request)"),
            });
            e.Zones.Add(new CeilingZone("field", 2850, 15.84, 7, "F1", "F7", 0));
            e.Zones.Add(new CeilingZone("bulkhead", 2550, 11.16, 10, "B1", "B10", 0));
            void Line(string item, double qty, string unit, string keynote, string rate = "", string status = "price needed", long? total = null, string note = "") =>
                e.Boq.Add(new CeilingBoqLine { Item = item, Qty = qty, Unit = unit, Keynote = keynote, Rate = rate, PriceStatus = status, TotalUgx = total, Note = note });
            Line("9 mm gypsum ceiling board on metal furring, 2400 × 1200 (31.86 m² + 10 % waste)", 13, "board", "I.CLG_02", "28,000", "secondary", 364000);
            Line("Main channels at 1200", 30, "m", "missing");
            Line("Furring channels at 450 (+ studs and rails at the steps)", 99.9, "m", "missing");
            Line("Hangers with fixings, 1200 grid", 30, "no", "missing");
            Line("Drywall screws", 796, "no", "missing");
            Line("Joint tape and filler", 21.9, "m", "missing");
            Line("Cornice", 21, "m", "I.MLD_00");
            Line("Cove LED strip and channel", 16.2, "m", "missing", note: "the electrical engineer specifies it");
            Line("Downlights", 6, "no", "", note: "by the electrical engineer (rule 5): type, driver and price from the lighting design");
            Line("Access hatch 600 × 600", 1, "no", "missing");
            Line("Skim and emulsion, 2 coats", 31.9, "m2", "I.PNT_00", note: "choose the material (FMC_Paint_Emulsion_Vinyl_Generic, FMC_Paint_Plascon_VinylSilk)");
            e.KitRequests.AddRange(StandardRequests);
            foreach (var item in new[] { "Main channels at 1200", "Furring channels at 450 (+ studs and rails at the steps)", "Hangers with fixings, 1200 grid", "Drywall screws",
                                         "Joint tape and filler", "Cove LED strip and channel", "Access hatch 600 × 600" })
                e.KitRequests.Add("Keynote for \"" + item + "\": none in the kit's FMC_Keynotes.txt");
            return e;
        }
    }
}
