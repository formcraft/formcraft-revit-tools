using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Check › Reports (board manage/PaneReports, U21): reports traced to the plugin's own saved files (MAN 13.1), for the
    /// team, the client or the BIM Manager. Client reports leave out names, logs and internal notes; syncs and activity
    /// are counts per model and action, never per person (MAN 14.5). Markdown and a tidy CSV for Power BI now; the branded
    /// PDF, Excel, sending and the weekly schedule come later.
    /// </summary>
    public sealed class ReportsPage : SectionPage
    {
        public static readonly string[] Kinds = { "Weekly project report", "Model health and QA", "Review register", "Sync log and workshare",
            "Ready to issue record", "Rule exceptions", "Activity log" };
        public static readonly string[] Periods = { "Last 7 days", "Since last issue", "This month", "Whole project" };
        public static readonly string[] Audiences = { "Team", "Client", "BIM Manager" };
        public static readonly string[] Formats = { "Markdown for the project log", "CSV for Power BI" };

        private readonly IReportTools _tools;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private List<(string File, string Date)> _recent = new List<(string, string)>();

        public ReportsPage(IReportTools tools, ProjectPage project, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Check › Reports", "Reports for the team, the client and the BIM Manager, every number traced to a saved file.")
        {
            _tools = tools;
            _project = project;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            PreviewCommand = new AsyncCommand(Preview, status);
            MakeCommand = new AsyncCommand(Make, status);
            Rebuild();
        }

        public ICommand PreviewCommand { get; }
        public ICommand MakeCommand { get; }
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Preview", PreviewCommand),
            new FooterAction("Make report", MakeCommand, primary: true),
        };

        public override void Opened() { Rebuild(); _ = LoadRecent(); }

        public ReportRequest Request()
        {
            var p = _project.Request();
            var formats = (_store.Get("reports.formats") is string f ? f.Split('|') : Formats).ToList();
            return new ReportRequest
            {
                ProjectFolder = p.Folder, ProjectCode = p.Code, Originator = p.Originator,
                Kind = _store.Get("reports.kind") ?? Kinds[0], Period = _store.Get("reports.period") ?? Periods[0],
                Audience = _store.Get("reports.audience") ?? Audiences[0],
                Disciplines = (_store.Get("reports.disciplines") is string d ? d.Split('|') : new string[0]).Where(x => x.Length > 0).ToList(),
                Markdown = formats.Contains(Formats[0]), Csv = formats.Contains(Formats[1]),
            };
        }

        public void Rebuild()
        {
            Groups.Clear();
            var q = Request();
            if (q.ProjectFolder.Length == 0)
            {
                Groups.Add(new SettingsGroup("Make a report", new NoteSetting("Set the project folder in Setup › Project: reports read its files and are saved in its 01_WIP.", ChipKind.Warn)));
                return;
            }
            Groups.Add(new SettingsGroup("Make a report",
                new ChoiceSetting(_store, "reports.kind", "Report", Kinds, dropdown: true),
                new ChoiceSetting(_store, "reports.period", "Period", Periods, dropdown: true),
                new MultiSetting(_store, "reports.disciplines", "Disciplines", ProjectPage.Roles, new string[0], hint: "None ticked: every discipline. Filters the review items."),
                new ChoiceSetting(_store, "reports.audience", "For", Audiences, 0, hint: "Client reports leave out names, logs and internal notes."),
                new NoteSetting("Every number comes from a saved file with its date (QA history, the review register, the sync log, issue folders, exceptions, the action log), so the report can be traced (MAN 13.1).", ChipKind.Info)));
            Groups.Add(new SettingsGroup("Format",
                new MultiSetting(_store, "reports.formats", "Formats", Formats, Formats, asChecks: true),
                new ReadOnlySetting("File name", (q.ProjectCode.Length > 0 ? q.ProjectCode : "PROJ") + "-" + q.Originator + "-ZZ-ZZ-RP-Z-NNNN · from the container rules", mono: true),
                new ReadOnlySetting("Saved to", q.ProjectFolder + "\\01_WIP\\_Reports\\<date>", mono: true),
                new NoteSetting("The branded PDF and the Excel workbook come once the plugin can write them; Markdown opens in any editor and the CSV feeds Power BI.", ChipKind.Grey),
                new ButtonsSetting("", new[] { new SettingButton("Preview", PreviewCommand), new SettingButton("Make report", MakeCommand, primary: true) }),
                _messages));
            Groups.Add(new SettingsGroup("Recent reports",
                _recent.Count == 0 ? (SettingItem)new NoteSetting("No reports made yet.")
                    : new TableSetting("", new[] { "Report", "Date" }, _recent.Select(r => new TableRow(r, System.IO.Path.GetFileName(r.File), r.Date)))));
            Groups.Add(new SettingsGroup("Send and schedule",
                new NoteSetting("Sending and the weekly run aren't built: they need a mail route and the BIM Manager's computer with Revit open. Make it here and attach it.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Summary in plain words · Phase 2",
                new NoteSetting("Your AI provider writes the opening paragraph from the report's own numbers; you edit it before it goes out.")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "reports.considerations", _status)));
        }

        private bool Ready(ReportRequest q)
        {
            if (q.ProjectFolder.Length > 0) return true;
            _messages.Show(ChipKind.Warn, "Set the project folder in Setup › Project first.");
            _status("Set the project folder in Setup › Project first.");
            return false;
        }

        private async Task Preview()
        {
            var q = Request();
            if (!Ready(q)) return;
            var r = await _tools.PreviewAsync(q);
            if (!r.Ok) { _messages.Show(ChipKind.Bad, r.Message); _status(r.Message); return; }
            var items = new List<SettingItem> { new ReadOnlySetting("", r.Preview, mono: true) };
            if (r.LeftOut.Count > 0) items.Add(new NoteSetting("Left out for the client: " + string.Join(", ", r.LeftOut) + ".", ChipKind.Info));
            _ask(DialogViewModel.WithItems("Preview · " + q.Kind, q.Period + " · for " + q.Audience, items.ToArray(), "Make report", async () =>
            {
                await Make();
                return null;
            }));
        }

        private async Task Make()
        {
            var q = Request();
            if (!Ready(q)) return;
            if (!q.Markdown && !q.Csv) { _messages.Show(ChipKind.Warn, "Tick at least one format."); _status("Tick at least one format."); return; }
            var r = await _tools.MakeAsync(q);
            _messages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "Saved.");
            await LoadRecent();
        }

        private async Task LoadRecent()
        {
            var folder = _project.Request().Folder;
            if (folder.Length == 0) return;
            _recent = await _tools.RecentAsync(folder);
            Rebuild();
        }
    }
}
