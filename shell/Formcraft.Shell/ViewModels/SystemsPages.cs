using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// What each building system can do today, said honestly: the engineering grid (E0), 23 systems by 7 capabilities,
    /// read from docs/tracker/mep_matrix.json (fmc-mep-matrix/0.1, embedded in this assembly). The build tracker and
    /// the server's fmc_systems matrix read the same file; a cell changes only with the PR that changes it. A system is
    /// covered only when every capability that applies is tested in Revit on a real client model.
    /// </summary>
    public static class SystemCapabilities
    {
        public const string Tested = "Tested in Revit";
        public const string NotApplicable = "Not applicable";
        public const string Planned = "Planned";

        [DataContract]
        public sealed class MatrixDef
        {
            [DataMember(Name = "schema")] public string Schema { get; set; } = "";
            [DataMember(Name = "disciplines")] public Dictionary<string, string> Disciplines { get; set; } = new Dictionary<string, string>();
            [DataMember(Name = "capabilities")] public CapabilityDef[] Capabilities { get; set; } = new CapabilityDef[0];
            [DataMember(Name = "systems")] public SystemDef[] Systems { get; set; } = new SystemDef[0];
            [DataMember(Name = "cells")] public CellDef[] Cells { get; set; } = new CellDef[0];
        }

        [DataContract]
        public sealed class CapabilityDef
        {
            [DataMember(Name = "id")] public string Id { get; set; } = "";
            [DataMember(Name = "name")] public string Name { get; set; } = "";
            [DataMember(Name = "meaning")] public string Meaning { get; set; } = "";
        }

        [DataContract]
        public sealed class SystemDef
        {
            [DataMember(Name = "id")] public string Id { get; set; } = "";
            [DataMember(Name = "name")] public string Name { get; set; } = "";
            [DataMember(Name = "discipline")] public string Discipline { get; set; } = "";
        }

        [DataContract]
        public sealed class CellDef
        {
            [DataMember(Name = "system")] public string System { get; set; } = "";
            [DataMember(Name = "capability")] public string Capability { get; set; } = "";
            [DataMember(Name = "state")] public string State { get; set; } = "";
            [DataMember(Name = "evidence")] public string[] Evidence { get; set; } = new string[0];
            [DataMember(Name = "feature")] public string Feature { get; set; } = "";
            [DataMember(Name = "step")] public string Step { get; set; } = "";
            [DataMember(Name = "note")] public string Note { get; set; } = "";
        }

        /// <summary>The grid shipped in Formcraft.Shell.dll.</summary>
        public static MatrixDef Matrix { get; } = Load();

        public static MatrixDef Load()
        {
            using var stream = typeof(SystemCapabilities).Assembly.GetManifestResourceStream("Formcraft.Shell.mep_matrix.json")
                ?? throw new InvalidOperationException("mep_matrix.json is not embedded in Formcraft.Shell");
            return Load(stream);
        }

        public static MatrixDef Load(Stream json)
        {
            var settings = new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true };
            var m = (MatrixDef?)new DataContractJsonSerializer(typeof(MatrixDef), settings).ReadObject(json)
                ?? throw new InvalidDataException("mep_matrix.json is empty");
            if (m.Schema != "fmc-mep-matrix/0.1") throw new InvalidDataException("mep_matrix.json: unknown schema '" + m.Schema + "'");
            return m;
        }

        /// <summary>The disciplines by name, in the order their first system appears in the grid.</summary>
        public static readonly string[] Disciplines = Matrix.Systems.Select(s => DisciplineName(s.Discipline)).Distinct().ToArray();

        /// <summary>"1 Enrich" … "7 Document".</summary>
        public static readonly string[] Capabilities = Matrix.Capabilities.Select((c, i) => (i + 1) + " " + c.Name).ToArray();

        public static readonly IReadOnlyDictionary<string, string[]> Systems = Disciplines.ToDictionary(
            d => d, d => Matrix.Systems.Where(s => DisciplineName(s.Discipline) == d).Select(s => s.Name).ToArray());

        public static string DisciplineName(string code) => Matrix.Disciplines.TryGetValue(code, out var n) ? n : code;

        /// <summary>The cell for a system and a capability ("1 Enrich" or "Enrich"); null when the grid has none.</summary>
        public static CellDef? Cell(string system, string capability)
        {
            var s = Matrix.Systems.FirstOrDefault(x => x.Name == system || x.Id == system);
            int space = capability.IndexOf(' ');
            string name = space > 0 && char.IsDigit(capability[0]) ? capability.Substring(space + 1) : capability;
            var c = Matrix.Capabilities.FirstOrDefault(x => x.Name == name || x.Id == name);
            return s == null || c == null ? null : Matrix.Cells.FirstOrDefault(x => x.System == s.Id && x.Capability == c.Id);
        }

        /// <summary>The state of one capability for one system, in the grid's own words (Planned when it has none).</summary>
        public static string Status(string system, string capability) => Cell(system, capability)?.State ?? Planned;

        /// <summary>Capabilities tested in Revit for this system.</summary>
        public static int Done(string system) => Capabilities.Count(c => Status(system, c) == Tested);

        /// <summary>Capabilities that apply to this system (all seven but those marked Not applicable).</summary>
        public static int Applicable(string system) => Capabilities.Count(c => Status(system, c) != NotApplicable);

        /// <summary>A short line for the systems table: "2 built · 3 partly · 1 kit calc", or Planned.</summary>
        public static string Summary(string system)
        {
            var states = Capabilities.Select(c => Status(system, c)).ToList();
            var parts = new List<string>();
            void Add(string state, string word) { int n = states.Count(s => s == state); if (n > 0) parts.Add(n + " " + word); }
            Add(Tested, "tested");
            Add("Built, Revit check due", "built");
            Add("Partly built", "partly");
            Add("Kit calculation only", "kit calc");
            return parts.Count == 0 ? Planned : string.Join(" · ", parts);
        }

        /// <summary>The whole grid in one line: "0 of 159 cells tested in Revit · 15 built, Revit check due · …".</summary>
        public static string Headline()
        {
            var cells = Matrix.Cells;
            int n(string state) => cells.Count(c => c.State == state);
            return n(Tested) + " of " + (cells.Length - n(NotApplicable)) + " cells tested in Revit · " + n("Built, Revit check due") + " built, Revit check due · " +
                   n("Partly built") + " partly built · " + n("Kit calculation only") + " kit calculation only · " + n(Planned) + " planned";
        }
    }

    /// <summary>
    /// Engineer › Systems (board model/PaneModelSystems, U25): pick a discipline and a system, see its seven capabilities
    /// with honest status, and run the read-only electrical check (boards, loads, circuits, feeders). Formcraft prepares
    /// and checks; sizing and design stay with the engineer.
    /// </summary>
    public sealed class SystemsPage : SectionPage
    {
        private readonly ISystemTools _tools;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private SystemsCheck? _last;

        public SystemsPage(ISystemTools tools, ProjectPage project, IUserSettings settings, Action<string> status)
            : base("Engineer › Systems", "Each building system's seven capabilities, and the checks that run on this model.")
        {
            _tools = tools;
            _project = project;
            _store = new SettingStore(settings);
            _status = status;
            CheckCommand = new AsyncCommand(() => Check(false), status);
            SaveCommand = new AsyncCommand(() => Check(true), status);
            Rebuild();
        }

        public ICommand CheckCommand { get; }
        public ICommand SaveCommand { get; }
        public SystemsCheck? Last => _last;

        public override IEnumerable<FooterAction> Footer => Discipline == "Electrical"
            ? new[] { new FooterAction("Save the list", SaveCommand), new FooterAction("Check (read only)", CheckCommand, primary: true) }
            : new FooterAction[0];

        public string Discipline => _store.Get("systems.discipline") ?? SystemCapabilities.Disciplines[0];

        public string System
        {
            get
            {
                var list = SystemCapabilities.Systems[Discipline];
                var s = _store.Get("systems.system");
                return list.Contains(s) ? s! : list[0];
            }
        }

        public void Rebuild()
        {
            Groups.Clear();
            var systems = SystemCapabilities.Systems[Discipline];
            var table = new TableSetting("", new[] { "System", "Done", "Status" },
                systems.Select(s => new TableRow(s, s, SystemCapabilities.Done(s) + " of " + SystemCapabilities.Applicable(s), SystemCapabilities.Summary(s))),
                selectable: true, hint: "Done: capabilities tested in Revit on a real model, of those that apply.");
            table.Selected = table.Rows.FirstOrDefault(r => (string?)r.Tag == System);
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is string s) || s == System) return;
                _store.Set("systems.system", s);
                Rebuild();
            };
            Groups.Add(new SettingsGroup("System",
                new ChoiceSetting(_store, "systems.discipline", "Discipline", SystemCapabilities.Disciplines, changed: _ => { _store.Set("systems.system", null); _last = null; Rebuild(); }),
                table,
                new NoteSetting("A system is covered only when every capability that applies is tested in Revit on a real client model.", ChipKind.Grey),
                new NoteSetting("Model target · 23 systems × 7 capabilities · " + SystemCapabilities.Headline() + ".", ChipKind.Info)));
            Groups.Add(new SettingsGroup("Seven capabilities · " + System,
                new TableSetting("", new[] { "Capability", "Status", "Note" }, SystemCapabilities.Capabilities.Select(c =>
                {
                    var cell = SystemCapabilities.Cell(System, c);
                    string next = cell == null || cell.Step.Length == 0 ? "" : " (" + cell.Step + ")";
                    return new TableRow(c, c, SystemCapabilities.Status(System, c), (cell?.Note ?? "") + next);
                }), hint: "From the engineering grid, docs/tracker/mep_matrix.json; E1–E4 are the next steps (docs/PLAN_ENGINEERING_SERVICES.md).")));

            if (Discipline == "Electrical")
            {
                var run = new List<SettingItem>
                {
                    new NoteSetting("Read-only: boards with their connected and demand loads, circuits and the circuit that feeds each; devices on no circuit; circuits on no board. Nothing is changed.", ChipKind.Info),
                    new ButtonsSetting("", new[] { new SettingButton("Save the list", SaveCommand), new SettingButton("Check (read only)", CheckCommand, primary: true) }),
                    _messages,
                };
                Groups.Add(new SettingsGroup("Run on this model", run.ToArray()));
                if (_last != null && _last.Ok)
                {
                    Groups.Add(new SettingsGroup("Board manager · " + _last.Model,
                        _last.Boards.Count == 0 ? (SettingItem)new NoteSetting("No electrical equipment in this model.")
                            : new TableSetting("", new[] { "Board", "Load kVA", "Circuits", "Fed by", "Check" },
                                _last.Boards.Select(b => new TableRow(b, b.Name, Kva(b.ConnectedVa) + " / " + Kva(b.DemandVa), b.Circuits.ToString(), b.FedBy.Length > 0 ? b.FedBy : "—", b.Check)),
                                hint: "Load: connected / demand, from Revit's own panel values."),
                        new TableSetting("Checks", new[] { "Check", "Found", "Result" }, _last.Checks.Select(c => new TableRow(c, c.Check, c.Found, c.State)))));
                }
                Groups.Add(new SettingsGroup("Enrich and Size · FormCraft Electrical 0.1",
                    new NoteSetting("Enrich Data and Size Feeders are built (FormCraft Electrical 0.1), but they write 16 FMC_ parameters the kit doesn't have yet " +
                                    "(FMC_Load_VA, FMC_Voltage, FMC_Conductor_Size and others). They join the add-in once the kit adds them: the kit wins (rule 7).", ChipKind.Warn)));
            }
            else if (Discipline == "Structural")
                Groups.Add(new SettingsGroup("Run on this model", new NoteSetting("Structural: the analytical model check and the Robot hand-off are in Engineer › Structural.", ChipKind.Grey)));
            else
                Groups.Add(new SettingsGroup("Run on this model", new NoteSetting(Discipline + ": no checks run from here yet. Line diagrams are drawn through Claude (fmc_diagram) until " +
                    "the pane's Generate button (E2); the kit's calculations arrive with E1, each with a dry run and the same control layer as Manage.", ChipKind.Grey)));

            Groups.Add(new SettingsGroup("Hand-offs to Manage",
                new NoteSetting("Diagram sheets go to Drawings › Sheets, calculation reports join Ready to issue, and quantities feed Check › Reports, as each capability ships.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "systems.considerations", _status)));
        }

        private static string Kva(double va) => (va / 1000).ToString("0.0", CultureInfo.InvariantCulture);


        private async Task Check(bool save)
        {
            var folder = _project.Request().Folder;
            _last = await _tools.ElectricalAsync(folder, save);
            if (!_last.Ok) _messages.Show(ChipKind.Bad, _last.Message);
            else _messages.Show(save && _last.Saved.Length > 0 ? ChipKind.Good : ChipKind.Info, save && _last.Saved.Length > 0 ? "Saved for the engineer: " + _last.Saved : _last.Message);
            _status(_last.Ok ? _last.Message : _last.Message);
            Rebuild();
        }
    }

    /// <summary>
    /// Engineer › Structural (board model/PaneModelStructural, U25): the seven steps with honest status, the read-only
    /// analytical model check, and analysis results already in the model. Formcraft never sizes or changes a structural
    /// member: the engineer decides (CLAUDE.md rule 5).
    /// </summary>
    public sealed class StructuralPage : SectionPage
    {
        public static readonly (string Step, string Status)[] Steps =
        {
            ("1 Enrich: grades, exposure class, member marks (kit fields)", "Check only: lists empty kit fields"),
            ("2 Analytical check: members joined, supports, offsets", "Partly"),
            ("3 Loads: cases and combinations (set by the engineer)", "Engineer"),
            ("4 Hand-off: the analytical model to the engineer's analysis software", "Robot: sends members, nodes and the engineer's supports and cases"),
            ("5 Results back: sizes and utilisation, differences listed", "Partly: Robot's NEd and MEd into FMC_FEA_; sizes stay the engineer's"),
            ("6 Quantities: concrete m³ by grade, steel t, rebar BBS", "Planned"),
            ("7 Document: S sheet set, schedules, BBS", "Planned"),
        };

        private readonly ISystemTools _tools;
        private readonly ProjectPage _project;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private SystemsCheck? _last;
        private readonly IRobotTools _robot;
        private readonly Action<DialogViewModel> _ask;
        private readonly SettingStore _robotDraft = new SettingStore(new InMemoryUserSettings(), "");
        private readonly MessagesSetting _robotMessages = new MessagesSetting();
        private RobotResult? _robotStatus;
        private RobotResult? _robotLast;
        private RobotForm? _previewed;
        private bool _resultsReady;

        public static readonly string[] SupportOptions = { "Choose", "Fixed", "Pinned" };

        public StructuralPage(ISystemTools tools, ProjectPage project, IUserSettings settings, Action<string> status,
                              IRobotTools? robot = null, Action<DialogViewModel>? ask = null)
            : base("Engineer › Structural", "Prepare and check the structural model; the engineer designs and signs.")
        {
            _robot = robot ?? new MockRobotTools();
            _ask = ask ?? (_ => { });
            RobotStatusCommand = new AsyncCommand(RobotStatus, status);
            RobotPreviewCommand = new AsyncCommand(RobotPreview, status);
            RobotSendCommand = new AsyncCommand(RobotSend, status);
            RobotCalculateCommand = new AsyncCommand(RobotCalculate, status);
            RobotResultsCommand = new AsyncCommand(() => RobotResults(true), status);
            RobotWriteCommand = new AsyncCommand(RobotWrite, status);
            _tools = tools;
            _project = project;
            _settings = settings;
            _store = new SettingStore(settings);
            _status = status;
            CheckCommand = new AsyncCommand(() => Check(false), status);
            SaveCommand = new AsyncCommand(() => Check(true), status);
            Rebuild();
        }

        public ICommand CheckCommand { get; }
        public ICommand SaveCommand { get; }
        public SystemsCheck? Last => _last;
        public ICommand RobotStatusCommand { get; }
        public ICommand RobotPreviewCommand { get; }
        public ICommand RobotSendCommand { get; }
        public ICommand RobotCalculateCommand { get; }
        public ICommand RobotResultsCommand { get; }
        public ICommand RobotWriteCommand { get; }
        public RobotResult? RobotLast => _robotLast;
        public SettingStore RobotDraft => _robotDraft;
        public MessagesSetting RobotMessages => _robotMessages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Save the list", SaveCommand),
            new FooterAction("Check (read only)", CheckCommand, primary: true),
        };

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(new SettingsGroup("Structural systems",
                new TableSetting("", new[] { "System", "Done", "Status" },
                    new[] { "Foundations (pads, strips, ground beams)", "RC frame (columns, beams, slabs)", "Steel frame (UB, UC, purlins)", "Roof (timber and steel trusses)", "Stairs and walls" }
                        .Select(s => new TableRow(s, s, "0 of 7", "Check only"))),
                new NoteSetting("A structural system is covered only when all seven steps work end to end on a real client model.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Seven steps", new TableSetting("", new[] { "Step", "Status" }, Steps.Select(s => new TableRow(s, s.Step, s.Status)))));

            var check = new List<SettingItem>();
            if (_last != null && _last.Ok)
            {
                if (_last.Members.Length > 0) check.Add(new ReadOnlySetting("Checked", _last.Model + " · " + _last.Members));
                check.Add(new TableSetting("", new[] { "Check", "Found", "Result" }, _last.Checks.Select(c => new TableRow(c, c.Check, c.Found, c.State))));
                if (_last.NotInKit.Count > 0) check.Add(new NoteSetting("Not in the kit, so not checked: " + string.Join(", ", _last.NotInKit) + ".", ChipKind.Grey));
            }
            check.Add(new NoteSetting("Formcraft reports these; the engineer fixes or accepts them. Load cases and combinations are set per project by the engineer (Manual Part 12).", ChipKind.Info));
            check.Add(new ButtonsSetting("", new[] { new SettingButton("Save the list", SaveCommand), new SettingButton("Check (read only)", CheckCommand, primary: true) }));
            check.Add(_messages);
            Groups.Add(new SettingsGroup("Analytical model check", check.ToArray()));

            var results = new List<SettingItem>();
            if (_last == null) results.Add(new NoteSetting("Run the check to read the analysis results already in the model (FMC_FEA_Utilisation).", ChipKind.Grey));
            else if (_last.Results.Count == 0) results.Add(new NoteSetting("No analysis results in this model yet: they come back with the hand-off (step 4).", ChipKind.Grey));
            else results.Add(new TableSetting("", new[] { "Member", "Type", "Util.", "Run" },
                _last.Results.Select(r => new TableRow(r, r.Mark, r.Type, r.Utilisation.ToString("0.00", CultureInfo.InvariantCulture), r.Run))));
            results.Add(new NoteSetting("Section changes are the engineer's decision. Formcraft lists the differences; the engineer applies them in Revit. Claude never changes a structural section.", ChipKind.Warn));
            Groups.Add(new SettingsGroup("Results back from analysis", results.ToArray()));
            Groups.Add(RobotGroup());
            Groups.Add(new SettingsGroup("Hand-offs to Manage",
                new NoteSetting("S sheets and schedules go to Drawings › Sheets, the design basis and calculation summary join Ready to issue, and quantities and the BBS feed Check › Reports, as each step ships.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "structural.considerations", _status)));
        }

        private SettingsGroup RobotGroup()
        {
            var items = new List<SettingItem>
            {
                new NoteSetting("Sends the analytical columns and beams to Robot Structural Analysis and brings the forces back. The supports, load cases, " +
                                "loads, combinations, code and sections are the engineer's: nothing is filled in.", ChipKind.Info),
            };
            if (_robotStatus == null) items.Add(new ButtonsSetting("", new[] { new SettingButton("Check Robot", RobotStatusCommand) }));
            else items.Add(new ReadOnlySetting("Robot", _robotStatus.Message + (_robotStatus.Runs.Count > 0 ? " · " + _robotStatus.Runs.Count + " runs" : "")));

            items.Add(new ChoiceSetting(_robotDraft, "supports", "Column-base supports", SupportOptions, hint: "The engineer's choice for every ground-floor column base"));
            items.Add(new TextSetting("Load cases", "", "G: permanent, self-weight; Q: imposed",
                "Separate cases with ; · natures: permanent, imposed, wind, snow, temperature, accidental, seismic", store: _robotDraft, key: "cases"));
            items.Add(new TextSetting("Engineer", "", "the engineer whose run this is", store: _robotDraft, key: "engineer"));
            var send = new List<SettingButton> { new SettingButton("Preview (dry run)", RobotPreviewCommand, primary: _previewed == null) };
            if (_previewed != null) send.Add(new SettingButton("Send to Robot", RobotSendCommand, primary: true));
            items.Add(new ButtonsSetting("", send));

            items.Add(new TextSetting("Run", _robotStatus?.Runs.FirstOrDefault() ?? "", "FEA-yyyymmdd-hhmm", store: _robotDraft, key: "run", mono: true));
            var back = new List<SettingButton> { new SettingButton("Calculate in Robot", RobotCalculateCommand), new SettingButton("Read results", RobotResultsCommand, primary: !_resultsReady) };
            if (_resultsReady) back.Add(new SettingButton("Write into the model", RobotWriteCommand, primary: true));
            items.Add(new ButtonsSetting("", back));

            if (_robotLast != null && _robotLast.Lines.Count > 0)
                items.Add(_robotLast.Count > 0
                    ? new TableSetting("Results · " + _robotLast.Run, new[] { "Member", "NEd kN", "MEd kN·m" }, _robotLast.Lines.Select(l => new TableRow(l, l.A, l.B, l.C)))
                    : new TableSetting("To Robot", new[] { "Item", "Count", "Detail" }, _robotLast.Lines.Select(l => new TableRow(l, l.A, l.B, l.C))));
            items.Add(new NoteSetting("Writes FMC_FEA_NEd_kN, FMC_FEA_MEd_kNm and FMC_FEA_Run_Ref only, behind the live-model lock. FMC_FEA_Approval_Ref and utilisation are the engineer's.", ChipKind.Warn));
            items.Add(_robotMessages);
            return new SettingsGroup("Robot (analysis hand-off)", items.ToArray());
        }

        /// <summary>"G: permanent, self-weight; Q: imposed" → cases. Natures in plain words map to Robot's.</summary>
        public static List<RobotCase> ParseCases(string text, List<string> problems)
        {
            var natures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["permanent"] = "PERMANENT", ["dead"] = "PERMANENT", ["imposed"] = "EXPLOATATION", ["live"] = "EXPLOATATION", ["exploatation"] = "EXPLOATATION",
                ["wind"] = "WIND", ["snow"] = "SNOW", ["temperature"] = "TEMPERATURE", ["accidental"] = "ACCIDENTAL", ["seismic"] = "SEISMIC",
            };
            var cases = new List<RobotCase>();
            int before = problems.Count;
            foreach (string part in (text ?? "").Split(';').Select(p => p.Trim()).Where(p => p.Length > 0))
            {
                int colon = part.IndexOf(':');
                string name = colon > 0 ? part.Substring(0, colon).Trim() : "";
                string[] words = (colon > 0 ? part.Substring(colon + 1) : "").Split(',').Select(w => w.Trim()).Where(w => w.Length > 0).ToArray();
                string? nature = words.Select(w => natures.TryGetValue(w, out var n) ? n : null).FirstOrDefault(n => n != null);
                if (name.Length == 0 || nature == null) { problems.Add("'" + part + "': write it as Name: nature (permanent, imposed, wind, snow, temperature, accidental or seismic)."); continue; }
                cases.Add(new RobotCase(name, nature, words.Any(w => w.StartsWith("self", StringComparison.OrdinalIgnoreCase))));
            }
            if (cases.Count == 0 && problems.Count == before) problems.Add("Name at least one load case.");
            return cases;
        }

        private RobotForm? ReadForm()
        {
            var problems = new List<string>();
            var form = new RobotForm { Supports = _robotDraft.Get("supports") ?? "Choose", Engineer = (_robotDraft.Get("engineer") ?? "").Trim() };
            if (form.Supports != "Fixed" && form.Supports != "Pinned") problems.Add("Choose the column-base supports.");
            form.Cases.AddRange(ParseCases(_robotDraft.Get("cases") ?? "", problems));
            if (form.Engineer.Length == 0) problems.Add("The engineer's name is needed.");
            if (problems.Count == 0) return form;
            _robotMessages.Show(ChipKind.Warn, string.Join(" ", problems));
            return null;
        }

        private string Run => (_robotDraft.Get("run") ?? _robotStatus?.Runs.FirstOrDefault() ?? "").Trim();

        private async Task RobotStatus()
        {
            _robotStatus = await _robot.StatusAsync();
            _robotMessages.Show(_robotStatus.Ok ? ChipKind.Info : ChipKind.Bad, _robotStatus.Message);
            Rebuild();
        }

        private async Task RobotPreview()
        {
            var form = ReadForm();
            if (form == null) return;
            _resultsReady = false;
            _robotLast = await _robot.SendAsync(form, true);
            _previewed = _robotLast.Ok ? form : null;
            _robotMessages.Show(_robotLast.Ok ? ChipKind.Info : ChipKind.Bad, _robotLast.Message);
            _status(_robotLast.Message);
            Rebuild();
        }

        private Task RobotSend()
        {
            var form = ReadForm();
            if (form == null || _previewed == null) return Task.CompletedTask;
            _ask(new DialogViewModel("Send to Robot?",
                "Robot opens with a new model of the analytical columns and beams, " + form.Supports + " supports and " + form.Cases.Count + " load cases. The Revit model doesn't change.",
                "Send", async () =>
                {
                    var r = await _robot.SendAsync(form, false);
                    _robotLast = r;
                    _previewed = null;
                    if (r.Ok && r.Run.Length > 0) _robotDraft.Set("run", r.Run);
                    _robotMessages.Show(r.Ok ? ChipKind.Good : ChipKind.Bad, r.Message);
                    _status(r.Message);
                    Rebuild();
                }));
            return Task.CompletedTask;
        }

        private async Task RobotCalculate()
        {
            if (Run.Length == 0) { _robotMessages.Show(ChipKind.Warn, "Name the run first."); return; }
            var r = await _robot.CalculateAsync(Run);
            _robotMessages.Show(r.Ok ? ChipKind.Good : ChipKind.Bad, r.Message);
            _status(r.Message);
        }

        private async Task RobotResults(bool dryRun)
        {
            if (Run.Length == 0) { _robotMessages.Show(ChipKind.Warn, "Name the run first."); return; }
            _robotLast = await _robot.ResultsAsync(Run, dryRun);
            _resultsReady = dryRun && _robotLast.Ok && _robotLast.Count > 0;
            _robotMessages.Show(_robotLast.Ok ? (dryRun ? ChipKind.Info : ChipKind.Good) : ChipKind.Bad, _robotLast.Message);
            _status(_robotLast.Message);
            Rebuild();
        }

        private Task RobotWrite()
        {
            if (!_resultsReady || _robotLast == null) return Task.CompletedTask;
            _ask(new DialogViewModel("Write the results into the model?",
                _robotLast.Count + " members get FMC_FEA_NEd_kN, FMC_FEA_MEd_kNm and FMC_FEA_Run_Ref " + Run + ", as one Undo. Nothing else changes.",
                "Write", () => RobotResults(false)));
            return Task.CompletedTask;
        }

        private async Task Check(bool save)
        {
            var kit = _settings.Get(SettingKeys.KitFolder) ?? "";
            if (kit.Length == 0) { _messages.Show(ChipKind.Warn, "Set the kit folder in Settings › General first: the field names come from the kit."); return; }
            _last = await _tools.StructuralAsync(kit, _project.Request().Folder, save);
            if (!_last.Ok) _messages.Show(ChipKind.Bad, _last.Message);
            else _messages.Show(save && _last.Saved.Length > 0 ? ChipKind.Good : ChipKind.Info, save && _last.Saved.Length > 0 ? "Saved for the engineer: " + _last.Saved : _last.Message);
            _status(_last.Message);
            Rebuild();
        }
    }
}
