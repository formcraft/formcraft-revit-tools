using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>A recipe-tree node that holds variants (docs/PLAN_OPTIONS.md, O0).</summary>
    public sealed class OptionNode
    {
        public OptionNode(string id, string name, string kind, string active, int variants) { Id = id; Name = name; Kind = kind; Active = active; Variants = variants; }
        public string Id { get; }
        public string Name { get; }
        public string Kind { get; }
        /// <summary>The active variant's id, "base" for the node as it is.</summary>
        public string Active { get; }
        public int Variants { get; }
        /// <summary>What the node picker shows: "ICU-01 · ICU bed bay (2 variants)".</summary>
        public string Shown => Id + (Name.Length > 0 && Name != Id ? " · " + Name : "") + " (" + Variants + (Variants == 1 ? " variant)" : " variants)");
    }

    /// <summary>One option measured from its recipes (server/src/tree/options.ts Measures).</summary>
    public sealed class OptionMeasures
    {
        public string Variant { get; set; } = "";
        public string Name { get; set; } = "";
        public int Rooms { get; set; }
        public double AreaM2 { get; set; }
        public double TargetM2 { get; set; }
        /// <summary>Rooms more than 10% off the brief, one line each.</summary>
        public List<string> OffTarget { get; set; } = new List<string>();
        public double WallsM2 { get; set; }
        public double CeilingsM2 { get; set; }
        public int Doors { get; set; }
        public int Windows { get; set; }
        public double? GlazingM2 { get; set; }
        /// <summary>Glazing over floor area: a proxy, never a simulation. Null when a window's height isn't in the recipe.</summary>
        public double? DaylightPct { get; set; }
        public string DaylightNote { get; set; } = "";
        /// <summary>"Family : type" and how many.</summary>
        public Dictionary<string, int> Families { get; set; } = new Dictionary<string, int>();
        /// <summary>Each room's own checks that fail.</summary>
        public List<string> Problems { get; set; } = new List<string>();
    }

    /// <summary>fmc_tree options op=compare: the node as it is and each variant, in the server's order, and what differs.</summary>
    public sealed class OptionsComparison
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Node { get; set; } = "";
        public string Active { get; set; } = "base";
        public List<OptionMeasures> Options { get; set; } = new List<OptionMeasures>();
        /// <summary>The measures that aren't the same for every option: rooms, area_m2, walls_m2, ceilings_m2, doors, windows, glazing_m2, daylight_pct, families.</summary>
        public List<string> Differs { get; set; } = new List<string>();
    }

    /// <summary>Engineer › Options: fmc_tree options through the server. Nothing here ranks or chooses; a person does.</summary>
    public interface IOptionsTools
    {
        /// <summary>The tree's nodes that hold variants (read from 01_WIP\_Tree\FMC_Recipe_Tree.json).</summary>
        Task<(bool Ok, string Message, List<OptionNode> Nodes)> NodesAsync(string projectFolder);
        /// <summary>Every option measured from the recipes, without Revit (a dry run: nothing is written).</summary>
        Task<OptionsComparison> CompareAsync(string projectFolder, string node);
        /// <summary>Make a variant the tree's active one ("" or "base": the node as it is). The dry run lists what would rebuild.</summary>
        Task<ToolResult> ActivateAsync(string projectFolder, string node, string variant, bool dryRun);
        /// <summary>A person chose: the variant becomes the node, the node as it was is kept as a variant (O4).</summary>
        Task<ToolResult> ChooseAsync(string projectFolder, string node, string variant, string by, bool dryRun);
        /// <summary>The comparison kept in 01_WIP\_Options\&lt;node&gt;\&lt;time&gt;: a sheet, a CSV and Plan_&lt;variant&gt;.svg per option.</summary>
        Task<(bool Ok, string Message, string Folder)> SaveAsync(string projectFolder, string node);
    }

    /// <summary>Sample values: the ICU bay at 4200 wide, 4500 wide and 5500 deep. Keeps its own tree in memory.</summary>
    public sealed class MockOptionsTools : IOptionsTools
    {
        private static Dictionary<string, int> IcuFamilies() => new Dictionary<string, int>
        {
            ["FMC_Door_Single : 1200 leaf and a half"] = 1,
            ["FMC_Window_Fixed : 2400 x 1500"] = 1,
            ["FMC_Bed_ICU : Standard"] = 1,
            ["FMC_Pendant_ICU : Twin arm"] = 1,
            ["FMC_Bedhead_Trunking : 3 m"] = 1,
        };

        private const string NoProxy = "a window's height isn't in the recipe: no proxy";

        public List<OptionMeasures> Options { get; } = new List<OptionMeasures>
        {
            new OptionMeasures { Variant = "base", Name = "ICU bed bay", Rooms = 1, AreaM2 = 21, TargetM2 = 21, WallsM2 = 49.68, CeilingsM2 = 21, Doors = 1, Windows = 1,
                GlazingM2 = null, DaylightPct = null, DaylightNote = NoProxy, Families = IcuFamilies() },
            new OptionMeasures { Variant = "wide", Name = "4.5 m bays", Rooms = 1, AreaM2 = 22.5, TargetM2 = 21, WallsM2 = 51.3, CeilingsM2 = 22.5, Doors = 1, Windows = 1,
                GlazingM2 = null, DaylightPct = null, DaylightNote = NoProxy, Families = IcuFamilies() },
            new OptionMeasures { Variant = "deep", Name = "5.5 m deep", Rooms = 1, AreaM2 = 23.1, TargetM2 = 21, WallsM2 = 52.38, CeilingsM2 = 23.1, Doors = 1, Windows = 1,
                GlazingM2 = null, DaylightPct = null, DaylightNote = NoProxy, Families = IcuFamilies(),
                Problems = new List<string> { "ICU-01: the pendant's reach (1800) doesn't cover the foot of the bed at 5500 deep" } },
        };

        public string Active { get; private set; } = "base";
        public string? ChosenBy { get; private set; }
        public List<(string Op, string Variant, bool Dry)> Calls { get; } = new List<(string, string, bool)>();

        public Task<(bool Ok, string Message, List<OptionNode> Nodes)> NodesAsync(string projectFolder) =>
            Task.FromResult((true, "1 node with options.", new List<OptionNode> { new OptionNode("ICU-01", "ICU bed bay", "room", Active, Options.Count - 1) }));

        public Task<OptionsComparison> CompareAsync(string projectFolder, string node)
        {
            Calls.Add(("compare", "", true));
            return Task.FromResult(new OptionsComparison
            {
                Ok = true, Message = Options.Count + " options of " + node + ".", Node = node, Active = Active, Options = Options.ToList(),
                Differs = new List<string> { "area_m2", "walls_m2", "ceilings_m2" },
            });
        }

        private static readonly string[] Rebuilds = { "L1/ICU/ICU-01 (fmc_room)", "L1/ICU/ICU-01/ceiling (fmc_ceiling)" };

        public Task<ToolResult> ActivateAsync(string projectFolder, string node, string variant, bool dryRun)
        {
            var v = variant.Length == 0 ? "base" : variant;
            Calls.Add(("activate", v, dryRun));
            var r = new ToolResult { Ok = true };
            if (dryRun)
            {
                var lines = v == Active ? new string[0] : Rebuilds;
                r.Count = lines.Length;
                r.Details.AddRange(lines);
                return Task.FromResult(r);
            }
            Active = v;
            r.Messages.Add(new ToolMessage(ChipKind.Good, $"{v} is the active option of {node}. {Rebuilds.Length} to rebuild: fmc_tree plan, then build (dry run first)."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> ChooseAsync(string projectFolder, string node, string variant, string by, bool dryRun)
        {
            Calls.Add(("choose", variant, dryRun));
            if (by.Trim().Length == 0) return Task.FromResult(ToolResult.Refused("Say who chose (by): choosing an option is a person's decision"));
            var r = new ToolResult { Ok = true };
            if (dryRun) { r.Count = Rebuilds.Length; r.Details.AddRange(Rebuilds); return Task.FromResult(r); }
            ChosenBy = by;
            Active = "base";
            r.Messages.Add(new ToolMessage(ChipKind.Good, $"{variant} is now {node}, chosen by {by}. The node as it was is kept as a variant."));
            r.Messages.Add(new ToolMessage(ChipKind.Warn, "If the options were built into Revit design options, accepting the primary there is a person's step (it deletes the others)."));
            return Task.FromResult(r);
        }

        public Task<(bool Ok, string Message, string Folder)> SaveAsync(string projectFolder, string node)
        {
            Calls.Add(("save", "", false));
            var folder = projectFolder + @"\01_WIP\_Options\" + node + @"\2026-10-19-10-00-00";
            return Task.FromResult((true, $"Comparison saved: a sheet, a CSV and {Options.Count} plan sketches.", folder));
        }
    }
}
