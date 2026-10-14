using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>A line under a tool: what happened, in plain words, with a chip colour.</summary>
    public sealed class ToolMessage
    {
        public ToolMessage(ChipKind kind, string text) { Kind = kind; Text = text; }
        public ChipKind Kind { get; }
        public string Text { get; }
    }

    /// <summary>One family's state after a plan, dry run, build or load test.</summary>
    public sealed class FamilyLine
    {
        public FamilyLine(string family, string status, ChipKind kind, string meta = "", string tip = "")
        {
            Family = family; Status = status; Kind = kind; Meta = meta; Tip = tip;
        }
        public string Family { get; }
        public string Status { get; }
        public ChipKind Kind { get; }
        public string Meta { get; }
        public string Tip { get; }
    }

    /// <summary>
    /// What a tool run came back with. Every write is run twice: a dry run (<see cref="Details"/> says what would
    /// happen; the pane asks), then the real run (CLAUDE.md rule 3).
    /// </summary>
    public sealed class ToolResult
    {
        public bool Ok { get; set; }
        public List<ToolMessage> Messages { get; } = new List<ToolMessage>();
        public List<FamilyLine> Lines { get; } = new List<FamilyLine>();
        /// <summary>Dry run: what the real run would do, one line each, for the confirm dialog.</summary>
        public List<string> Details { get; } = new List<string>();
        /// <summary>Dry run: how many it would act on (families to build or load).</summary>
        public int Count { get; set; }
        /// <summary>The target exists; replacing it needs a second yes.</summary>
        public bool NeedsOverwrite { get; set; }

        public static ToolResult Refused(string text) { var r = new ToolResult(); r.Messages.Add(new ToolMessage(ChipKind.Bad, text)); return r; }
    }

    /// <summary>One family in the kit's specs (FMC_Family_Specs.json, read by the server).</summary>
    public sealed class FamilySpec
    {
        public FamilySpec(string family, string role, string category, int connectors, int parameters)
        {
            Family = family; Role = role; Category = category; Connectors = connectors; Parameters = parameters;
        }
        public string Family { get; }
        public string Role { get; }
        public string Category { get; }
        public int Connectors { get; }
        public int Parameters { get; }
    }

    public sealed class FamilySpecs
    {
        public FamilySpecs(IReadOnlyList<FamilySpec> families, IReadOnlyList<string> pilot, string error = "")
        {
            Families = families; Pilot = pilot; Error = error;
        }
        public IReadOnlyList<FamilySpec> Families { get; }
        public IReadOnlyList<string> Pilot { get; }
        public string Error { get; }
    }

    /// <summary>
    /// Setup › Families: the family builder (fmc_family through the server, the same code Claude runs). Plan checks
    /// against the kit without Revit; build makes data-shell families in staging; load test checks them in a chain-test file.
    /// </summary>
    public interface IFamilyTools
    {
        /// <summary>Empty when the server can run; otherwise why not (Connect's health check has the fix).</summary>
        string Problem { get; }
        string StagingRoot { get; }
        Task<FamilySpecs> LoadSpecsAsync();
        Task<ToolResult> PlanAsync(IReadOnlyList<string> families);
        Task<ToolResult> BuildAsync(IReadOnlyList<string> families, bool dryRun, bool overwrite, bool oneByOne, Action<string> progress);
        Task<ToolResult> LoadTestAsync(IReadOnlyList<string> families, bool dryRun);
    }

    /// <summary>A document open in Revit, as the guard sees it.</summary>
    public sealed class OpenDocument
    {
        public OpenDocument(string title, string path, bool isFamily, bool isWorkshared, bool isModified, bool isActive, bool live)
        {
            Title = title; Path = path; IsFamily = isFamily; IsWorkshared = isWorkshared; IsModified = isModified; IsActive = isActive; Live = live;
        }
        public string Title { get; }
        public string Path { get; }
        public bool IsFamily { get; }
        public bool IsWorkshared { get; }
        public bool IsModified { get; }
        public bool IsActive { get; }
        /// <summary>A live project: Claude reads it, never models in it.</summary>
        public bool Live { get; }
        public string Reference => string.IsNullOrEmpty(Path) ? Title : Path;
    }

    /// <summary>An fmc_file request: create from template, save as, close, archive.</summary>
    public sealed class FileRequest
    {
        public string Action { get; set; } = "";
        public string Kind { get; set; } = "";
        public string TemplatePath { get; set; } = "";
        public string SavePath { get; set; } = "";
        public string Document { get; set; } = "";
        public string Path { get; set; } = "";
        public bool Save { get; set; }
        public bool CloseAfter { get; set; } = true;
        public bool Overwrite { get; set; }
        /// <summary>create_from_template (project): Project Information to fill in before saving.</summary>
        public Dictionary<string, string> ProjectInfo { get; set; } = new Dictionary<string, string>();
    }

    /// <summary>Setup › Templates: files through fmc_file, with the folder rules the server enforces.</summary>
    public interface IFileTools
    {
        IReadOnlyList<OpenDocument> Documents { get; }
        /// <summary>A folder to start a file dialog in (the first write root that exists).</summary>
        string StartFolder { get; }
        Task<ToolResult> RunAsync(FileRequest request, bool dryRun);
        event EventHandler? Changed;
    }

    /// <summary>File dialogs, so view models stay testable.</summary>
    public interface IFilePicker
    {
        string? Open(string title, string filter, string startFolder);
        string? Save(string title, string filter, string fileName, string startFolder);
        /// <summary>A folder; null when cancelled or when this Windows build has no folder dialog.</summary>
        string? Folder(string title, string startFolder);
    }

    public sealed class WindowsFilePicker : IFilePicker
    {
        public string? Open(string title, string filter, string startFolder)
        {
            var d = new Microsoft.Win32.OpenFileDialog { Title = title, Filter = filter, InitialDirectory = startFolder ?? "" };
            return d.ShowDialog() == true ? d.FileName : null;
        }

        public string? Save(string title, string filter, string fileName, string startFolder)
        {
            // The server refuses to overwrite unless asked twice, so Windows doesn't ask here.
            var d = new Microsoft.Win32.SaveFileDialog { Title = title, Filter = filter, FileName = fileName, InitialDirectory = startFolder ?? "", OverwritePrompt = false };
            return d.ShowDialog() == true ? d.FileName : null;
        }

        public string? Folder(string title, string startFolder)
        {
#if NET8_0_OR_GREATER
            var d = new Microsoft.Win32.OpenFolderDialog { Title = title, InitialDirectory = startFolder ?? "" };
            return d.ShowDialog() == true ? d.FolderName : null;
#else
            // Revit 2020-2024 (.NET Framework) has no WPF folder dialog: type or paste the path instead.
            return null;
#endif
        }
    }

    // ---------- samples for the preview app and tests ----------

    public sealed class MockFamilyTools : IFamilyTools
    {
        public string Problem { get; set; } = "";
        public string StagingRoot => @"Z:\00_Standards\04_Families\_Staging";
        public List<string> Built { get; } = new List<string>();

        public Task<FamilySpecs> LoadSpecsAsync() => Task.FromResult(new FamilySpecs(new[]
        {
            new FamilySpec("FMC_E_ElecFixture_SocketDouble", "E", "Electrical Fixtures", 1, 6),
            new FamilySpec("FMC_E_LightFixture_LEDPanel600", "E", "Lighting Fixtures", 1, 8),
            new FamilySpec("FMC_P_PlumbFixture_WCSuite", "P", "Plumbing Fixtures", 2, 7),
            new FamilySpec("FMC_M_MechEquip_FanCoil", "M", "Mechanical Equipment", 3, 9),
        }, new[] { "FMC_E_ElecFixture_SocketDouble", "FMC_P_PlumbFixture_WCSuite" }));

        public Task<ToolResult> PlanAsync(IReadOnlyList<string> families)
        {
            var r = new ToolResult { Ok = true };
            foreach (var f in families)
                r.Lines.Add(f.Contains("FanCoil") ? new FamilyLine(f, "Problem", ChipKind.Bad, "M · 3 connectors", "No family template for Mechanical Equipment")
                                                  : new FamilyLine(f, "Ready", ChipKind.Info, "1 connector · 6 parameters"));
            r.Messages.Add(new ToolMessage(ChipKind.Good, $"Plan: {r.Lines.Count(l => l.Status == "Ready")} ready to build, {r.Lines.Count(l => l.Kind == ChipKind.Bad)} with problems."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> BuildAsync(IReadOnlyList<string> families, bool dryRun, bool overwrite, bool oneByOne, Action<string> progress)
        {
            var ready = families.Where(f => !f.Contains("FanCoil")).ToList();
            var r = new ToolResult { Ok = true, Count = ready.Count };
            if (dryRun)
            {
                r.Details.AddRange(ready.Select(f => f + " → " + StagingRoot + "\\" + f.Split('_')[1]));
                r.Messages.Add(new ToolMessage(ChipKind.Info, $"Dry run: would build {ready.Count} into {StagingRoot}\\<Role>."));
                return Task.FromResult(r);
            }
            Built.AddRange(ready);
            r.Lines.AddRange(ready.Select(f => new FamilyLine(f, "Built", ChipKind.Good)));
            r.Messages.Add(new ToolMessage(ChipKind.Good, $"Built {ready.Count}. Logged in FMC_MCP_FileLog.csv."));
            return Task.FromResult(r);
        }

        public Task<ToolResult> LoadTestAsync(IReadOnlyList<string> families, bool dryRun)
        {
            var r = new ToolResult { Ok = true, Count = families.Count };
            if (dryRun)
            {
                r.Details.AddRange(families);
                r.Messages.Add(new ToolMessage(ChipKind.Info, $"Dry run: would load and place {families.Count}."));
            }
            else
            {
                r.Lines.AddRange(families.Select(f => new FamilyLine(f, "Load tested", ChipKind.Good)));
                r.Messages.Add(new ToolMessage(ChipKind.Good, $"Load test: {families.Count} of {families.Count} passed."));
            }
            return Task.FromResult(r);
        }
    }

    public sealed class MockFileTools : IFileTools
    {
        public IReadOnlyList<OpenDocument> Documents { get; set; } = new[]
        {
            new OpenDocument("F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", @"Z:\Projects\F26001\01_WIP\A\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", false, true, false, true, true),
            new OpenDocument("FMC_E_ElecFixture_SocketDouble.rfa", @"Z:\00_Standards\04_Families\_Staging\E\FMC_E_ElecFixture_SocketDouble.rfa", true, false, true, false, false),
        };
        public string StartFolder => @"Z:\Projects";
        public List<(FileRequest Request, bool Dry)> Runs { get; } = new List<(FileRequest, bool)>();
        public event EventHandler? Changed;

        public Task<ToolResult> RunAsync(FileRequest request, bool dryRun)
        {
            Runs.Add((request, dryRun));
            var r = new ToolResult { Ok = true };
            if (dryRun) r.Details.Add(request.Action + ": " + (request.SavePath.Length > 0 ? request.SavePath : request.Path.Length > 0 ? request.Path : request.Document));
            else r.Messages.Add(new ToolMessage(ChipKind.Good, request.Action + ": done. Logged in FMC_MCP_FileLog.csv."));
            Changed?.Invoke(this, EventArgs.Empty);
            return Task.FromResult(r);
        }
    }
}
