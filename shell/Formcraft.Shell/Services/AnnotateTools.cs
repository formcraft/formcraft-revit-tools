using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>The kit's annotation standard, as the pane shows it.</summary>
    public sealed class AnnotationStandardInfo
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string File { get; set; } = "";
        public string Version { get; set; } = "";
        public string Source { get; set; } = "";
        public List<(int Pen, double Width, string UsedFor, string Status)> Pens { get; } = new List<(int, double, string, string)>();
        public List<string> LinePatterns { get; } = new List<string>();
        public List<(string Name, string Font, string Size)> TextTypes { get; } = new List<(string, string, string)>();
        public List<(string Name, string Status)> DimensionStyles { get; } = new List<(string, string)>();
        public string TagPattern { get; set; } = "";
        public List<string> Symbols { get; } = new List<string>();
        public List<(string Name, string Hex)> Colours { get; } = new List<(string, string)>();
    }

    public sealed class AnnotationCheckLine
    {
        public AnnotationCheckLine(string check, int found, string state, IReadOnlyList<string> items, IReadOnlyList<long> ids)
        {
            Check = check; Found = found; State = state; Items = items; Ids = ids;
        }
        public string Check { get; }
        public int Found { get; }
        public string State { get; }
        public IReadOnlyList<string> Items { get; }
        public IReadOnlyList<long> Ids { get; }
        public ChipKind Kind => State == "Pass" ? ChipKind.Good : State == "Fail" ? ChipKind.Bad : State == "Proposed" ? ChipKind.Warn : ChipKind.Grey;
    }

    public sealed class MissingTagLine
    {
        public MissingTagLine(string category, int untagged, string tagFamily, IReadOnlyList<long> ids)
        {
            Category = category; Untagged = untagged; TagFamily = tagFamily; Ids = ids;
        }
        public string Category { get; }
        public int Untagged { get; }
        public string TagFamily { get; }
        public IReadOnlyList<long> Ids { get; }
    }

    /// <summary>Drawings › Annotate: fmc_annotate through the server (the kit's standard against the model).</summary>
    public interface IAnnotateTools
    {
        Task<AnnotationStandardInfo> StandardAsync();
        Task<(bool Ok, string Message, List<AnnotationCheckLine> Checks)> CheckAsync();
        Task<(bool Ok, string Message, List<string> Views, List<MissingTagLine> Lines)> MissingTagsAsync(string scope);
        Task<string> RequestAsync(string text);
    }

    /// <summary>Sample values from board manage/PaneAnnotate.</summary>
    public sealed class MockAnnotateTools : IAnnotateTools
    {
        public List<string> Requests { get; } = new List<string>();
        public List<string> Scopes { get; } = new List<string>();

        public Task<AnnotationStandardInfo> StandardAsync()
        {
            var s = new AnnotationStandardInfo { Ok = true, File = @"Z:\00_Standards\03_Master_Data\FMC_Annotation_Standard.json", Version = "1.0",
                Source = "STD 6, MAN 9.14 and the Graphics tab", TagPattern = "FMC_TAG_[Role]_[Subject]" };
            var pens = new (int, double, string)[] { (1, 0.10, "Hatch, hidden"), (2, 0.13, "Fine detail"), (3, 0.18, "Annotation, beyond"), (4, 0.25, "Light cut, projection"),
                                                      (5, 0.35, "Medium cut"), (6, 0.50, "Heavy cut, sheet frame"), (7, 0.70, "Very heavy cut"), (8, 1.00, "Site boundary, ground sections") };
            foreach (var (pen, w, use) in pens) s.Pens.Add((pen, w, use, "standard"));
            s.LinePatterns.AddRange(new[] { "FMC_Dash", "FMC_DashDot", "FMC_DashDotDot", "FMC_Dot", "FMC_CentreLine", "FMC_Boundary" });
            s.TextTypes.AddRange(new[] { ("FMC_Arial_1.8", "Arial", "1.8 mm"), ("FMC_Arial_2.5", "Arial", "2.5 mm"), ("FMC_Arial_3.5", "Arial", "3.5 mm"), ("FMC_Arial_5.0_Bold", "Arial", "5 mm") });
            s.DimensionStyles.Add(("FMC_Linear_2.5", "proposed"));
            s.Colours.AddRange(new[] { ("Formcraft Orange", "#E8742A"), ("Navy", "#1F2A44") });
            return Task.FromResult(s);
        }

        public Task<(bool Ok, string Message, List<AnnotationCheckLine> Checks)> CheckAsync() => Task.FromResult((true, "Checked F26001-FMC-ZZ-ZZ-M3-A-0001.rvt against the standard.", new List<AnnotationCheckLine>
        {
            new AnnotationCheckLine("Text types (the standard's 4 only)", 3, "Fail", new[] { "Generic 2.5", "Title 7", "Note 3" }, new long[] { 1, 2, 3 }),
            new AnnotationCheckLine("Line patterns not FMC_", 2, "Fail", new[] { "Dash 1/8\"", "Hidden" }, new long[] { 10, 11 }),
            new AnnotationCheckLine("Dimension types not FMC_", 4, "Proposed", new[] { "Linear - 2.5mm Arial" }, new long[] { 20 }),
            new AnnotationCheckLine("Tags not FMC_TAG_[Role]_[Subject]", 1, "Fail", new[] { "M_Window Tag" }, new long[] { 30 }),
        }));

        public Task<(bool Ok, string Message, List<string> Views, List<MissingTagLine> Lines)> MissingTagsAsync(string scope)
        {
            Scopes.Add(scope);
            return Task.FromResult((true, "Counted untagged elements in 1 view.", new List<string> { "Level 1 - GA Plan" }, new List<MissingTagLine>
            {
                new MissingTagLine("Doors", 6, "FMC_TAG_A_Door", new long[] { 101, 102, 103, 104, 105, 106 }),
                new MissingTagLine("Windows", 2, "FMC_TAG_A_Window", new long[] { 201, 202 }),
                new MissingTagLine("Rooms", 0, "FMC_TAG_A_Room", new long[0]),
                new MissingTagLine("Electrical fixtures", 14, "FMC_TAG_E_Device", Enumerable.Range(300, 14).Select(i => (long)i).ToList()),
            }));
        }

        public Task<string> RequestAsync(string text)
        {
            Requests.Add(text);
            return Task.FromResult("Change proposed. The BIM Manager approves changes into the standard.");
        }
    }
}
