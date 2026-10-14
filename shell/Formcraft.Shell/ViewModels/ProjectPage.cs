using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>What a project start asks the server for (fmc_project).</summary>
    public sealed class ProjectRequest
    {
        public string Folder { get; set; } = "";
        public string Code { get; set; } = "";
        public string Originator { get; set; } = "FMC";
        public string Volume { get; set; } = "ZZ";
        public string Level { get; set; } = "ZZ";
        public string Type { get; set; } = "M3";
        public List<string> Roles { get; set; } = new List<string>();
        public Dictionary<string, string> Templates { get; set; } = new Dictionary<string, string>();
        public Dictionary<string, string> Details { get; set; } = new Dictionary<string, string>();
        public string Stage { get; set; } = "";
        public string IssueSet { get; set; } = "";
        public string Standard { get; set; } = "";
    }

    /// <summary>Setup › Project: fmc_project through the server (plan, start with a dry run first).</summary>
    public interface IProjectTools
    {
        Task<ToolResult> RunAsync(ProjectRequest request, bool dryRun);
    }

    public sealed class MockProjectTools : IProjectTools
    {
        public List<(ProjectRequest Request, bool Dry)> Runs { get; } = new List<(ProjectRequest, bool)>();

        public Task<ToolResult> RunAsync(ProjectRequest q, bool dryRun)
        {
            Runs.Add((q, dryRun));
            var r = new ToolResult { Ok = true, Count = q.Roles.Count };
            if (dryRun)
            {
                r.Details.Add("Folders: 00_Info · 01_WIP · 02_Shared · 03_Published · 04_Archive · 05_Incoming · 06_QA · 07_Cost");
                r.Details.AddRange(q.Roles.Select(role => $"{q.Code}-{q.Originator}-{q.Volume}-{q.Level}-{q.Type}-{role}-0001.rvt  ←  {Path.GetFileName(q.Templates.TryGetValue(role, out var t) ? t : "")}"));
                r.Details.Add(@"Manifest: 01_WIP\FMC_Project.json");
            }
            else r.Messages.Add(new ToolMessage(ChipKind.Good, $"Started {q.Code}: folder tree, manifest and {q.Roles.Count} models."));
            return Task.FromResult(r);
        }
    }

    /// <summary>
    /// Setup › Project (board manage/PaneProject, U13): start a project in a folder the person created (D5). Everything
    /// typed here is kept as a draft for this person until the project starts; Start runs a dry run, asks, then makes
    /// the folder tree, the manifest and one model per discipline with Project Information filled in.
    /// </summary>
    public sealed class ProjectPage : SectionPage
    {
        public static readonly string[] Roles = { "A", "I", "S", "M", "E", "P", "FP", "LP", "C", "L", "W", "Z" };
        public static readonly string[] DefaultRoles = { "A", "S", "M", "E", "P" };
        public static readonly string[] BuildingClasses = { "Residential", "Commercial", "Institutional", "Industrial" };
        public static readonly string[] CoordinateSystems = { "Arc 1960 / UTM 36N (EPSG:21096)", "Arc 1960 / UTM 35N", "WGS 84 / UTM 36N" };
        public static readonly string[] Stages = { "G3 Detailed / permit", "G1 Concept", "G2 Scheme", "G4 Construction", "G5 As-built" };
        public static readonly string[] Gates = { "Gate 2 · delivery milestone", "Gate 1 · mobilisation", "Gate 3 · close-out" };
        public static readonly string[] IssueSets = { "PERMIT", "TENDER", "CONSTRUCTION", "RECORD" };
        public static readonly string[] ClientStages = { "None", "RIBA 4 · Technical design", "AIA · Construction documents", "Local · building permit" };

        /// <summary>Project Information rows: label and the kit parameter they fill.</summary>
        public static readonly (string Label, string Parameter)[] DetailFields =
        {
            ("Project name", "FMC_Project_Name"), ("Appointing party (client)", "FMC_Client"), ("Plot no.", "FMC_Plot_No"),
            ("Block no.", "FMC_Block_No"), ("Village / parish", "FMC_Village"), ("Division / sub-county", "FMC_Division"),
            ("District", "FMC_District"), ("Site area (m²)", "FMC_Site_Area_m2"), ("Lead consultant", "FMC_Lead_Consultant"),
            ("Lead architect", "FMC_Lead_Architect"), ("Structural engineer", "FMC_Structural_Engineer"), ("MEP engineer", "FMC_MEP_Engineer"),
            ("FFL ±0.000 (m above MSL)", "FMC_FFL"),
        };

        private readonly IProjectTools _tools;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly IFilePicker _picker;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly TextSetting _folder;
        private readonly TextSetting _code;
        private readonly TextSetting _originator;
        private readonly TextSetting _volume;
        private readonly TextSetting _level;
        private readonly MultiSetting _roles;

        public ProjectPage(IProjectTools tools, IUserSettings settings, IFilePicker picker, Action<string> status, Action<DialogViewModel> ask)
            : base("Setup › Project", "Start a project: the folder tree, the manifest and one model per discipline, named by the kit.")
        {
            _tools = tools;
            _settings = settings;
            _store = new SettingStore(settings);
            _picker = picker;
            _status = status;
            _ask = ask;
            PreviewCommand = new AsyncCommand(Preview, status);
            StartCommand = new AsyncCommand(Start, status);
            _folder = new TextSetting("Project folder", "", @"Z:\Projects\F26001", store: _store, key: "project.folder", mono: true,
                hint: "You create the folder; the tree is built inside it, and only into an empty folder (D5).");
            _code = new TextSetting("Project code", "", "F26001", store: _store, key: "project.code", mono: true,
                hint: "2–6 characters, A–Z and 0–9 (Manual 4.1). Never FMC, which marks the kit library.");
            _originator = new TextSetting("Originator", "FMC", store: _store, key: "project.originator", mono: true);
            _volume = new TextSetting("Volume", "ZZ", store: _store, key: "project.volume", mono: true, hint: "ZZ: whole building");
            _level = new TextSetting("Level", "ZZ", store: _store, key: "project.level", mono: true, hint: "ZZ: all levels");
            _roles = new MultiSetting(_store, "project.roles", "Discipline models (roles)", Roles, DefaultRoles,
                hint: "One model each, from the kit's template for that role.");
            Rebuild();
        }

        public ICommand PreviewCommand { get; }
        public ICommand StartCommand { get; }
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Start (dry run)", StartCommand, primary: true),
            new FooterAction("Preview", PreviewCommand),
        };

        public override void Opened() => Rebuild();

        private void Rebuild()
        {
            Groups.Clear();
            Groups.Add(new SettingsGroup("Where",
                _folder,
                new ButtonsSetting("", new[] { new SettingButton("Browse…", new RelayCommand(BrowseFolder)), new SettingButton("Check", new RelayCommand(Rebuild)) }),
                new CheckListSetting(FolderChecks().Select(c => new CheckRow(c, null))),
                _code,
                new TextSetting("Short name", "", "Pilot House", store: _store, key: "project.shortname")));

            var details = new List<SettingItem>
            {
                new ButtonsSetting("", new[] { new SettingButton("Fill from the approved concept (CIS)", new RelayCommand(() =>
                    _status("Fill from the approved concept: Formcraft Model › Start from brief (U23). Blanks stay blank."))) }),
            };
            foreach (var (label, parameter) in DetailFields)
                details.Add(new TextSetting(label, "", store: _store, key: "project.d." + parameter));
            details.Insert(9, new ChoiceSetting(_store, "project.d.FMC_Building_Class", "Building class", BuildingClasses));
            details.Add(new ChoiceSetting(_store, "project.d.FMC_CRS", "Coordinate system", CoordinateSystems, dropdown: true));
            details.Add(new NoteSetting("Each field is a kit shared parameter (FMC_Project_Name, FMC_Plot_No, FMC_District, FMC_Site_Area_m2, FMC_CRS…). " +
                                        "Title blocks read them, so they are typed once here."));
            Groups.Add(new SettingsGroup("Project details · written to Project Information", details.ToArray()));

            Groups.Add(new SettingsGroup("Who and what",
                new ChoiceSetting(_store, "project.d.FMC_Client_Kit", "Client", ConnectViewModel.ClientKits, dropdown: true),
                new TextSetting("Site address", "", store: _store, key: "project.d.FMC_Site_Address"),
                _roles, _originator, _volume, _level));

            Groups.Add(new SettingsGroup("Naming convention · from the kit",
                new ReadOnlySetting("Models", "[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt", mono: true),
                new ReadOnlySetting("Live example", Example(), mono: true),
                new ReadOnlySetting("Project families", Code() + @"_[Role]_[CategoryToken]_[Description].rfa · in 01_WIP\<Role>\Families (D4)", mono: true),
                new ReadOnlySetting("Sheets", "[Role]-[Series][Number], e.g. A-1001 · from the sheet register"),
                new NoteSetting("The patterns are fixed by the kit; the project only picks its codes. The server rejects any other name.")));

            Groups.Add(new SettingsGroup("Stage and issue",
                new ChoiceSetting(_store, "project.stage", "Model development stage", Stages, dropdown: true),
                new ChoiceSetting(_store, "project.gate", "Next gate", Gates, dropdown: true),
                new ChoiceSetting(_store, "project.issueset", "Issue set", IssueSets),
                new ChoiceSetting(_store, "project.clientstage", "Client's stage label (optional)", ClientStages, dropdown: true,
                    hint: "Gates and issue sets drive the plugin. RIBA, AIA or local stages are labels mapped onto them.")));

            var templates = Templates();
            Groups.Add(new SettingsGroup("Project manifest",
                new ReadOnlySetting("Standard", Standard()),
                new ReadOnlySetting("Templates", templates.Count == 0 ? "No discipline picked" : string.Join(Environment.NewLine,
                    templates.Select(t => t.Key + ": " + (t.Value.Length == 0 ? "no template in the kit (06_Templates)" : Path.GetFileName(t.Value)))), mono: true,
                    hint: "Stamped into Project Information and 01_WIP\\FMC_Project.json, so every later check knows which rules applied.")));

            Groups.Add(new SettingsGroup("Start", new ButtonsSetting("", new[]
            {
                new SettingButton("Preview", PreviewCommand),
                new SettingButton("Start (dry run)", StartCommand, primary: true),
            }, "Start makes nothing until you say yes to its dry run."), _messages,
                new NoteSetting("After the start: link the models, project families from a size table, and the first QA run come with Manage's next sections.")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "project.considerations", _status)));
        }

        private string Code() => (_store.Get("project.code") ?? "").Trim().ToUpperInvariant() is string c && c.Length > 0 ? c : "[Project]";

        private string Example()
        {
            var roles = _roles.On.ToList();
            return $"{Code()}-{Get("project.originator", "FMC")}-{Get("project.volume", "ZZ")}-{Get("project.level", "ZZ")}-M3-{(roles.Count > 0 ? roles[0] : "A")}-0001.rvt";
        }

        private string Get(string key, string fallback) => (_store.Get(key) ?? "").Trim().ToUpperInvariant() is string v && v.Length > 0 ? v : fallback;

        private IEnumerable<HealthCheck> FolderChecks()
        {
            var folder = (_store.Get("project.folder") ?? "").Trim();
            if (folder.Length == 0) { yield return new HealthCheck("Project folder", "Not chosen", ChipKind.Grey); yield break; }
            bool exists = Directory.Exists(folder);
            yield return new HealthCheck("Folder exists", exists ? "OK" : "Not found", exists ? ChipKind.Good : ChipKind.Bad);
            if (exists)
            {
                bool empty = !Directory.EnumerateFileSystemEntries(folder).Select(Path.GetFileName)
                    .Any(f => !string.Equals(f, "desktop.ini", StringComparison.OrdinalIgnoreCase) && !string.Equals(f, "Thumbs.db", StringComparison.OrdinalIgnoreCase));
                yield return new HealthCheck("Folder is empty", empty ? "OK" : "Not empty", empty ? ChipKind.Good : ChipKind.Bad);
            }
            var code = (_store.Get("project.code") ?? "").Trim().ToUpperInvariant();
            bool codeOk = Regex.IsMatch(code, "^[A-Z0-9]{2,6}$") && code != "FMC";
            yield return new HealthCheck("Project code", code.Length == 0 ? "Not set" : codeOk ? code + " passes" : code + " doesn't pass", codeOk ? ChipKind.Good : ChipKind.Bad);
        }

        /// <summary>The kit's template per role: FMC_&lt;Role&gt;_Template_v*.rte, else FMC_Base_Template_v*.rte (06_Templates).</summary>
        public Dictionary<string, string> Templates()
        {
            var kit = _settings.Get(SettingKeys.KitFolder) ?? "";
            var dir = Path.Combine(kit, "06_Templates");
            string Pick(string pattern)
            {
                try { return Directory.Exists(dir) ? Directory.GetFiles(dir, pattern).OrderByDescending(f => f, StringComparer.OrdinalIgnoreCase).FirstOrDefault() ?? "" : ""; }
                catch { return ""; }
            }
            var result = new Dictionary<string, string>();
            foreach (var role in _roles.On)
            {
                var t = Pick("FMC_" + role + "_Template_v*.rte");
                result[role] = t.Length > 0 ? t : Pick("FMC_Base_Template_v*.rte");
            }
            return result;
        }

        private string Standard()
        {
            var kit = _settings.Get(SettingKeys.KitFolder) ?? "";
            return "FMC-BIM v2.2" + (kit.Length > 0 ? " · kit " + kit : "");
        }

        public ProjectRequest Request() => new ProjectRequest
        {
            Folder = (_store.Get("project.folder") ?? "").Trim(),
            Code = (_store.Get("project.code") ?? "").Trim().ToUpperInvariant(),
            Originator = Get("project.originator", "FMC"),
            Volume = Get("project.volume", "ZZ"),
            Level = Get("project.level", "ZZ"),
            Roles = _roles.On.ToList(),
            Templates = Templates().Where(t => t.Value.Length > 0).ToDictionary(t => t.Key, t => t.Value),
            Details = DetailFields.Select(f => f.Parameter).Concat(new[] { "FMC_Building_Class", "FMC_CRS", "FMC_Client_Kit", "FMC_Site_Address" })
                .Select(p => (p, v: _store.Get("project.d." + p) ?? ""))
                .Where(x => x.v.Trim().Length > 0).ToDictionary(x => x.p, x => x.v.Trim()),
            Stage = (_store.Get("project.stage") ?? Stages[0]).Split(' ')[0],
            IssueSet = _store.Get("project.issueset") ?? IssueSets[0],
            Standard = "FMC-BIM v2.2",
        };

        private void BrowseFolder()
        {
            var path = _picker.Folder("Choose the project folder you created", _store.Get("project.folder") ?? "");
            if (path == null) return;
            _folder.Value = path;
            Rebuild();
        }

        /// <summary>Preview: what a start would make, or why it can't, without making anything.</summary>
        private async Task Preview()
        {
            var r = await _tools.RunAsync(Request(), true);
            if (!r.Ok) { _messages.Show(r.Messages); _status("The start can't run yet: see the reasons."); return; }
            _messages.Show(ChipKind.Info, "Preview: nothing exists yet. Start runs a dry run first.");
            _ask(DialogViewModel.WithItems("Preview: what will be made", "Nothing exists yet. Start runs a dry run first.",
                new SettingItem[] { new ReadOnlySetting("Will make", string.Join(Environment.NewLine, r.Details), mono: true) }, "Done",
                () => Task.FromResult<string?>(null)));
        }

        private async Task Start()
        {
            var q = Request();
            var dry = await _tools.RunAsync(q, true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status("Start refused: see the reasons."); return; }
            _status("Dry run passed. Nothing has been made yet.");
            _ask(DialogViewModel.WithItems("Start " + q.Code + "?",
                "Builds the folder tree, writes the manifest and makes " + q.Roles.Count + " models with Project Information filled in.",
                new SettingItem[] { new ReadOnlySetting("Will make", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Start " + q.Code,
                async () =>
                {
                    _status("Starting " + q.Code + "…");
                    var r = await _tools.RunAsync(q, false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    return null;
                }));
        }
    }
}
