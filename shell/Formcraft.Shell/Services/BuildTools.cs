using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class BoqLine
    {
        public string Code { get; set; } = "";
        public string Description { get; set; } = "";
        public string Unit { get; set; } = "";
        public string Bill { get; set; } = "";
        public string Package { get; set; } = "";
        public int Count { get; set; }
        /// <summary>Null when the model can't measure the unit (the QS measures it).</summary>
        public double? Qty { get; set; }
        public double? Previous { get; set; }
        public bool Changed { get; set; }
    }

    public sealed class BillLine
    {
        public BillLine(string bill, string package, int items, int changed, int unmeasured) { Bill = bill; Package = package; Items = items; Changed = changed; Unmeasured = unmeasured; }
        public string Bill { get; }
        public string Package { get; }
        public int Items { get; }
        public int Changed { get; }
        public int Unmeasured { get; }
    }

    /// <summary>Quantities from the model joined to the kit's codes (fmc_build quantities). Never rates.</summary>
    public sealed class BuildQuantities
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public int Elements { get; set; }
        public string Baseline { get; set; } = "";
        public List<BillLine> Bills { get; } = new List<BillLine>();
        public List<BoqLine> Items { get; } = new List<BoqLine>();
        public List<(string Category, int Count)> Unmapped { get; } = new List<(string, int)>();
        public List<(string Code, int Count)> UnknownCodes { get; } = new List<(string, int)>();
        public List<(string Value, int Count)> Progress { get; } = new List<(string, int)>();
        public List<(string Value, int Count)> Packages { get; } = new List<(string, int)>();
        /// <summary>Kit parameters the model doesn't have yet (loaded with the kit's shared parameters).</summary>
        public List<string> MissingParams { get; } = new List<string>();
    }

    /// <summary>Build (U26): fmc_build through the server, and the view colours in Revit.</summary>
    public interface IBuildTools
    {
        Task<BuildQuantities> MeasureAsync(string kitFolder, string projectFolder);
        Task<ToolResult> BaselineAsync(string kitFolder, string projectFolder);
        /// <summary>Colour the active view by Progress or Package, or "Nothing" to take Build's colours off. Asks first in Revit.</summary>
        void ColourView(string mode);
    }

    /// <summary>Sample values from boards build/PaneBuild and B_Workspace.</summary>
    public sealed class MockBuildTools : IBuildTools
    {
        public List<string> Ran { get; } = new List<string>();

        public Task<BuildQuantities> MeasureAsync(string kitFolder, string projectFolder)
        {
            Ran.Add("measure");
            var q = new BuildQuantities { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-A-0001", Elements = 3749, Baseline = "13 Oct 10:40", Message = "3 bills, 3 items, 1 changed since the baseline." };
            q.Items.Add(new BoqLine { Code = "B.200_00", Description = "200 mm solid precast concrete blockwork", Unit = "m2", Bill = "B.200", Package = "PKG-03-MASONRY", Count = 48, Qty = 1240.5, Previous = 1240.5 });
            q.Items.Add(new BoqLine { Code = "C.COL_01", Description = "RC column C25/30", Unit = "m3", Bill = "C.COL", Package = "PKG-02-CONCRETE", Count = 61, Qty = 38.4, Previous = 36.1, Changed = true });
            q.Items.Add(new BoqLine { Code = "J.HRD_01", Description = "Door ironmongery set", Unit = "set", Bill = "J.HRD", Package = "PKG-06-DOORS-JOINERY", Count = 112, Qty = null });
            q.Bills.Add(new BillLine("B.200", "PKG-03-MASONRY", 1, 0, 0));
            q.Bills.Add(new BillLine("C.COL", "PKG-02-CONCRETE", 1, 1, 0));
            q.Bills.Add(new BillLine("J.HRD", "PKG-06-DOORS-JOINERY", 1, 0, 1));
            q.Unmapped.Add(("Furniture", 14));
            q.Progress.AddRange(new[] { ("Done", 1204), ("In progress", 386), ("Late", 41), ("Not started", 2118) });
            q.Packages.AddRange(new[] { ("PKG-02-CONCRETE", 640), ("PKG-03-MASONRY", 410) });
            return Task.FromResult(q);
        }

        public Task<ToolResult> BaselineAsync(string kitFolder, string projectFolder)
        {
            Ran.Add("baseline");
            var r = new ToolResult { Ok = true };
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Baseline saved: later measures flag every quantity that moves from it."));
            return Task.FromResult(r);
        }

        public void ColourView(string mode) => Ran.Add("colour " + mode);
    }
}
