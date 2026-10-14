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
    /// Setup › Families (board manage/PaneFamilies, U15 in progress): the family builder from the kit. Plan checks every
    /// family before Revit is touched; Build and Load test always run a dry run first and ask (CLAUDE.md rule 3).
    /// </summary>
    public sealed class FamiliesPage : SectionPage
    {
        private readonly IFamilyTools _tools;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly FamilyPickSetting _list = new FamilyPickSetting();
        private readonly MessagesSetting _messages = new MessagesSetting();
        private FamilySpecs? _specs;
        private bool _busy;

        public FamiliesPage(IFamilyTools tools, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Setup › Families", "Families built from the kit land in staging; release to the library stays with the Family Librarian.")
        {
            _tools = tools;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            PlanCommand = new AsyncCommand(() => Plan(quiet: false), status);
            BuildCommand = new AsyncCommand(Build, status);
            LoadTestCommand = new AsyncCommand(LoadTest, status);

            Groups.Add(new SettingsGroup("Build from the kit",
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
                _messages));
            Groups.Add(new SettingsGroup("Compliance, bring in, parameters and keynotes",
                new NoteSetting("The compliance scan of the families in a file, bringing in a family from outside, shared parameters and keynotes " +
                                "come with the rest of this section (U15, board manage/PaneFamilies).")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "families.considerations", status)));
        }

        public ICommand PlanCommand { get; }
        public ICommand BuildCommand { get; }
        public ICommand LoadTestCommand { get; }
        public FamilyPickSetting List => _list;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Build", BuildCommand, primary: true),
            new FooterAction("Plan", PlanCommand),
            new FooterAction("Load test", LoadTestCommand),
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
            if (names.Count == 0) { _messages.Show(ChipKind.Warn, "No families selected."); return; }
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
            if (names.Count == 0) { _messages.Show(ChipKind.Warn, "No families selected."); return; }
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
