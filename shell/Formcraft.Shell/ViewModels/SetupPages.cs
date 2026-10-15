using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>A section the pane builds itself: a title, groups of rows (as Settings), and its footer buttons.</summary>
    public abstract class SectionPage : ObservableObject
    {
        protected SectionPage(string title, string subtitle) { Title = title; Subtitle = subtitle; }
        public string Title { get; }
        public string Subtitle { get; }
        public ObservableCollection<SettingsGroup> Groups { get; } = new ObservableCollection<SettingsGroup>();
        /// <summary>Rows above the groups, outside a card: a section's step bar (boards CW_Pane, CL_Pane).</summary>
        public ObservableCollection<SettingItem> Top { get; } = new ObservableCollection<SettingItem>();
        public virtual IEnumerable<FooterAction> Footer => Enumerable.Empty<FooterAction>();
        /// <summary>Called when the section opens (load what it shows).</summary>
        public virtual void Opened() { }
    }

    /// <summary>What happened, newest run only: a line per message with its chip colour.</summary>
    public sealed class MessagesSetting : SettingItem
    {
        public MessagesSetting() : base("") { }
        public ObservableCollection<ToolMessage> Lines { get; } = new ObservableCollection<ToolMessage>();
        public bool HasLines => Lines.Count > 0;

        public void Show(IEnumerable<ToolMessage> messages)
        {
            Lines.Clear();
            foreach (var m in messages) Lines.Add(m);
            OnPropertyChanged(nameof(HasLines));
        }

        public void Show(ChipKind kind, string text) => Show(new[] { new ToolMessage(kind, text) });
    }

    /// <summary>One family in the builder's list: tick to include it, and its state chip.</summary>
    public sealed class FamilyPickRow : ObservableObject
    {
        private bool _on;
        private string _status = "Not checked yet";
        private ChipKind _kind = ChipKind.Grey;
        private string _meta;
        private string _tip = "";

        public FamilyPickRow(FamilySpec spec, bool on, Action changed)
        {
            Spec = spec;
            _on = on;
            _meta = spec.Role + " · " + spec.Category + " · " + Plural(spec.Connectors, "connector") + " · " + Plural(spec.Parameters, "parameter");
            Changed = changed;
        }

        private Action Changed { get; }
        public FamilySpec Spec { get; }
        public string Family => Spec.Family;
        public bool On { get => _on; set { if (Set(ref _on, value)) Changed(); } }
        public string Status { get => _status; private set => Set(ref _status, value); }
        public ChipKind Kind { get => _kind; private set => Set(ref _kind, value); }
        public string Meta { get => _meta; private set => Set(ref _meta, value); }
        public string Tip { get => _tip; private set => Set(ref _tip, value); }

        public void Apply(FamilyLine line)
        {
            Status = line.Status;
            Kind = line.Kind;
            if (line.Meta.Length > 0) Meta = line.Meta;
            Tip = line.Tip;
        }

        internal void SetOn(bool on) { _on = on; OnPropertyChanged(nameof(On)); }

        private static string Plural(int n, string word) => n + " " + word + (n == 1 ? "" : "s");
    }

    /// <summary>The builder's family list, with a role filter and quick picks.</summary>
    public sealed class FamilyPickSetting : SettingItem
    {
        public FamilyPickSetting() : base("Families") { }
        public ObservableCollection<FamilyPickRow> Rows { get; } = new ObservableCollection<FamilyPickRow>();
        public bool IsEmpty => Rows.Count == 0;
        public string Empty { get; set; } = "Reading the family specs…";
        public string Picked => Rows.Count(r => r.On) + " of " + Rows.Count + " selected";
        public void Changed() { OnPropertyChanged(nameof(Picked)); OnPropertyChanged(nameof(IsEmpty)); OnPropertyChanged(nameof(Empty)); }
    }

    /// <summary>
    /// Setup › Families (board manage/PaneFamilies, U15): the compliance scan of every family in the open file, each
    /// family's needs, bringing in a family from outside, the kit's shared parameters and keynotes, and the builder that
    /// makes families from the kit. Read-only checks work on live models; anything that writes runs a dry run first and
    /// asks (CLAUDE.md rule 3), and lands in staging: release stays with the Family Librarian.
    /// </summary>
    public sealed class FamiliesPage : SectionPage
    {
        public static readonly string[] ShowOptions = { "Not compliant", "Fixable", "Need a person", "All" };

        private readonly IFamilyTools _tools;
        private readonly ILibraryTools _library;
        private readonly IReleaseTools _release;
        private readonly MessagesSetting _releaseMessages = new MessagesSetting();
        private readonly SettingStore _releaseDraft = new SettingStore(new InMemoryUserSettings(), "");
        private GateResult? _gate;
        private readonly IFilePicker _picker;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly FamilyPickSetting _list = new FamilyPickSetting();
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly MessagesSetting _scanMessages = new MessagesSetting();
        private readonly MessagesSetting _bringMessages = new MessagesSetting();
        private readonly MessagesSetting _keynoteMessages = new MessagesSetting();
        private readonly SettingsGroup _builder;
        private FamilySpecs? _specs;
        private ScanResult? _scan;
        private FamilyVerdict? _selected;
        private BringInPlan? _plan;
        private IReadOnlyList<KitParameter>? _parameters;
        private KeynoteSearch? _keynotes;
        private bool _busy;

        public FamiliesPage(IFamilyTools tools, ILibraryTools library, IFilePicker picker, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask,
                            IReleaseTools? release = null)
            : base("Setup › Families", "Every family checked against the kit, families brought in from outside, and families built from the kit. Release stays with the Family Librarian.")
        {
            _tools = tools;
            _library = library;
            _release = release ?? new MockReleaseTools();
            GateCommand = new AsyncCommand(RunGate, status);
            ReleaseCommand = new AsyncCommand(() => Decide(true), status);
            SendBackCommand = new AsyncCommand(() => Decide(false), status);
            _picker = picker;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            PlanCommand = new AsyncCommand(() => Plan(quiet: false), status);
            BuildCommand = new AsyncCommand(Build, status);
            LoadTestCommand = new AsyncCommand(LoadTest, status);
            ScanCommand = new AsyncCommand(Scan, status);
            CheckCommand = new AsyncCommand(Check, status);
            BringInCommand = new AsyncCommand(BringIn, status);
            SearchParametersCommand = new AsyncCommand(SearchParameters, status);
            SearchKeynotesCommand = new AsyncCommand(SearchKeynotes, status);
            RequestKeynoteCommand = new AsyncCommand(RequestKeynote, status);

            _builder = new SettingsGroup("Build from the kit",
                new ButtonsSetting("Select", new[]
                {
                    new SettingButton("Pilot set", new RelayCommand(() => Pick(_specs?.Pilot ?? new string[0]))),
                    new SettingButton("All", new RelayCommand(() => Pick(_list.Rows.Select(r => r.Family)))),
                    new SettingButton("None", new RelayCommand(() => Pick(new string[0]))),
                }),
                _list,
                new ChoiceSetting(_store, "families.batch", "Build in Revit", new[] { "All at once", "One by one" },
                    hint: "One by one makes one Revit call per family, so a problem shows exactly which family caused it."),
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Plan", PlanCommand),
                    new SettingButton("Build", BuildCommand, primary: true),
                    new SettingButton("Load test", LoadTestCommand),
                }, "Build makes data-shell families in " + tools.StagingRoot + "\\<Role>. Load test runs in the active chain-test file."),
                _messages);
            Rebuild();
        }

        public ICommand GateCommand { get; }
        public ICommand ReleaseCommand { get; }
        public ICommand SendBackCommand { get; }
        public GateResult? LastGate => _gate;
        public SettingStore ReleaseDraft => _releaseDraft;
        public ICommand ScanCommand { get; }
        public ICommand CheckCommand { get; }
        public ICommand BringInCommand { get; }
        public ICommand SearchParametersCommand { get; }
        public ICommand SearchKeynotesCommand { get; }
        public ICommand RequestKeynoteCommand { get; }
        public ScanResult? LastScan => _scan;
        public BringInPlan? LastPlan => _plan;
        public MessagesSetting BringMessages => _bringMessages;
        public MessagesSetting KeynoteMessages => _keynoteMessages;

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(ScanGroup());
            Groups.Add(FamiliesGroup());
            if (_selected != null) Groups.Add(SelectedGroup(_selected));
            Groups.Add(BringInGroup());
            Groups.Add(ParametersGroup());
            Groups.Add(KeynotesGroup());
            Groups.Add(_builder);
            Groups.Add(ReleaseGroup());
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "families.considerations", _status)));
        }

        // ---------- Quality and release (U30, Phase 2) ----------

        private string GateFile => _store.Get("families.release.file") ?? "";

        private SettingsGroup ReleaseGroup()
        {
            var items = new List<SettingItem>
            {
                new NoteSetting("Gate A on a family in staging, then a person releases it to 04_Families\\<Role> or sends it back. Never automatic.", ChipKind.Info),
                new TextSetting("Family in staging", GateFile, "…\\04_Families\\_Staging\\A\\FMC_A_Door_SteelFanlight.rfa", store: _store, key: "families.release.file", mono: true),
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Browse", new RelayCommand(() =>
                    {
                        var f = _picker.Open("Family in staging", "Family (*.rfa)|*.rfa", System.IO.Path.GetDirectoryName(GateFile) ?? _tools.StagingRoot);
                        if (f != null) { _store.Set("families.release.file", f); _gate = null; Rebuild(); }
                    })),
                    new SettingButton("Run Gate A", GateCommand, primary: true),
                }),
            };
            if (_gate != null)
            {
                if (!_gate.Ok) items.Add(new NoteSetting(_gate.Message, ChipKind.Bad));
                else
                {
                    items.Add(new TableSetting("Gate A · " + _gate.Family, new[] { "Check", "Result", "Detail" }, _gate.Lines.Select(l => new TableRow(l, l.Check, l.State, l.Detail))));
                    items.Add(new NoteSetting(_gate.Passed ? "Gate A passed. Not checked items are the reviewer's to accept." : "Gate A fails: send it back with a note, fix it and build again.",
                        _gate.Passed ? ChipKind.Good : ChipKind.Bad));
                    items.Add(new TextSetting("Reviewer", "", "the discipline's Lead or engineer", store: _releaseDraft, key: "reviewer"));
                    items.Add(new TextSetting("Note", "", "what was checked and why it can go (or what to fix)", store: _releaseDraft, key: "note"));
                    var buttons = new List<SettingButton> { new SettingButton("Send back", SendBackCommand) };
                    if (_gate.Passed) buttons.Add(new SettingButton("Release", ReleaseCommand, primary: true));
                    items.Add(new ButtonsSetting("", buttons));
                }
            }
            items.Add(_releaseMessages);
            return new SettingsGroup("Quality and release", items.ToArray());
        }

        private async Task RunGate()
        {
            if (GateFile.Length == 0) { _releaseMessages.Show(ChipKind.Warn, "Choose the family in staging first."); return; }
            _gate = await _release.GateAsync(GateFile);
            _status(_gate.Message);
            Rebuild();
        }

        private Task Decide(bool release)
        {
            string reviewer = (_releaseDraft.Get("reviewer") ?? "").Trim(), note = (_releaseDraft.Get("note") ?? "").Trim();
            if (reviewer.Length == 0 || note.Length == 0) { _releaseMessages.Show(ChipKind.Warn, "A reviewer and a note are needed."); return Task.CompletedTask; }
            if (!release)
                return Send(() => _release.SendBackAsync(GateFile, reviewer, note));
            _ask(new DialogViewModel("Release " + System.IO.Path.GetFileNameWithoutExtension(GateFile) + "?",
                "It moves from staging to 04_Families\\<Role> and the release log records you, the reviewer and the note. It never overwrites a released family.",
                "Release", () => Send(() => _release.ReleaseAsync(GateFile, reviewer, note))));
            return Task.CompletedTask;
        }

        private async Task Send(Func<Task<ToolResult>> act)
        {
            var r = await act();
            _releaseMessages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "");
            if (r.Ok) { _gate = null; Rebuild(); }
        }

        // ---------- Compliance scan ----------

        private SettingsGroup ScanGroup()
        {
            var items = new List<SettingItem>();
            if (_scan == null)
                items.Add(new NoteSetting("Scan file checks every family in the open model against the Families rulebook: names, the kit's parameters " +
                                          "by GUID, keynotes and type names. It only reads, so it works on live models too."));
            else
            {
                items.Add(new ReadOnlySetting(_scan.Document, $"{_scan.Families.Count} scanned · {_scan.Compliant} compliant · {_scan.Fixable} fixable in one pass · {_scan.NeedAPerson} need a person"));
                items.Add(new CheckListSetting(_scan.ByCheck.Select(c => new CheckRow(ByCheckLine(c), null))));
            }
            items.Add(new ButtonsSetting("", new[]
            {
                new SettingButton(_scan == null ? "Scan file" : "Scan again", ScanCommand, primary: true),
                new SettingButton("List the families for a person", new RelayCommand(ListForAPerson)),
            }, "Checked against the Families rulebook. Fixable families are put right by bringing them in again (below), into staging; " +
               "the families in a live model are never changed by a tool."));
            items.Add(_scanMessages);
            return new SettingsGroup("Compliance scan · every family in this file", items.ToArray());
        }

        /// <summary>
        /// One check across the scan. Zero failures is a pass only for the families actually checked: with no kit spec a
        /// family isn't checked (a person decides), and that never shows as Pass (F-010).
        /// </summary>
        public static HealthCheck ByCheckLine((string Check, int Fail, int Pass, int NotChecked) c)
        {
            string unchecked_ = c.NotChecked > 0 ? c.NotChecked + " not checked (no kit spec: a person decides)" : "";
            if (c.Fail > 0) return new HealthCheck(c.Check, c.Fail + " fail", ChipKind.Bad, detail: unchecked_);
            if (c.Pass == 0 && c.NotChecked > 0) return new HealthCheck(c.Check, "Not checked", ChipKind.Grey, detail: unchecked_);
            if (c.NotChecked > 0) return new HealthCheck(c.Check, c.Pass + " pass", ChipKind.Warn, detail: unchecked_);
            return new HealthCheck(c.Check, "Pass", ChipKind.Good);
        }

        private async Task Scan()
        {
            _status("Scanning the families in the open model…");
            var r = await _library.ScanAsync();
            _scanMessages.Show(r.Ok ? ChipKind.Info : ChipKind.Bad, r.Message);
            _status(r.Message);
            if (r.Ok) { _scan = r; _selected = null; }
            Rebuild();
        }

        private void ListForAPerson()
        {
            if (_scan == null) { _scanMessages.Show(ChipKind.Warn, "Scan the file first."); _status("Scan the file first."); return; }
            var names = _scan.Families.Where(f => f.State == "Needs a person").Select(f => f.Name + ": " + f.Next).ToList();
            _scanMessages.Show(names.Count == 0 ? ChipKind.Good : ChipKind.Warn,
                names.Count == 0 ? "No family needs a person." : "For a person:\n• " + string.Join("\n• ", names));
        }

        // ---------- Families table ----------

        private SettingsGroup FamiliesGroup()
        {
            if (_scan == null)
                return new SettingsGroup("Families · click one to see what it needs", new NoteSetting("Scan the file to list its families."));
            var show = _store.Get("families.show") ?? ShowOptions[0];
            var rows = _scan.Families.Where(f => show == "All" || (show == "Not compliant" ? f.State != "Compliant" : show == "Fixable" ? f.State == "Fixable" : f.State == "Needs a person"));
            var table = new TableSetting("", new[] { "Family", "From", "Score", "State" },
                rows.Select(f => new TableRow(f, f.Name, f.From, f.Score.ToString(), f.State)), selectable: true);
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is FamilyVerdict v) { _selected = v; Rebuild(); }
            };
            return new SettingsGroup("Families · click one to see what it needs",
                new ChoiceSetting(_store, "families.show", "Show", ShowOptions, changed: _ => Rebuild()), table);
        }

        /// <summary>Opens a family's details as if it was clicked in the table.</summary>
        public void Select(string name)
        {
            _selected = _scan?.Families.FirstOrDefault(f => f.Name == name);
            Rebuild();
        }

        private SettingsGroup SelectedGroup(FamilyVerdict f) => new SettingsGroup("Selected · " + f.Name,
            new ReadOnlySetting("Category", f.Category),
            new ReadOnlySetting("Score", f.Score + " · " + f.State),
            new CheckListSetting(f.Checks.Select(c => new CheckRow(new HealthCheck(c.Check, c.StatusText, c.Kind, detail: c.State == "pass" ? "" : c.Detail), null))),
            new NoteSetting("Next: " + f.Next, f.Kind == ChipKind.Good ? ChipKind.Good : ChipKind.Info));

        // ---------- Bring in ----------

        private SettingsGroup BringInGroup()
        {
            var path = _store.Get("families.bring.path") ?? "";
            var items = new List<SettingItem>
            {
                new ReadOnlySetting("Downloaded family", path.Length == 0 ? "None chosen" : path, mono: true,
                    hint: "Manufacturer sites, other firms, old projects. The original file is never changed."),
                new ButtonsSetting("", new[] { new SettingButton("Choose a family file…", new RelayCommand(ChooseFamily)) }),
                new ChoiceSetting(_store, "families.bring.role", "Role", ProjectPage.Roles, 4, dropdown: true),
                new TextSetting("Description", "", "e.g. Socket MK", store: _store, key: "families.bring.description",
                    hint: "Plain words for the name; the category token comes from the kit."),
                new TextSetting("Keynote", "", "e.g. E.SOC_04", store: _store, key: "families.bring.keynote", mono: true,
                    hint: "Search the kit's keynotes below, or request a new one."),
                new ButtonsSetting("", new[] { new SettingButton("Check it", CheckCommand), new SettingButton("Bring in", BringInCommand, primary: true) }),
            };
            if (_plan != null)
            {
                var steps = new List<HealthCheck>
                {
                    new HealthCheck("Check it", "score " + (_plan.Verdict?.Score ?? 0), _plan.Verdict?.Kind ?? ChipKind.Grey, detail: _plan.Verdict?.State ?? ""),
                    new HealthCheck("Rename to the naming rule", _plan.ProposedName.Length > 0 ? "→ " + _plan.ProposedName : "Needs role and description",
                        _plan.ProposedName.Length > 0 ? ChipKind.Info : ChipKind.Warn),
                    new HealthCheck("Add the kit's parameters", _plan.AddParameters.Count + " to add", ChipKind.Info, detail: string.Join(", ", _plan.AddParameters)),
                    new HealthCheck("Set the keynote", (_store.Get("families.bring.keynote") ?? "").Length > 0 ? _store.Get("families.bring.keynote")! : "None", ChipKind.Info),
                    new HealthCheck("Purge CAD and unused types", _plan.ImportedCad > 0 ? _plan.ImportedCad + " CAD: by hand" : "No CAD", _plan.ImportedCad > 0 ? ChipKind.Warn : ChipKind.Good),
                    new HealthCheck("Save to library staging", _plan.SavePath.Length > 0 ? _plan.SavePath : "—", ChipKind.Info),
                };
                items.Add(new CheckListSetting(steps.Select(c => new CheckRow(c, null))));
            }
            items.Add(_bringMessages);
            items.Add(new NoteSetting("Connectors and technical modelling: Formcraft Model. Release from staging to the library stays with the Family Librarian."));
            return new SettingsGroup("Bring in a family from outside", items.ToArray());
        }

        private void ChooseFamily()
        {
            var path = _picker.Open("Choose a family to bring in", "Revit family (*.rfa)|*.rfa", "");
            if (path == null) return;
            _store.Set("families.bring.path", path);
            _plan = null;
            Rebuild();
        }

        private (string Path, string Role, string Description, string Keynote) BringInputs() => (
            _store.Get("families.bring.path") ?? "", _store.Get("families.bring.role") ?? ProjectPage.Roles[4],
            (_store.Get("families.bring.description") ?? "").Trim(), (_store.Get("families.bring.keynote") ?? "").Trim());

        private async Task Check()
        {
            var (path, role, description, keynote) = BringInputs();
            if (path.Length == 0) { _bringMessages.Show(ChipKind.Warn, "Choose a family file first."); _status("Choose a family file first."); return; }
            _status("Checking " + System.IO.Path.GetFileName(path) + "…");
            var plan = await _library.InspectAsync(path, role, description, keynote);
            _plan = plan.Ok ? plan : null;
            _bringMessages.Show(plan.Ok ? ChipKind.Info : ChipKind.Bad, plan.Ok ? "Checked. Every step is shown before it runs." : plan.Message);
            Rebuild();
        }

        private async Task BringIn()
        {
            var (path, role, description, keynote) = BringInputs();
            if (path.Length == 0) { _bringMessages.Show(ChipKind.Warn, "Choose a family file first."); _status("Choose a family file first."); return; }
            var dry = await _library.BringInAsync(path, role, description, keynote, true);
            if (!dry.Ok) { _bringMessages.Show(dry.Messages); return; }
            _ask(DialogViewModel.WithItems("Bring in " + System.IO.Path.GetFileName(path) + "?",
                "Saves a copy under its standard name in library staging; the original is never changed.",
                new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Bring in", async () =>
                {
                    var r = await _library.BringInAsync(path, role, description, keynote, false);
                    _bringMessages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    return null;
                }));
        }

        // ---------- Shared parameters ----------

        private SettingsGroup ParametersGroup()
        {
            var items = new List<SettingItem>
            {
                new TextSetting("Search the kit's shared parameters", "", "e.g. Asset or Mounting", store: _store, key: "families.paramquery"),
                new ButtonsSetting("", new[] { new SettingButton("Search", SearchParametersCommand) }),
            };
            if (_parameters != null)
                items.Add(_parameters.Count == 0 ? (SettingItem)new NoteSetting("No parameter matches.")
                    : new TableSetting("", new[] { "Parameter", "Group", "Type" }, _parameters.Select(p => new TableRow(p, p.Name, p.Group, p.Datatype))));
            items.Add(new NoteSetting("Only the kit's FMC_SharedParameters.txt, matched by GUID and data type, not just by name. A new parameter goes " +
                                      "through a change request. Bring in adds a family's parameters from its spec."));
            return new SettingsGroup("Shared parameters", items.ToArray());
        }

        private async Task SearchParameters()
        {
            _parameters = await _library.ParametersAsync((_store.Get("families.paramquery") ?? "").Trim());
            Rebuild();
        }

        // ---------- Keynotes ----------

        private SettingsGroup KeynotesGroup()
        {
            var items = new List<SettingItem>
            {
                new TextSetting("Search keynotes", "", "e.g. socket", store: _store, key: "families.keyquery"),
                new ButtonsSetting("", new[] { new SettingButton("Search", SearchKeynotesCommand) }),
            };
            if (_keynotes != null)
            {
                if (_keynotes.File.Length > 0) items.Insert(0, new ReadOnlySetting("Keynote file", _keynotes.File, mono: true));
                items.Add(_keynotes.Keynotes.Count == 0 ? (SettingItem)new NoteSetting(_keynotes.Ok ? "No keynote matches." : _keynotes.Message, _keynotes.Ok ? ChipKind.Info : ChipKind.Warn)
                    : new TableSetting("", new[] { "Code", "Description" }, _keynotes.Keynotes.Select(k => new TableRow(k, k.Code, k.Description))));
                if (_keynotes.Groups.Count > 0)
                {
                    items.Add(new ChoiceSetting(_store, "families.keygroup", "Add a keynote · group", _keynotes.Groups.ToArray(), dropdown: true, changed: g => { Task unused = SearchKeynotes(); }));
                    items.Add(new ReadOnlySetting("Next code", _keynotes.NextCode, mono: true));
                    items.Add(new TextSetting("Description", "", "Plain words; material, size and finish.", store: _store, key: "families.keytext"));
                    items.Add(new ButtonsSetting("", new[] { new SettingButton("Request this keynote", RequestKeynoteCommand) }));
                }
            }
            items.Add(_keynoteMessages);
            items.Add(new NoteSetting("New keynotes are requests: the BIM Manager approves them into the kit's keynote file."));
            return new SettingsGroup("Keynotes", items.ToArray());
        }

        private async Task SearchKeynotes()
        {
            _keynotes = await _library.KeynotesAsync((_store.Get("families.keyquery") ?? "").Trim(), _store.Get("families.keygroup") ?? "");
            Rebuild();
        }

        private async Task RequestKeynote()
        {
            var group = _store.Get("families.keygroup") ?? _keynotes?.Groups.FirstOrDefault() ?? "";
            var text = (_store.Get("families.keytext") ?? "").Trim();
            if (group.Length == 0 || text.Length == 0) { _keynoteMessages.Show(ChipKind.Warn, "Pick a group and describe the keynote."); _status("Pick a group and describe the keynote."); return; }
            var message = await _library.RequestKeynoteAsync(group, text);
            _keynoteMessages.Show(ChipKind.Good, message);
            _status(message);
        }

        public ICommand PlanCommand { get; }
        public ICommand BuildCommand { get; }
        public ICommand LoadTestCommand { get; }
        public FamilyPickSetting List => _list;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Scan file", ScanCommand, primary: true),
            new FooterAction("Bring in", BringInCommand),
            new FooterAction("Build", BuildCommand),
        };

        public override void Opened() { if (_specs == null) _ = LoadAsync(); }

        private List<string> Picked() => _list.Rows.Where(r => r.On).Select(r => r.Family).ToList();

        /// <summary>The kit's families; the person's last selection, or the pilot set the first time.</summary>
        public async Task LoadAsync()
        {
            if (_tools.Problem.Length > 0)
            {
                _list.Empty = _tools.Problem + " See Connect's health check.";
                _list.Changed();
                return;
            }
            _specs = await _tools.LoadSpecsAsync();
            if (_specs.Error.Length > 0)
            {
                _list.Empty = "Can't read the family specs: " + _specs.Error;
                _list.Changed();
                return;
            }
            var saved = _store.Get("families.selection");
            var on = new HashSet<string>(saved == null ? _specs.Pilot : saved.Split('|').Where(s => s.Length > 0));
            _list.Rows.Clear();
            foreach (var spec in _specs.Families)
                _list.Rows.Add(new FamilyPickRow(spec, on.Contains(spec.Family), SelectionChanged));
            _list.Empty = "The kit has no family specs.";
            _list.Changed();
            await Plan(quiet: true);
        }

        private void SelectionChanged()
        {
            _store.Set("families.selection", string.Join("|", Picked()));
            _list.Changed();
        }

        private void Pick(IEnumerable<string> families)
        {
            var on = new HashSet<string>(families);
            foreach (var r in _list.Rows) r.SetOn(on.Contains(r.Family));
            SelectionChanged();
        }

        private void Apply(ToolResult r)
        {
            foreach (var line in r.Lines)
                _list.Rows.FirstOrDefault(x => x.Family == line.Family)?.Apply(line);
        }

        /// <summary>fmc_family plan: every check against the kit, before Revit is touched.</summary>
        private async Task Plan(bool quiet)
        {
            if (_busy || _list.Rows.Count == 0) return;
            _busy = true;
            try
            {
                var r = await _tools.PlanAsync(_list.Rows.Select(x => x.Family).ToList());
                Apply(r);
                if (!quiet) _messages.Show(r.Messages);
            }
            finally { _busy = false; }
        }

        private async Task Build()
        {
            var names = Picked();
            if (names.Count == 0) { _messages.Show(ChipKind.Warn, "No families selected."); _status("No families selected."); return; }
            if (_busy) return;
            _busy = true;
            ToolResult dry;
            try
            {
                _status("Dry run…");
                dry = await _tools.BuildAsync(names, true, false, false, _status);
            }
            finally { _busy = false; }
            Apply(dry);
            _messages.Show(dry.Messages);
            if (!dry.Ok || dry.Count == 0) { _status("Nothing to build."); return; }

            bool staged = _list.Rows.Any(r => r.On && r.Status == "In staging");
            var form = new InMemoryUserSettings();
            var items = new List<SettingItem> { new ReadOnlySetting("Would build", string.Join(Environment.NewLine, dry.Details), mono: true) };
            if (staged) items.Add(new ToggleSetting(new SettingStore(form, ""), "overwrite", "Rebuild families already in staging", false,
                "The old file is replaced; Revit keeps its backups."));
            _status("Dry run done: " + dry.Count + " to build. Nothing has changed yet.");
            _ask(DialogViewModel.WithItems($"Build {dry.Count} families?",
                "Creates data-shell families in " + _tools.StagingRoot + "\\<Role>. Families with problems are skipped. Release stays with the Family Librarian.",
                items, $"Build {dry.Count}", async () =>
                {
                    bool oneByOne = (_store.Get("families.batch") ?? "All at once") == "One by one";
                    var r = await _tools.BuildAsync(names, false, form.Get("overwrite") == "true", oneByOne, _status);
                    Apply(r);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Build finished.");
                    return null;
                }));
        }

        private async Task LoadTest()
        {
            var names = Picked();
            if (names.Count == 0) { _messages.Show(ChipKind.Warn, "No families selected."); _status("No families selected."); return; }
            var dry = await _tools.LoadTestAsync(names, true);
            _messages.Show(dry.Messages);
            if (!dry.Ok || dry.Count == 0) return;
            _ask(DialogViewModel.WithItems($"Load test {dry.Count} families?",
                "Loads the staged families into the active chain-test project, places one of each type, flexes them, and checks connectors and parameters.",
                new SettingItem[] { new ReadOnlySetting("Would load and place", string.Join(Environment.NewLine, dry.Details), mono: true) },
                "Load test", async () =>
                {
                    var r = await _tools.LoadTestAsync(names, false);
                    Apply(r);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Load test finished.");
                    return null;
                }));
        }
    }

    /// <summary>A document row in Setup › Templates: its state and what can be done with it.</summary>
    public sealed class DocumentRow
    {
        public DocumentRow(OpenDocument doc, ICommand saveAs, ICommand close)
        {
            Doc = doc;
            SaveAsCommand = saveAs;
            CloseCommand = close;
        }

        public OpenDocument Doc { get; }
        public string Title => Doc.Title;
        public string State => (Doc.IsActive ? "Active · " : "") + (Doc.Live ? "Live project: AI reads, never models" : Doc.IsFamily ? "Family" : string.IsNullOrEmpty(Doc.Path) ? "New file" : "Library file")
                               + (Doc.IsWorkshared ? " · workshared" : "") + (Doc.IsModified ? " · unsaved changes" : "");
        public ChipKind Kind => Doc.Live ? ChipKind.Bad : ChipKind.Good;
        /// <summary>Workshared models are never saved by a tool (CLAUDE.md rule 6).</summary>
        public bool CanSaveAs => !Doc.IsWorkshared;
        /// <summary>The server never closes the active document.</summary>
        public bool CanClose => !Doc.IsActive;
        public ICommand SaveAsCommand { get; }
        public ICommand CloseCommand { get; }
    }

    public sealed class DocumentListSetting : SettingItem
    {
        public DocumentListSetting() : base("Open in Revit") { }
        public ObservableCollection<DocumentRow> Rows { get; } = new ObservableCollection<DocumentRow>();
        public bool IsEmpty => Rows.Count == 0;
        public void Changed() => OnPropertyChanged(nameof(IsEmpty));
    }

}
