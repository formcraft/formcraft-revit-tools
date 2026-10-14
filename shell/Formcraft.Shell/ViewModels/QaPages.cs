using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Check › QA (board manage/PaneQA, U16): run a gate's checks from the kit's rulebooks on the open model. Checking
    /// only reads, so it runs on live and shared models too. Results by severity, Zoom selects the failing elements,
    /// the trend counts new, recurring and resolved issues, and every run is saved as a report.
    /// </summary>
    public sealed class QaPage : SectionPage
    {
        public static readonly string[] Gates = { "WIP → Shared (Discipline Lead)", "Shared → Published (PIM)", "Weekly health" };
        public static readonly string[] GateKeys = { "wip_to_shared", "shared_to_published", "weekly" };
        public static readonly string[] ShowOptions = { "Fail", "Warning", "Not applicable", "Not checked", "All" };

        private readonly IQaTools _qa;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private QaRun? _run;
        private QaResult? _selected;

        public QaPage(IQaTools qa, ProjectPage project, IUserSettings settings, Action<string> status)
            : base("Check › QA", "Pass, fail, not applicable or not checked, with every problem one click away.")
        {
            _qa = qa;
            _project = project;
            _store = new SettingStore(settings);
            _status = status;
            RunCommand = new AsyncCommand(Run, status);
            ZoomCommand = new AsyncCommand(Zoom, status);
            Rebuild();
        }

        public ICommand RunCommand { get; }
        public ICommand ZoomCommand { get; }
        public QaRun? LastRun => _run;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Run QA", RunCommand, primary: true),
            new FooterAction("Zoom", ZoomCommand),
        };

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(new SettingsGroup("Run",
                new ChoiceSetting(_store, "qa.gate", "Gate", Gates, dropdown: true),
                new ButtonsSetting("", new[] { new SettingButton("Run QA", RunCommand, primary: true) },
                    "Checking only reads, so it runs on live and shared models too. The rules come from the kit's rulebooks."),
                _messages));
            if (_run != null)
            {
                Groups.Add(new SettingsGroup("Checks · " + _run.GateName,
                    new ReadOnlySetting(_run.Model, $"{_run.Ran} checks ran · {_run.Pass} pass · {_run.Fail} fail · {_run.Warning} warnings · {_run.NotApplicable} not applicable · {_run.NotChecked} not checked"),
                    new NoteSetting(_run.Summary, _run.Summary.StartsWith("No Must") ? ChipKind.Good : ChipKind.Bad)));
                Groups.Add(ResultsGroup(_run));
                if (_selected != null)
                    Groups.Add(new SettingsGroup("Selected · " + _selected.Id,
                        new ReadOnlySetting(_selected.Rule, _selected.Severity + " · " + _selected.State + (_selected.Where.Length > 0 ? " · " + _selected.Where : "")),
                        new ReadOnlySetting("Fix", _selected.FixHint.Length > 0 ? _selected.FixHint : "—"),
                        _selected.Excepted.Length > 0 ? (SettingItem)new NoteSetting(_selected.Excepted) : new ButtonsSetting("", new[]
                        {
                            new SettingButton("Zoom", ZoomCommand, primary: true),
                        }, _selected.ElementIds.Count > 0 ? "Selects the " + _selected.ElementIds.Count + " elements in Revit." : "No elements to select for this rule.")));
                Groups.Add(new SettingsGroup("Trend",
                    new ReadOnlySetting("This run", $"{_run.Trend.New} new · {_run.Trend.Recurring} recurring · {_run.Trend.Resolved} resolved"),
                    new TableSetting("", new[] { "Run", "Failing rules" }, _run.History.Select(h => new TableRow(h, h.At.Length >= 10 ? h.At.Substring(0, 10) : h.At, h.Failing.ToString())))));
                var fixes = _run.Results.Where(r => (r.State == "Fail" || r.State == "Warning") && r.FixHint.Length > 0).ToList();
                Groups.Add(new SettingsGroup("Safe fixes",
                    fixes.Count == 0 ? (SettingItem)new NoteSetting("Nothing to fix.", ChipKind.Good)
                        : new CheckListSetting(fixes.Select(r => new CheckRow(new HealthCheck(r.Id + " · " + r.Where, r.Severity, r.Kind, detail: r.FixHint), null))),
                    new NoteSetting("Only data fixes (names, empty values) will be offered, and only where the live-model lock allows; geometry is never touched. " +
                                    "Until a rule carries its fix in the kit, each result shows its fix hint.")));
                Groups.Add(new SettingsGroup("Report",
                    new ReadOnlySetting("Saved", _run.Report, mono: true),
                    new ButtonsSetting("", new[] { new SettingButton("Open the report", new RelayCommand(() => Open(_run.Report))) })));
            }
            Groups.Add(new SettingsGroup("Health alerts",
                new NoteSetting("Alerts, not a quality score: one missing Must rule matters more than 50 small warnings. Thresholds (warnings, in-place " +
                                "families) are rules in the kit's QA rulebook (max_count), so they show in the results with the rest.")));
            Groups.Add(new SettingsGroup("Explain · Phase 2",
                new NoteSetting("A plain-language summary of the results from your AI provider arrives with the AI buttons in Phase 2.")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "qa.considerations", _status)));
        }

        private SettingsGroup ResultsGroup(QaRun run)
        {
            var show = _store.Get("qa.show") ?? ShowOptions[0];
            var rows = run.Results.Where(r => show == "All" || r.State == show);
            var table = new TableSetting("", new[] { "Rule", "What", "Sev.", "Where" }, rows.Select(r => new TableRow(r, r.Id, r.Rule, r.Severity, r.Where)), selectable: true,
                hint: "Click a row, then Zoom: the failing elements are selected.");
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is QaResult r) { _selected = r; Rebuild(); }
            };
            return new SettingsGroup("Results", new ChoiceSetting(_store, "qa.show", "Show", ShowOptions, changed: _ => Rebuild()), table);
        }

        /// <summary>Opens a result's details as if it was clicked in the table.</summary>
        public void Select(string id)
        {
            _selected = _run?.Results.FirstOrDefault(r => r.Id == id);
            Rebuild();
        }

        private async Task Run()
        {
            var gate = GateKeys[Math.Max(0, Array.IndexOf(Gates, _store.Get("qa.gate") ?? Gates[0]))];
            _status("Running QA…");
            var r = await _qa.RunAsync(gate, _project.Request().Folder);
            _messages.Show(r.Ok ? ChipKind.Info : ChipKind.Bad, r.Message);
            _status(r.Message);
            if (r.Ok) { _run = r; _selected = null; }
            Rebuild();
        }

        private async Task Zoom()
        {
            if (_selected == null || _selected.ElementIds.Count == 0) { _messages.Show(ChipKind.Warn, "Click a result with elements first."); _status("Click a result with elements first."); return; }
            _status(await _qa.SelectAsync(_selected.ElementIds));
        }

        private void Open(string path)
        {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Environment.ExpandEnvironmentVariables(path)) { UseShellExecute = true }); }
            catch (Exception e) { _status("Couldn't open the report: " + e.Message); }
        }
    }

    /// <summary>
    /// Check › Rules (board manage/PaneRules, U16): every rule in the kit's rulebooks with its severity, scope, test,
    /// fix and history; the exceptions in force and the decisions. Rules change through the kit: approving a proposed
    /// rule (BIM Manager) and change requests are recorded for the BIM Manager, never written into the kit by a tool.
    /// </summary>
    public sealed class RulesPage : SectionPage
    {
        public static readonly string[] Severities = { "All", "Must", "Should", "Advice" };
        public static readonly string[] Sources = { "All", "From standards", "Proposed", "Plugin" };

        private readonly IQaTools _qa;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Func<bool> _isAdmin;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private RulebookSet? _books;
        private RuleInfo? _selected;

        public RulesPage(IQaTools qa, IUserSettings settings, Func<bool> isAdmin, Action<string> status, Action<DialogViewModel> ask)
            : base("Check › Rules", "Every rule with its severity, scope, test, fix and history. Rules come from the kit.")
        {
            _qa = qa;
            _store = new SettingStore(settings);
            _isAdmin = isAdmin;
            _status = status;
            _ask = ask;
            ApproveCommand = new RelayCommand(AskApprove);
            ChangeCommand = new RelayCommand(AskChange);
            Rebuild();
        }

        public ICommand ApproveCommand { get; }
        public ICommand ChangeCommand { get; }
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Change request", ChangeCommand, primary: true),
            new FooterAction("Approve", ApproveCommand),
        };

        public override void Opened() { if (_books == null) _ = Load(); }

        public async Task Load()
        {
            _books = await _qa.RulesAsync();
            Rebuild();
        }

        public IEnumerable<RuleInfo> Filtered()
        {
            if (_books == null) return Enumerable.Empty<RuleInfo>();
            var book = (_store.Get("rules.book") ?? "All").Split(new[] { " (" }, StringSplitOptions.None)[0];
            var severity = _store.Get("rules.severity") ?? "All";
            var source = _store.Get("rules.source") ?? "All";
            var query = (_store.Get("rules.query") ?? "").Trim();
            return _books.Rules.Where(r => (book == "All" || r.Book == book) && (severity == "All" || r.Severity == severity)
                && (source == "All" || (source == "From standards" ? r.Status == "Standard" : r.Status == source))
                && (query.Length == 0 || r.Id.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || r.Rule.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0));
        }

        public void Rebuild()
        {
            Groups.Clear();
            if (_books == null)
            {
                Groups.Add(new SettingsGroup("Rulebooks", new NoteSetting("Reading the kit's rulebooks…")));
                return;
            }
            var books = new[] { "All" }.Concat(_books.Books.Select(b => $"{b.Name} ({b.Count})")).ToArray();
            Groups.Add(new SettingsGroup("Browse",
                new ChoiceSetting(_store, "rules.book", "Rulebook", books, dropdown: true, changed: _ => Rebuild()),
                new ChoiceSetting(_store, "rules.severity", "Severity", Severities, changed: _ => Rebuild()),
                new ChoiceSetting(_store, "rules.source", "Source", Sources, changed: _ => Rebuild()),
                new TextSetting("Search rules", "", "ID or words", store: _store, key: "rules.query"),
                new ButtonsSetting("", new[] { new SettingButton("Search", new RelayCommand(Rebuild)) })));
            if (_books.Problems.Count > 0)
                Groups.Add(new SettingsGroup("Rulebook problems", new NoteSetting(string.Join("\n", _books.Problems), ChipKind.Warn)));

            var table = new TableSetting("", new[] { "ID", "Rule", "Sev.", "Status" }, Filtered().Select(r => new TableRow(r, r.Id, r.Rule, r.Severity, r.Status)), selectable: true);
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is RuleInfo r) { _selected = r; Rebuild(); }
            };
            Groups.Add(new SettingsGroup("Rules", table, _messages));
            if (_selected != null)
            {
                var items = new List<SettingItem>
                {
                    new ReadOnlySetting("Rule", _selected.Rule), new ReadOnlySetting("Severity", _selected.Severity),
                    new ReadOnlySetting("Scope", Dash(_selected.Scope)), new ReadOnlySetting("Test", Dash(_selected.Test)),
                    new ReadOnlySetting("Fix hint", Dash(_selected.FixHint)), new ReadOnlySetting("Version", Dash(_selected.Version)),
                    new ReadOnlySetting("Why it exists", Dash(_selected.Why)),
                };
                var buttons = new List<SettingButton> { new SettingButton("Change request", ChangeCommand) };
                if (_selected.Status == "Proposed" && _isAdmin()) buttons.Insert(0, new SettingButton("Approve (BIM Manager)", ApproveCommand, primary: true));
                items.Add(new ButtonsSetting("", buttons, _selected.Status == "Proposed" ? "Approving turns a proposed rule on; the impact report comes first." : ""));
                Groups.Add(new SettingsGroup("Selected rule · " + _selected.Id, items.ToArray()));
            }
            Groups.Add(new SettingsGroup("Exceptions in force",
                _books.Exceptions.Count == 0 ? (SettingItem)new NoteSetting("No exceptions.")
                    : new TableSetting("", new[] { "Rule", "Where", "Approved", "Until" }, _books.Exceptions.Select(x => new TableRow(x, x.Rule, x.Where, x.ApprovedBy, x.Until))),
                new NoteSetting("Every exception has an approver, a reason and an end.")));
            Groups.Add(new SettingsGroup("Decisions",
                _books.Decisions.Count == 0 ? (SettingItem)new NoteSetting("No decisions listed in the rulebooks.")
                    : new CheckListSetting(_books.Decisions.Select(d => new CheckRow(new HealthCheck(d.Text, d.State, d.State == "decided" ? ChipKind.Good : ChipKind.Warn), null))),
                new NoteSetting("Change the standard first: to change a rule that comes from your Manual, change the Manual through the change process; the rulebook follows.")));
        }

        /// <summary>Opens a rule's details as if it was clicked in the table.</summary>
        public void Select(string id)
        {
            _selected = _books?.Rules.FirstOrDefault(r => r.Id == id);
            Rebuild();
        }

        private static string Dash(string s) => s.Length > 0 ? s : "—";

        private void AskApprove()
        {
            if (_selected == null || _selected.Status != "Proposed") { _messages.Show(ChipKind.Warn, "Pick a proposed rule to approve."); _status("Pick a proposed rule to approve."); return; }
            if (!_isAdmin()) { _messages.Show(ChipKind.Warn, "Only the BIM Manager approves rules."); _status("Only the BIM Manager approves rules."); return; }
            var form = new InMemoryUserSettings();
            var store = new SettingStore(form, "");
            var severity = new ChoiceSetting(store, "severity", "Severity", new[] { "Should", "Must", "Advice" }, Math.Max(0, Array.IndexOf(new[] { "Should", "Must", "Advice" }, _selected.Severity)));
            var comment = new TextSetting("Comment", "", store: store, key: "comment");
            var rule = _selected;
            _ask(DialogViewModel.WithItems("Approve a proposed rule", rule.Id + " · " + rule.Rule,
                new SettingItem[] { severity, comment, new NoteSetting("The impact report lists the checks and projects this rule will touch.") }, "Approve rule", async () =>
                {
                    var m = await _qa.RequestAsync(rule.Id, "approve", form.Get("comment") ?? "", severity.Selected);
                    _messages.Show(ChipKind.Good, m);
                    _status(m);
                    return null;
                }));
        }

        private void AskChange()
        {
            if (_selected == null) { _messages.Show(ChipKind.Warn, "Pick a rule first."); _status("Pick a rule first."); return; }
            var form = new InMemoryUserSettings();
            var store = new SettingStore(form, "");
            var wording = new TextSetting("Proposed wording", _selected.Rule, store: store, key: "wording");
            var why = new TextSetting("Why", "", store: store, key: "why");
            var rule = _selected;
            _ask(DialogViewModel.WithItems("Change request", rule.Id + " · " + rule.Rule, new SettingItem[] { wording, why }, "Send change request", async () =>
            {
                if ((form.Get("why") ?? "").Trim().Length == 0) return "Say why in a line.";
                var m = await _qa.RequestAsync(rule.Id, "change", (form.Get("wording") ?? rule.Rule) + " · because " + form.Get("why"), "");
                _messages.Show(ChipKind.Good, m);
                _status(m);
                return null;
            }));
        }
    }
}
