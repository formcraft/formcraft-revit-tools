using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Drawings › Sheets (board manage/PaneSheets, U19): which sheets should exist for an issue set, the project's sheet
    /// register against the model (missing, extra, names that differ), and how complete each sheet is. Sheet numbers come
    /// from the register, never typed by hand; creating and renaming sheets runs a dry run first and is refused on live
    /// projects. Views are placed by people (Flow's Sheet Layout comes in Phase 2).
    /// </summary>
    public sealed class SheetsPage : SectionPage
    {
        public static readonly string[] WhenDisagree = { "Ask me", "Register wins", "Model wins" };

        private readonly ISheetTools _tools;
        private readonly ProjectPage _project;
        private readonly IFilePicker _picker;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Action _openIssue;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private SheetComparison? _compare;

        public SheetsPage(ISheetTools tools, ProjectPage project, IFilePicker picker, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask, Action openIssue)
            : base("Drawings › Sheets", "Which sheets should exist, the register against the model, and how far each sheet has come.")
        {
            _tools = tools;
            _project = project;
            _picker = picker;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _openIssue = openIssue;
            CompareCommand = new AsyncCommand(Compare, status);
            CreateCommand = new AsyncCommand(() => Change("create"), status);
            RenameCommand = new AsyncCommand(() => Change("rename"), status);
            Rebuild();
        }

        public ICommand CompareCommand { get; }
        public ICommand CreateCommand { get; }
        public ICommand RenameCommand { get; }
        public SheetComparison? LastCompare => _compare;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Compare", CompareCommand, primary: true),
            new FooterAction("Create missing (dry run)", CreateCommand),
        };

        public override void Opened() => Rebuild();

        /// <summary>The register: the one chosen here, else the project's 00_Info\FMC_Sheet_Register.xlsx (or .csv).</summary>
        public string Register()
        {
            var chosen = (_store.Get("sheets.register") ?? "").Trim();
            if (chosen.Length > 0) return chosen;
            var folder = _project.Request().Folder;
            if (folder.Length == 0) return "";
            var xlsx = Path.Combine(folder, "00_Info", "FMC_Sheet_Register.xlsx");
            var csv = Path.ChangeExtension(xlsx, ".csv");
            return File.Exists(xlsx) || !File.Exists(csv) ? xlsx : csv;
        }

        private string IssueSet => _store.Get("sheets.issueset") ?? _project.Request().IssueSet;
        private List<string> Roles() => (_store.Get("sheets.roles") is string r ? r.Split('|') : _project.Request().Roles.ToArray()).Where(x => x.Length > 0).ToList();

        public void Rebuild()
        {
            Groups.Clear();
            var q = _project.Request();
            Groups.Add(new SettingsGroup("Which sheets",
                new ChoiceSetting(_store, "sheets.stage", "Stage", ProjectPage.Stages, Math.Max(0, Array.FindIndex(ProjectPage.Stages, s => s.StartsWith(q.Stage))), dropdown: true),
                new ChoiceSetting(_store, "sheets.issueset", "Issue set", ProjectPage.IssueSets, Math.Max(0, Array.IndexOf(ProjectPage.IssueSets, q.IssueSet))),
                new MultiSetting(_store, "sheets.roles", "Roles", ProjectPage.Roles, q.Roles)));

            var register = Register();
            Groups.Add(new SettingsGroup("Register",
                new ReadOnlySetting("Register", register.Length == 0 ? "Set the project folder in Setup › Project, or choose the register" : register, mono: true,
                    hint: "Number, Name, Role and Issue sets columns. Read here; edits go into the register itself."),
                new ButtonsSetting("", new[] { new SettingButton("Choose the register…", new RelayCommand(Choose)), new SettingButton("Compare", CompareCommand, primary: true) }),
                new ChoiceSetting(_store, "sheets.disagree", "When model and register disagree", WhenDisagree,
                    hint: "Register wins: create the missing sheets and rename to the register. Model wins: change the register by hand; the pane never writes it."),
                _messages));

            if (_compare != null)
            {
                Groups.Add(new SettingsGroup($"Planned vs in the model · {_compare.Planned} planned · {_compare.InModel} in the model",
                    _compare.Differences.Count == 0 ? (SettingItem)new NoteSetting("The model matches the register.", ChipKind.Good)
                        : new TableSetting("", new[] { "Sheet", "Difference" }, _compare.Differences.Select(d => new TableRow(d, d.Label, d.Difference
                            + (d.Difference == "Name differs" ? ": " + d.ModelName : "")))),
                    _compare.TitleBlocks.Count == 0 ? (SettingItem)new NoteSetting("No title block is loaded: new sheets would have none.", ChipKind.Warn)
                        : new ChoiceSetting(_store, "sheets.titleblock", "Title block for new sheets", _compare.TitleBlocks.ToArray(), dropdown: true),
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Create missing (dry run)", CreateCommand),
                        new SettingButton("Rename to the register (dry run)", RenameCommand),
                    }, "Setup tools: a dry run first, then a yes; refused on live projects. Extra sheets are listed, never deleted.")));
                Groups.Add(new SettingsGroup("Completeness",
                    new TableSetting("", new[] { "Sheet", "Status", "Done" },
                        _compare.Completeness.Select(c => new TableRow(c, c.Number + " " + c.Name, c.Status, c.Percent + "%")),
                        hint: "Views placed and title block fields filled (Drawn By, Checked By, Approved By, issue date, FMC_Sheet_Status).")));
                if (_compare.Problems.Count > 0)
                    Groups.Add(new SettingsGroup("Register problems", new NoteSetting(string.Join("\n", _compare.Problems), ChipKind.Warn)));
            }
            Groups.Add(new SettingsGroup("Placing views · Phase 2 with Formcraft Flow",
                new NoteSetting("Align, distribute and smart crop come from Flow's Sheet Layout, driven by these rules. Phase 1 creates sheets and fills title blocks; views are placed by people.")));
            Groups.Add(new SettingsGroup("Before issue",
                new ToggleSetting(_store, "sheets.warnreviews", "Warn when a sheet has open review items", true, "Review items arrive with Team › Review (U20)."),
                new ButtonsSetting("", new[] { new SettingButton("Hand the set to Ready to issue", new RelayCommand(_openIssue)) },
                    "Issuing happens in the Issue section, after the readiness check.")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "sheets.considerations", _status)));
        }

        private void Choose()
        {
            var path = _picker.Open("Choose the sheet register", "Sheet register (*.xlsx;*.csv)|*.xlsx;*.csv", "");
            if (path == null) return;
            _store.Set("sheets.register", path);
            Rebuild();
        }

        private async Task Compare()
        {
            var register = Register();
            if (register.Length == 0) { _messages.Show(ChipKind.Warn, "Choose the sheet register first."); return; }
            _status("Comparing the register with the model…");
            var r = await _tools.CompareAsync(register, IssueSet, Roles());
            _compare = r.Ok ? r : null;
            _messages.Show(r.Ok ? ChipKind.Info : ChipKind.Bad, r.Message);
            _status(r.Message);
            Rebuild();
        }

        private async Task Change(string action)
        {
            if ((_store.Get("sheets.disagree") ?? WhenDisagree[0]) == "Model wins")
            {
                _messages.Show(ChipKind.Warn, "Model wins is set: change the register itself; the pane doesn't change the model to match it.");
                return;
            }
            var register = Register();
            if (register.Length == 0) { _messages.Show(ChipKind.Warn, "Choose the sheet register first."); return; }
            string titleBlock = _store.Get("sheets.titleblock") ?? _compare?.TitleBlocks.FirstOrDefault() ?? "";
            var dry = action == "create" ? await _tools.CreateAsync(register, IssueSet, Roles(), titleBlock, true)
                                         : await _tools.RenameAsync(register, IssueSet, Roles(), true);
            if (!dry.Ok) { _messages.Show(dry.Messages); return; }
            if (dry.Details.Count == 0) { _messages.Show(ChipKind.Good, action == "create" ? "No missing sheets." : "No names differ."); return; }
            _ask(DialogViewModel.WithItems(action == "create" ? "Create " + dry.Details.Count + " sheets?" : "Rename " + dry.Details.Count + " sheets?",
                action == "create" ? "Numbers and names from the register" + (titleBlock.Length > 0 ? ", title block " + titleBlock : "") + "." : "Names from the register.",
                new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, action == "create" ? "Create" : "Rename", async () =>
                {
                    var r = action == "create" ? await _tools.CreateAsync(register, IssueSet, Roles(), titleBlock, false)
                                               : await _tools.RenameAsync(register, IssueSet, Roles(), false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    await Compare();
                    return null;
                }));
        }
    }
}
