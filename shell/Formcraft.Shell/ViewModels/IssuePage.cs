using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Drawings › Issue (board manage/PaneIssue, U19): one check before anything leaves the office. Every sheet of the
    /// issue set against the register, its title block, approval and status, the Must rules, links and the codes; the
    /// result is Ready, Ready with exceptions, or Blocked. Exceptions are recorded with who approved them. The issue
    /// writes PDFs, the register and a transmittal into 01_WIP\_Issue after a dry run; a person publishes it.
    /// </summary>
    public sealed class IssuePage : SectionPage
    {
        public static readonly string[] Purposes = { "For construction", "For approval", "For information", "For tender", "For permit" };
        public static readonly string[] Outputs = { "PDF per sheet, named by container name", "Drawing register (CSV)", "Transmittal sheet" };

        private readonly IIssueTools _tools;
        private readonly IQaTools _select;
        private readonly ProjectPage _project;
        private readonly Func<string> _register;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private IssueReadiness? _check;
        private IReadOnlyList<long> _zoom = new long[0];

        public IssuePage(IIssueTools tools, IQaTools select, ProjectPage project, Func<string> register, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Drawings › Issue", "One check before anything leaves the office: ready, ready with exceptions, or blocked.")
        {
            _tools = tools;
            _select = select;
            _project = project;
            _register = register;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            CheckCommand = new AsyncCommand(Check, status);
            ReportCommand = new AsyncCommand(Report, status);
            IssueCommand = new AsyncCommand(Issue, status);
            ZoomCommand = new AsyncCommand(Zoom, status);
            ExceptCommand = new RelayCommand(AskException);
            Rebuild();
        }

        public ICommand CheckCommand { get; }
        public ICommand ReportCommand { get; }
        public ICommand IssueCommand { get; }
        public ICommand ZoomCommand { get; }
        public ICommand ExceptCommand { get; }
        public IssueReadiness? LastCheck => _check;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Run check", CheckCommand, primary: true),
            new FooterAction("Report", ReportCommand),
            new FooterAction("Issue…", IssueCommand),
        };

        public override void Opened() => Rebuild();

        public IssueRequest Request()
        {
            var p = _project.Request();
            var outputs = (_store.Get("issue.outputs") is string o ? o.Split('|') : Outputs).ToList();
            return new IssueRequest
            {
                Register = _register(), ProjectFolder = p.Folder, Code = p.Code, Originator = p.Originator,
                IssueSet = _store.Get("issue.set") ?? (p.IssueSet.Length > 0 ? p.IssueSet : "CONSTRUCTION"),
                Disciplines = (_store.Get("issue.disciplines") is string d ? d.Split('|') : p.Roles.ToArray()).Where(x => x.Length > 0).ToList(),
                Purpose = _store.Get("issue.purpose") ?? Purposes[0],
                CompanyRevision = (_store.Get("issue.revision") ?? "").Trim().ToUpperInvariant(),
                SendTo = (_store.Get("issue.sendto") ?? "").Trim(),
                Pdf = outputs.Contains(Outputs[0]), RegisterCsv = outputs.Contains(Outputs[1]), Transmittal = outputs.Contains(Outputs[2]),
            };
        }

        public void Rebuild()
        {
            Groups.Clear();
            var q = Request();
            var p = _project.Request();
            Groups.Add(new SettingsGroup("This issue",
                new ChoiceSetting(_store, "issue.set", "Issue set", ProjectPage.IssueSets, Math.Max(0, Array.IndexOf(ProjectPage.IssueSets, p.IssueSet.Length > 0 ? p.IssueSet : "CONSTRUCTION"))),
                new ChoiceSetting(_store, "issue.purpose", "Purpose", Purposes, dropdown: true),
                new TextSetting("Company revision", q.CompanyRevision, "e.g. C02", "P01 preliminary, C01 contract, A01 as built (MAN 4.4).", _store, "issue.revision", mono: true),
                new ReadOnlySetting("Revit revision", _check?.RevitRevision ?? "Run the check to read it", hint: "Read from the model. Marking it issued stays a step you take in Revit."),
                new MultiSetting(_store, "issue.disciplines", "Disciplines", ProjectPage.Roles, p.Roles),
                new NoteSetting("Five separate fields, never merged: company revision, Revit revision, sheet status, purpose, approval.", ChipKind.Grey)));

            var result = new List<SettingItem>();
            if (_check == null) result.Add(new NoteSetting("Run the check to see whether this issue can go out."));
            else
            {
                result.Add(new NoteSetting(_check.Result + ". " + _check.Summary, _check.Kind));
                result.Add(new ReadOnlySetting("Checked against", _check.CheckedAgainst));
            }
            result.Add(new ReadOnlySetting("Register", q.Register.Length > 0 ? q.Register : "Set it in Drawings › Sheets", mono: true));
            result.Add(_messages);
            Groups.Add(new SettingsGroup("Result", result.ToArray()));

            if (_check != null)
            {
                Groups.Add(new SettingsGroup("Checklist",
                    new TableSetting("", new[] { "Check", "State", "Detail" }, _check.Checks.Select(c => new TableRow(c, c.Check, c.State, c.Detail)))));
                var sheets = new TableSetting("", new[] { "Sheet", "Name", "Status" }, _check.Sheets.Select(s => new TableRow(s, s.Number, s.Name, s.Status)), selectable: true,
                    hint: "Click a row to see why, then Zoom to select the sheet.");
                sheets.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName != nameof(TableSetting.Selected) || !(sheets.Selected?.Tag is IssueSheetLine s)) return;
                    _zoom = s.Ids;
                    var why = s.Reasons.Concat(s.Excepted.Select(x => "excepted · " + x)).ToList();
                    _status(s.Number + ": " + (why.Count > 0 ? string.Join("; ", why) : "ready"));
                };
                Groups.Add(new SettingsGroup("Sheets in this issue · " + _check.Sheets.Count, sheets,
                    new ButtonsSetting("", new[] { new SettingButton("Zoom", ZoomCommand) })));
                if (_check.Problems.Count > 0)
                    Groups.Add(new SettingsGroup("Register and rulebook problems", new NoteSetting(string.Join("\n", _check.Problems), ChipKind.Warn)));
            }

            var ex = new List<SettingItem>();
            if (_check != null && _check.Exceptions.Count > 0)
                ex.Add(new TableSetting("", new[] { "Sheet", "Why", "Approved" },
                    _check.Exceptions.Select(e => new TableRow(e, e.Sheet, e.Item + ": " + e.Why, e.ApprovedBy + (e.Until.Length > 0 ? " · until " + e.Until : "")))));
            ex.Add(new ButtonsSetting("", new[] { new SettingButton("Record exception…", ExceptCommand) },
                "Listed on the readiness report and the transmittal, with who approved it."));
            Groups.Add(new SettingsGroup("Approved exceptions", ex.ToArray()));

            Groups.Add(new SettingsGroup("Issue manifest",
                new MultiSetting(_store, "issue.outputs", "Outputs", Outputs, Outputs, asChecks: true, hint: "DWG and IFC come later."),
                new TextSetting("Send to", q.SendTo, "Client, consultants (names or emails)", store: _store, key: "issue.sendto"),
                new ReadOnlySetting("Written to", (p.Folder.Length > 0 ? p.Folder + @"\" : "") + @"01_WIP\_Issue\<date>_" + (q.CompanyRevision.Length > 0 ? q.CompanyRevision : "<revision>"),
                    hint: "You move it to 03_Published after authorisation; the plugin never writes there.", mono: true),
                new ButtonsSetting("", new[] { new SettingButton("Save readiness report", ReportCommand), new SettingButton("Issue (dry run first)", IssueCommand, primary: true) })));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "issue.considerations", _status)));
        }

        private string? Missing(IssueRequest q)
        {
            if (q.Register.Length == 0) return "Choose the sheet register in Drawings › Sheets first.";
            if (q.CompanyRevision.Length == 0) return "Type the company revision (e.g. C02).";
            return null;
        }

        private async Task Check()
        {
            var q = Request();
            if (Missing(q) is string m) { _messages.Show(ChipKind.Warn, m); return; }
            _status("Checking " + q.IssueSet + " " + q.CompanyRevision + "…");
            var r = await _tools.CheckAsync(q);
            _check = r.Ok ? r : null;
            _messages.Show(r.Ok ? ChipKind.Info : ChipKind.Bad, r.Message);
            _status(r.Message);
            Rebuild();
        }

        private async Task Report()
        {
            var q = Request();
            if (Missing(q) is string m) { _messages.Show(ChipKind.Warn, m); return; }
            var r = await _tools.ReportAsync(q);
            _messages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "Report saved.");
        }

        private async Task Issue()
        {
            var q = Request();
            if (Missing(q) is string m) { _messages.Show(ChipKind.Warn, m); return; }
            if (q.ProjectFolder.Length == 0) { _messages.Show(ChipKind.Warn, "Set the project folder in Setup › Project: the issue is written into its 01_WIP."); return; }
            var dry = await _tools.IssueAsync(q, true);
            if (!dry.Ok) { _messages.Show(dry.Messages); return; }
            _ask(DialogViewModel.WithItems("Issue " + q.CompanyRevision + "?", q.IssueSet + " · " + q.Purpose + (_check != null ? " · " + _check.Result : "") + ".",
                new SettingItem[]
                {
                    new ReadOnlySetting("Will write", string.Join(Environment.NewLine, dry.Details), mono: true),
                    new NoteSetting(@"Files go to 01_WIP\_Issue. A person moves them to 03_Published after authorisation; the plugin never writes there.", ChipKind.Warn),
                }, "Issue", async () =>
                {
                    var r = await _tools.IssueAsync(q, false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Issued.");
                    return null;
                }));
        }

        private async Task Zoom()
        {
            if (_zoom.Count == 0) { _messages.Show(ChipKind.Warn, "Click a sheet first."); return; }
            _status(await _select.SelectAsync(_zoom));
        }

        /// <summary>What an exception can cover: each blocked sheet's reasons, as "sheet · item".</summary>
        public List<string> ExceptionItems() => _check == null ? new List<string>()
            : _check.Sheets.SelectMany(s => s.Reasons.Select(r => s.Number + " · " + r.Split(':')[0])).Distinct().ToList();

        private void AskException()
        {
            var items = ExceptionItems();
            if (items.Count == 0) { _messages.Show(ChipKind.Info, _check == null ? "Run the check first." : "Nothing is blocked: no exception needed."); return; }
            var form = new InMemoryUserSettings();
            var fs = new SettingStore(form, "");
            _ask(DialogViewModel.WithItems("Record an exception", "The item goes out anyway, with the reason and who approved it.", new SettingItem[]
            {
                new ChoiceSetting(fs, "item", "Item", items, dropdown: true),
                new TextSetting("Why it can go out anyway", "", "e.g. façade colour agreed by phone; drawing note added", store: fs, key: "why"),
                new TextSetting("Approved by", "", "Name and role", store: fs, key: "by"),
                new TextSetting("Review by", "", "Next revision (C03) or a date (2026-11-30)", store: fs, key: "until"),
            }, "Record exception", async () =>
            {
                string why = (form.Get("why") ?? "").Trim(), by = (form.Get("by") ?? "").Trim();
                if (why.Length == 0 || by.Length == 0) return "Say why, and who approved it.";
                var parts = (form.Get("item") ?? items[0]).Split(new[] { " · " }, 2, StringSplitOptions.None);
                var r = await _tools.ExceptAsync(Request(), new IssueExceptionLine(parts[0], parts[1], why, by, (form.Get("until") ?? "").Trim()));
                _messages.Show(r.Messages);
                if (r.Ok) await Check();
                return r.Ok ? null : r.Messages.FirstOrDefault()?.Text;
            }));
        }
    }
}
