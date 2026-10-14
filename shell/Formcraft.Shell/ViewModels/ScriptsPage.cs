using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Check › Scripts (boards model/PaneScripts and model/M_Automation, U24). The script library is the kit's 05_Scripts,
    /// read from each file's own header; Formcraft lists them and says where they run, and doesn't run them itself (they
    /// pass the Manual 17 release gate in pyRevit or Dynamo). Automations are Formcraft's own checks and its report in a
    /// row, run by hand, stopping at the first step that fails; none changes the model.
    /// </summary>
    public sealed class ScriptsPage : SectionPage
    {
        public static readonly string[] Filters = { "All", "Changes the model", "Reads only" };
        private const string AutomationsKey = "scripts.automations";

        private readonly IScriptTools _tools;
        private readonly ProjectPage _project;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly MessagesSetting _runLines = new MessagesSetting();
        private List<ScriptInfo> _scripts = new List<ScriptInfo>();
        private string _listMessage = "";
        private ScriptInfo? _selected;

        public ScriptsPage(IScriptTools tools, ProjectPage project, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Check › Scripts", "The kit's scripts, and automations: Formcraft's own checks in a row.")
        {
            _tools = tools;
            _project = project;
            _settings = settings;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            RefreshCommand = new AsyncCommand(Load, status);
            RunCommand = new AsyncCommand(AskRun, status);
            NewAutomationCommand = new RelayCommand(AskNew);
            DeleteAutomationCommand = new RelayCommand(AskDelete);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand RunCommand { get; }
        public ICommand NewAutomationCommand { get; }
        public ICommand DeleteAutomationCommand { get; }
        public MessagesSetting RunLines => _runLines;
        public IReadOnlyList<ScriptInfo> Scripts => _scripts;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("New automation…", NewAutomationCommand),
            new FooterAction("Run", RunCommand, primary: true),
        };

        public override void Opened() => _ = Load();

        private string Kit => _settings.Get(SettingKeys.KitFolder) ?? "";

        /// <summary>The person's automations (the defaults until they change them).</summary>
        public List<Automation> Automations
        {
            get
            {
                var saved = _store.Get(AutomationsKey);
                if (saved == null) return AutomationSteps.Defaults.Select(a => new Automation(a.Name, a.Steps.ToArray())).ToList();
                return saved.Split('\n').Select(line => line.Split('\t')).Where(p => p.Length == 2 && p[0].Length > 0)
                    .Select(p => new Automation(p[0], p[1].Split(',').Where(s => s.Length > 0).ToArray())).ToList();
            }
        }

        private void Save(IEnumerable<Automation> list) =>
            _store.Set(AutomationsKey, string.Join("\n", list.Select(a => a.Name + "\t" + string.Join(",", a.Steps))));

        public Automation? Chosen
        {
            get
            {
                var list = Automations;
                var name = _store.Get("scripts.automation");
                return list.FirstOrDefault(a => a.Name == name) ?? list.FirstOrDefault();
            }
        }

        public void Rebuild()
        {
            Groups.Clear();
            var filter = _store.Get("scripts.filter") ?? Filters[0];
            var shown = _scripts.Where(s => filter == Filters[0] || (filter == Filters[1]) == s.ChangesModel).ToList();
            var library = new List<SettingItem>
            {
                new ChoiceSetting(_store, "scripts.filter", "Show", Filters, changed: _ => Rebuild()),
            };
            if (_scripts.Count == 0)
                library.Add(new NoteSetting(_listMessage.Length > 0 ? _listMessage : "Reading the kit's 05_Scripts…", _listMessage.Length > 0 ? ChipKind.Warn : ChipKind.Grey));
            else
            {
                var table = new TableSetting("", new[] { "Script", "Type", "Changes", "Status" },
                    shown.Select(s => new TableRow(s, s.Name, s.Type, s.ChangesModel ? "Model" : "Reads", s.Status)), selectable: true,
                    hint: "Click a script to see its details below.");
                if (_selected != null) table.Selected = table.Rows.FirstOrDefault(r => r.Tag == _selected);
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is ScriptInfo s) || s == _selected) return;
                    _selected = s;
                    Rebuild();
                };
                library.Add(table);
                library.Add(new NoteSetting("From each file's own header: the kit has no script register, so the status is the file's own status line.", ChipKind.Grey));
            }
            library.Add(new ButtonsSetting("", new[] { new SettingButton("Refresh", RefreshCommand) }));
            Groups.Add(new SettingsGroup("Script library", library.ToArray()));

            if (_selected != null)
            {
                var s = _selected;
                var items = new List<SettingItem>
                {
                    new ReadOnlySetting("Does", s.Does),
                    new ReadOnlySetting("Runs in", s.RunsIn),
                    new ReadOnlySetting("Status", s.Status),
                    new ReadOnlySetting("Changes the model", s.ChangesModel ? "Yes: one transaction, and only after its pilot test" : "No, it reads only"),
                };
                if (s.Manual.Length > 0) items.Add(new ReadOnlySetting("Manual", s.Manual));
                if (s.Inputs.Count > 0) items.Add(new ReadOnlySetting("Inputs", string.Join(Environment.NewLine, s.Inputs), mono: true));
                if (s.Formcraft.Length > 0) items.Add(new NoteSetting("Formcraft does this in " + s.Formcraft + ", with a dry run in the pane.", ChipKind.Info));
                items.Add(new NoteSetting("Formcraft doesn't run kit scripts: run it where it lives once its pilot test has passed (Manual 17).", ChipKind.Grey));
                Groups.Add(new SettingsGroup("Selected · " + s.Name, items.ToArray()));
            }

            var autos = Automations;
            var chosen = Chosen;
            Groups.Add(new SettingsGroup("Automations · checks in a row",
                new TableSetting("", new[] { "Automation", "Steps", "Runs" },
                    autos.Select(a => new TableRow(a, a.Name, string.Join(" → ", a.Steps.Select(AutomationSteps.Title)), "By hand"))),
                autos.Count == 0 ? (SettingItem)new NoteSetting("No automations: add one.")
                    : new ChoiceSetting(_store, "scripts.automation", "Automation", autos.Select(a => a.Name).ToList(), Math.Max(0, autos.IndexOf(chosen!)), dropdown: true),
                new ButtonsSetting("", new[]
                {
                    new SettingButton("New automation…", NewAutomationCommand),
                    new SettingButton("Delete", DeleteAutomationCommand),
                    new SettingButton("Run", RunCommand, primary: true),
                }),
                new NoteSetting("Each step stops the chain if it fails. Steps read the model or write Formcraft's own reports; none changes the model. " +
                                "Runs on a schedule, when a model opens or before a sync come later.", ChipKind.Grey),
                _runLines));
            Groups.Add(new SettingsGroup("Script rules · every script must pass to be approved (MAN 17.2)",
                new NoteSetting("Has a dry-run input, and the first run is a dry run. Model changes in one transaction (one Undo). Writes a CSV log: what, before, after. " +
                                "Fails loudly, never skips silently. Writes only fields the master data owns, never geometry. Versioned in Git, with the version in the BEP. " +
                                "Re-tested on the pilot model after each Revit or Dynamo upgrade.", ChipKind.Info)));
            Groups.Add(new SettingsGroup("Add a script",
                new NoteSetting("Scripts are kit data: add them to the kit's 05_Scripts through the kit's change process (rule 7), and they show here from their header. " +
                                "New scripts start as pilot tests; the BIM Manager approves them. Model-changing scripts never run on live projects.", ChipKind.Warn),
                _messages));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "scripts.considerations", _status)));
        }

        private async Task Load()
        {
            if (Kit.Length == 0) { _listMessage = "Set the kit folder in Settings › General first."; Rebuild(); return; }
            var r = await _tools.ListAsync(Kit);
            _scripts = r.Ok ? r.Scripts : new List<ScriptInfo>();
            _listMessage = r.Ok ? "" : r.Message;
            _selected = _scripts.FirstOrDefault(s => s.Name == _selected?.Name);
            Rebuild();
        }

        private Task AskRun()
        {
            var a = Chosen;
            if (a == null || a.Steps.Count == 0) { _status("Choose an automation with at least one step."); return Task.CompletedTask; }
            var p = _project.Request();
            if (p.Folder.Length == 0 && a.Steps.Any(s => s == "review" || s == "report"))
            {
                _runLines.Show(ChipKind.Warn, "Set the project folder in Setup › Project: the review and report steps read it.");
                _status("Set the project folder in Setup › Project first.");
                return Task.CompletedTask;
            }
            _ask(DialogViewModel.WithItems("Run: " + a.Name, "In this order; it stops at the first step that fails. Nothing changes the model.",
                new SettingItem[] { new ReadOnlySetting("Steps", string.Join(Environment.NewLine, a.Steps.Select((s, i) => (i + 1) + ". " + AutomationSteps.Title(s))), mono: true) },
                "Run", async () =>
                {
                    var r = await _tools.RunAsync(a, Kit, p.Folder, p.Code);
                    var lines = r.Steps.Select(s => new ToolMessage(s.Ok ? ChipKind.Good : ChipKind.Bad, s.Title + ": " + s.Summary)).ToList();
                    lines.AddRange(r.Skipped.Select(s => new ToolMessage(ChipKind.Grey, s + ": didn't run")));
                    if (r.Steps.Count == 0) lines.Add(new ToolMessage(ChipKind.Bad, r.Message));
                    _runLines.Show(lines);
                    _status(a.Name + ": " + r.Message);
                    return null;
                }));
            return Task.CompletedTask;
        }

        private void AskNew()
        {
            var name = new TextSetting("Name", "", "e.g. Before Ready to issue");
            _store.Set("scripts.new.steps", null);
            var steps = new MultiSetting(_store, "scripts.new.steps", "Steps, in this order", AutomationSteps.All.Select(s => s.Title).ToList(), new string[0], asChecks: true);
            _ask(DialogViewModel.WithItems("New automation", "Formcraft's own checks and its report, run by hand in the order shown.",
                new SettingItem[] { name, steps }, "Add", () =>
                {
                    var n = name.Value.Trim();
                    var chosen = steps.On.Select(AutomationSteps.Id).ToArray();
                    if (n.Length == 0) return Task.FromResult<string?>("Give it a name.");
                    if (chosen.Length == 0) return Task.FromResult<string?>("Tick at least one step.");
                    var list = Automations;
                    if (list.Any(x => string.Equals(x.Name, n, StringComparison.OrdinalIgnoreCase))) return Task.FromResult<string?>("There is one with that name already.");
                    list.Add(new Automation(n, chosen));
                    Save(list);
                    _store.Set("scripts.automation", n);
                    Rebuild();
                    _status("Automation added: " + n + ".");
                    return Task.FromResult<string?>(null);
                }));
        }

        private void AskDelete()
        {
            var a = Chosen;
            if (a == null) return;
            _ask(new DialogViewModel("Delete " + a.Name + "?", "Only the automation goes; its steps are Formcraft's own tools.", "Delete", () =>
            {
                Save(Automations.Where(x => x.Name != a.Name));
                _store.Set("scripts.automation", null);
                Rebuild();
                _status("Automation deleted: " + a.Name + ".");
                return Task.CompletedTask;
            }));
        }
    }
}
