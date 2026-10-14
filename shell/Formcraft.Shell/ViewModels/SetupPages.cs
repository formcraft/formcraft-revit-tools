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
        public string State => (Doc.IsActive ? "Active · " : "") + (Doc.Live ? "Live project: Claude reads, never models" : Doc.IsFamily ? "Family" : string.IsNullOrEmpty(Doc.Path) ? "New file" : "Library file")
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

    /// <summary>
    /// Setup › Templates (board manage/PaneTemplates, U14 in progress): new files from a template, and the files open in
    /// Revit (save as, close, archive). Every action is fmc_file: a dry run, a yes, then the real run.
    /// </summary>
    public sealed class TemplatesPage : SectionPage
    {
        public static readonly string[] Kinds = { "Project model", "Family", "Template" };

        private readonly IFileTools _files;
        private readonly IFilePicker _picker;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly DocumentListSetting _docs = new DocumentListSetting();
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly TextSetting _template;
        private readonly TextSetting _saveTo;

        public TemplatesPage(IFileTools files, IFilePicker picker, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Setup › Templates", "New files from a template, and the files open in Revit. Writes go only to WIP and staging folders.")
        {
            _files = files;
            _picker = picker;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _template = new TextSetting("Template", "", "Choose a .rte or .rft", store: _store, key: "templates.template", mono: true);
            _saveTo = new TextSetting("Save in", "", "Choose where the new file goes", store: _store, key: "templates.saveto", mono: true,
                hint: "Models: [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt · templates FMC_<Role>_Template_v2.2.rte. The server rejects any other name.");
            NewFileCommand = new AsyncCommand(NewFile, status);
            ArchiveCommand = new AsyncCommand(Archive, status);

            Groups.Add(new SettingsGroup("New file from a template",
                new ChoiceSetting(_store, "templates.kind", "Make a", Kinds),
                _template,
                new ButtonsSetting("", new[] { new SettingButton("Browse…", new RelayCommand(BrowseTemplate)) }),
                _saveTo,
                new ButtonsSetting("", new[] { new SettingButton("Browse…", new RelayCommand(BrowseSave)) }),
                new ToggleSetting(_store, "templates.closeafter", "Close the new file after saving", true),
                new ButtonsSetting("", new[] { new SettingButton("New file", NewFileCommand, primary: true) }, "Made in a dry run first; nothing is overwritten without a second yes.")));
            Groups.Add(new SettingsGroup("Files open in Revit",
                _docs,
                new ButtonsSetting("", new[] { new SettingButton("Archive a closed file…", ArchiveCommand) }),
                new NoteSetting("Nothing is deleted: Archive moves a file and its backups to _Archive. Workshared models are never saved by a tool."),
                _messages));
            Groups.Add(new SettingsGroup("Brand pack, audit, builds and the template library",
                new NoteSetting("Firm look, template audit, template builds and the template library come with the rest of this section (U14, board manage/PaneTemplates).")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "templates.considerations", status)));

            _files.Changed += (_, __) => ShowDocuments();
            ShowDocuments();
        }

        public ICommand NewFileCommand { get; }
        public ICommand ArchiveCommand { get; }
        public DocumentListSetting Documents => _docs;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[] { new FooterAction("New file", NewFileCommand, primary: true) };

        private string Kind => (_store.Get("templates.kind") ?? Kinds[0]) switch { "Family" => "family", "Template" => "template", _ => "project" };

        public void ShowDocuments()
        {
            _docs.Rows.Clear();
            foreach (var d in _files.Documents)
                _docs.Rows.Add(new DocumentRow(d, new AsyncCommand(() => SaveAs(d), _status), new AsyncCommand(() => Close(d), _status)));
            _docs.Changed();
        }

        private void BrowseTemplate()
        {
            var path = _picker.Open("Choose a template", Kind == "family" ? "Family templates (*.rft)|*.rft" : "Templates (*.rte)|*.rte", _files.StartFolder);
            if (path != null) _template.Value = path;
        }

        private void BrowseSave()
        {
            string ext = Kind == "family" ? ".rfa" : Kind == "template" ? ".rte" : ".rvt";
            var path = _picker.Save("Save the new file as", "Revit file (*" + ext + ")|*" + ext, "", _files.StartFolder);
            if (path != null) _saveTo.Value = path;
        }

        private Task NewFile()
        {
            if (_template.Value.Trim().Length == 0 || _saveTo.Value.Trim().Length == 0)
            {
                _messages.Show(ChipKind.Warn, "Choose a template and where to save the new file.");
                return Task.CompletedTask;
            }
            return Run(new FileRequest
            {
                Action = "create_from_template", Kind = Kind, TemplatePath = _template.Value.Trim(), SavePath = _saveTo.Value.Trim(),
                CloseAfter = (_store.Get("templates.closeafter") ?? "true") == "true",
            }, "Create " + System.IO.Path.GetFileName(_saveTo.Value.Trim()) + "?", "Create");
        }

        private Task SaveAs(OpenDocument doc)
        {
            string ext = doc.IsFamily ? ".rfa" : doc.Path.EndsWith(".rte", StringComparison.OrdinalIgnoreCase) ? ".rte" : ".rvt";
            var path = _picker.Save("Save " + doc.Title + " as", "Revit file (*" + ext + ")|*" + ext,
                System.IO.Path.GetFileNameWithoutExtension(doc.Title) + ext, _files.StartFolder);
            if (path == null) return Task.CompletedTask;
            return Run(new FileRequest { Action = "save_as", Document = doc.Reference, SavePath = path },
                "Save " + doc.Title + " as " + System.IO.Path.GetFileName(path) + "?", "Save");
        }

        private Task Close(OpenDocument doc)
        {
            if (!doc.IsModified) return Run(new FileRequest { Action = "close", Document = doc.Reference }, null, null);
            var form = new InMemoryUserSettings();
            var options = doc.IsWorkshared || string.IsNullOrEmpty(doc.Path) ? new[] { "Close without saving" } : new[] { "Close without saving", "Save and close" };
            var choice = new ChoiceSetting(new SettingStore(form, ""), "how", "It has unsaved changes", options);
            _ask(DialogViewModel.WithItems("Close " + doc.Title + "?", "", new SettingItem[] { choice }, "Close", async () =>
            {
                await Run(new FileRequest { Action = "close", Document = doc.Reference, Save = choice.Selected == "Save and close" }, null, null);
                return null;
            }));
            return Task.CompletedTask;
        }

        private Task Archive()
        {
            var path = _picker.Open("Archive a closed file (moves it and its backups to _Archive)", "Revit files (*.rvt;*.rfa;*.rte)|*.rvt;*.rfa;*.rte", _files.StartFolder);
            if (path == null) return Task.CompletedTask;
            return Run(new FileRequest { Action = "archive", Path = path }, "Archive " + System.IO.Path.GetFileName(path) + "?", "Archive");
        }

        /// <summary>
        /// fmc_file the way Claude must use it: a dry run; an existing target asks for a second yes; then the question
        /// (none for closing a file the person already chose to close), then the real run.
        /// </summary>
        public async Task Run(FileRequest request, string? confirmTitle, string? confirmLabel)
        {
            _status("Dry run…");
            var dry = await _files.RunAsync(request, true);
            if (!dry.Ok && dry.NeedsOverwrite)
            {
                _ask(DialogViewModel.WithItems("Replace the existing file?", request.SavePath,
                    new SettingItem[] { new NoteSetting("The file already exists. Replacing it needs a second yes.", ChipKind.Warn) }, "Replace", async () =>
                    {
                        request.Overwrite = true;
                        await Run(request, confirmTitle, confirmLabel);
                        return null;
                    }));
                return;
            }
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            if (confirmTitle == null) { await RunForReal(request); return; }
            _status("Dry run passed. Nothing has changed yet.");
            _ask(DialogViewModel.WithItems(confirmTitle, "The dry run passed the folder rules and name checks. Run it for real?",
                new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, confirmLabel ?? "Run",
                async () => { await RunForReal(request); return null; }));
        }

        private async Task RunForReal(FileRequest request)
        {
            _status("Working in Revit…");
            var r = await _files.RunAsync(request, false);
            _messages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
            ShowDocuments();
        }
    }
}
