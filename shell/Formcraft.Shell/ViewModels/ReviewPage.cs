using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Team › Review (board manage/PaneReview, U20): the project's review register (MAN 10.5). Raise an item with one owner
    /// and a due date, every affected discipline answers, the owner marks it done with the solution, and the raiser accepts
    /// and closes it or reopens it. The register is a project file, so it works on live models; revision clouds on the
    /// drawing and review prints come next, behind the live-model lock.
    /// </summary>
    public sealed class ReviewPage : SectionPage
    {
        public static readonly string[] Filters = { "My discipline", "Open", "Overdue", "Closed", "All" };
        public static readonly string[] Priorities = { "High", "Critical", "Medium", "Low" };

        private readonly IReviewTools _tools;
        private readonly IQaTools _select;
        private readonly ProjectPage _project;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Func<string> _me;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private List<ReviewItemInfo>? _items;
        private ReviewItemInfo? _selected;

        public ReviewPage(IReviewTools tools, IQaTools select, ProjectPage project, IUserSettings settings, Func<string> me, Action<string> status, Action<DialogViewModel> ask)
            : base("Team › Review", "Say what is wrong, call in every discipline it touches, and close it only when the raiser agrees.")
        {
            _tools = tools;
            _select = select;
            _project = project;
            _settings = settings;
            _store = new SettingStore(settings);
            _me = me;
            _status = status;
            _ask = ask;
            RefreshCommand = new AsyncCommand(Refresh, status);
            RaiseCommand = new RelayCommand(AskRaise);
            AnswerCommand = new RelayCommand(AskAnswer);
            SolveCommand = new RelayCommand(AskSolve);
            AcceptCommand = new AsyncCommand(() => Check(true, ""), status);
            ReopenCommand = new RelayCommand(AskReopen);
            ZoomCommand = new AsyncCommand(Zoom, status);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand RaiseCommand { get; }
        public ICommand AnswerCommand { get; }
        public ICommand SolveCommand { get; }
        public ICommand AcceptCommand { get; }
        public ICommand ReopenCommand { get; }
        public ICommand ZoomCommand { get; }
        public IReadOnlyList<ReviewItemInfo> Items => _items ?? new List<ReviewItemInfo>();
        public ReviewItemInfo? Selected => _selected;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Raise an item…", RaiseCommand, primary: true),
            new FooterAction("Register", RefreshCommand),
        };

        public override void Opened() { if (_items == null) _ = Refresh(); else Rebuild(); }

        /// <summary>The person's disciplines (Settings › General · you), for "My discipline".</summary>
        public List<string> MyDisciplines() => (_settings.Get("disciplines") ?? "").Split(',').Select(d => d.Trim().ToUpperInvariant()).Where(d => d.Length > 0).ToList();

        private string Folder => _project.Request().Folder;

        public void Rebuild()
        {
            Groups.Clear();
            if (Folder.Length == 0)
            {
                Groups.Add(new SettingsGroup("Review register", new NoteSetting("Set the project folder in Setup › Project: the register lives in its 01_WIP\\_Reviews.", ChipKind.Warn)));
                return;
            }
            var reg = new List<SettingItem> { new ChoiceSetting(_store, "review.filter", "Show", Filters, changed: f => { var refresh = Refresh(); }) };
            if (_items == null) reg.Add(new NoteSetting("Reading the register…"));
            else if (_items.Count == 0) reg.Add(new NoteSetting("No items here."));
            else
            {
                var table = new TableSetting("", new[] { "ID", "Title", "Owner", "Due", "Status" },
                    _items.Select(i => new TableRow(i, i.Id.Substring(Math.Max(0, i.Id.Length - 8)), i.Title, i.Owner, i.Due.Length >= 10 ? i.Due.Substring(5) : i.Due, i.Status)),
                    selectable: true, hint: "Click an item to answer, solve or check it.");
                if (_selected != null) table.Selected = table.Rows.FirstOrDefault(r => (r.Tag as ReviewItemInfo)?.Id == _selected.Id);
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is ReviewItemInfo i) || i == _selected) return;
                    _selected = i;
                    Rebuild();
                };
                reg.Add(table);
            }
            reg.Add(new ButtonsSetting("", new[] { new SettingButton("Raise an item…", RaiseCommand, primary: true), new SettingButton("Refresh", RefreshCommand) },
                "The project's register: " + Folder + "\\01_WIP\\_Reviews."));
            reg.Add(_messages);
            Groups.Add(new SettingsGroup("Review register", reg.ToArray()));

            if (_selected != null)
            {
                var i = _selected;
                var items = new List<SettingItem>
                {
                    new ReadOnlySetting(i.Title, i.Description),
                    new ReadOnlySetting("Owner · lead · due", i.Owner + " · " + i.Lead + " (owns the fix) · " + i.Due + " · " + i.Priority),
                    new ReadOnlySetting("Status", i.Status + " · raised by " + i.RaisedBy),
                    new TableSetting("Answers by discipline", new[] { "Discipline", "Answer", "Status" },
                        i.Disciplines.Select(d => { var a = i.Answers.FirstOrDefault(x => x.Discipline == d);
                            return new TableRow(d, d + (d == i.Lead ? " (lead)" : ""), a?.Text ?? "—", a == null ? "Waiting" : a.Done ? "Done" : "Open"); })),
                };
                if (i.Solution.Length > 0) items.Add(new ReadOnlySetting("Solution", i.Solution));
                var buttons = new List<SettingButton>();
                if (i.Status != "Closed")
                {
                    buttons.Add(new SettingButton("Answer…", AnswerCommand));
                    if (i.Status != "Resolved") buttons.Add(new SettingButton("Mark done…", SolveCommand, primary: true));
                }
                if (i.ElementIds.Count > 0) buttons.Add(new SettingButton("Zoom (" + i.ElementIds.Count + ")", ZoomCommand));
                items.Add(new ButtonsSetting("", buttons.ToArray(), "Mark done needs every asked discipline's answer; it waits for the raiser's check."));
                Groups.Add(new SettingsGroup("Selected: " + i.Id, items.ToArray()));
                if (i.Status == "Resolved")
                    Groups.Add(new SettingsGroup("Raiser's check",
                        new ButtonsSetting("", new[] { new SettingButton("Accept and close", AcceptCommand, primary: true), new SettingButton("Reopen…", ReopenCommand) },
                            "Closed only after the raiser's check (MAN 10.5).")));
            }

            Groups.Add(new SettingsGroup("Revision clouds and prints",
                new NoteSetting("Next: a revision cloud on the drawing for each item (it changes the model, so it goes through the live-model lock), " +
                                "prints for review and as revised, and BCF in Phase 2. Codes stay separate: company revision, Revit revision, sheet status, approval.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "review.considerations", _status)));
        }

        private async Task Refresh()
        {
            if (Folder.Length == 0) { Rebuild(); return; }
            var filter = _store.Get("review.filter") ?? Filters[0];
            var r = await _tools.ListAsync(Folder, filter, MyDisciplines());
            _items = r.Ok ? r.Items : new List<ReviewItemInfo>();
            if (_selected != null) _selected = _items.FirstOrDefault(i => i.Id == _selected.Id);
            _messages.Show(r.Ok ? ChipKind.Info : ChipKind.Bad, r.Message);
            _status(r.Message);
            Rebuild();
        }

        private void AskRaise()
        {
            if (Folder.Length == 0) { _messages.Show(ChipKind.Warn, "Set the project folder in Setup › Project first."); _status("Set the project folder in Setup › Project first."); return; }
            var form = new InMemoryUserSettings();
            var fs = new SettingStore(form, "");
            var mine = MyDisciplines();
            _ask(DialogViewModel.WithItems("Raise a review item", "One owner and a due date (MAN 10.5). Selected elements in Revit are linked.", new SettingItem[]
            {
                new TextSetting("Title", "", "e.g. Beam B12 too deep for the corridor ceiling at C/4", store: fs, key: "title"),
                new TextSetting("What you see, and what must change", "", "Plain words", store: fs, key: "what"),
                new MultiSetting(fs, "disciplines", "Disciplines affected", ProjectPage.Roles, mine.Take(1)),
                new ChoiceSetting(fs, "lead", "Lead discipline (owns the fix)", ProjectPage.Roles, Math.Max(0, Array.IndexOf(ProjectPage.Roles, mine.FirstOrDefault() ?? "A")), dropdown: true),
                new TextSetting("Owner (one person)", "", "Name", store: fs, key: "owner"),
                new ChoiceSetting(fs, "priority", "Priority", Priorities),
                new TextSetting("Due", "", "YYYY-MM-DD, empty: Critical 3 working days, High 1 week", store: fs, key: "due", mono: true),
                new ToggleSetting(fs, "link", "Link the elements selected in Revit", true),
            }, "Raise", async () =>
            {
                var q = _project.Request();
                var r = await _tools.RaiseAsync(new RaiseRequest
                {
                    ProjectFolder = q.Folder, ProjectCode = q.Code, Title = form.Get("title") ?? "", Description = form.Get("what") ?? "",
                    Disciplines = (form.Get("disciplines") ?? string.Join("|", mine.Take(1))).Split('|').Where(x => x.Length > 0).ToList(),
                    Lead = form.Get("lead") ?? ProjectPage.Roles[Math.Max(0, Array.IndexOf(ProjectPage.Roles, mine.FirstOrDefault() ?? "A"))],
                    Owner = form.Get("owner") ?? "", Priority = form.Get("priority") ?? Priorities[0], Due = (form.Get("due") ?? "").Trim(),
                    LinkSelection = form.Get("link") != "false", By = _me(),
                });
                if (!r.Ok) return r.Message;
                _selected = r.Item;
                _messages.Show(ChipKind.Good, r.Message);
                _status(r.Message);
                await Refresh();
                return null;
            }));
        }

        private void AskAnswer()
        {
            if (_selected == null) return;
            var i = _selected;
            var form = new InMemoryUserSettings();
            var fs = new SettingStore(form, "");
            var mine = MyDisciplines().Where(d => i.Disciplines.Contains(d)).ToList();
            var choices = i.Disciplines.ToArray();
            _ask(DialogViewModel.WithItems("Answer " + i.Id, i.Title, new SettingItem[]
            {
                new ChoiceSetting(fs, "discipline", "Discipline", choices, Math.Max(0, Array.IndexOf(choices, mine.FirstOrDefault() ?? choices[0])), dropdown: true),
                new TextSetting("Answer", "", "What your discipline changed or decided", store: fs, key: "text"),
                new ToggleSetting(fs, "done", "My discipline's part is done", true),
            }, "Answer", async () =>
            {
                var text = (form.Get("text") ?? "").Trim();
                if (text.Length == 0) return "Write the answer.";
                var r = await _tools.ActAsync(Folder, "answer", i.Id, _me(), form.Get("discipline") ?? choices[Math.Max(0, Array.IndexOf(choices, mine.FirstOrDefault() ?? choices[0]))], text, form.Get("done") != "false");
                return await After(r);
            }));
        }

        private void AskSolve()
        {
            if (_selected == null) return;
            var i = _selected;
            var form = new InMemoryUserSettings();
            _ask(DialogViewModel.WithItems("Mark " + i.Id + " done", "Notifies the raiser, who accepts or reopens it.", new SettingItem[]
            {
                new TextSetting("Solution: what you changed", "", "e.g. Beam B12 reduced to 450 mm; corridor clear 2.40 m", store: new SettingStore(form, ""), key: "text"),
            }, "Mark done", async () =>
            {
                var text = (form.Get("text") ?? "").Trim();
                if (text.Length == 0) return "Say what you changed.";
                return await After(await _tools.ActAsync(Folder, "solve", i.Id, _me(), text: text));
            }));
        }

        private void AskReopen()
        {
            if (_selected == null) return;
            var i = _selected;
            var form = new InMemoryUserSettings();
            _ask(DialogViewModel.WithItems("Reopen " + i.Id, "It goes back to the owner with your reason.", new SettingItem[]
            {
                new TextSetting("Why", "", "What still isn't right", store: new SettingStore(form, ""), key: "text"),
            }, "Reopen", async () =>
            {
                var text = (form.Get("text") ?? "").Trim();
                if (text.Length == 0) return "Say why you reopen it.";
                return await After(await _tools.ActAsync(Folder, "check", i.Id, _me(), text: text, accept: false));
            }));
        }

        private async Task Check(bool accept, string text)
        {
            if (_selected == null) return;
            var r = await _tools.ActAsync(Folder, "check", _selected.Id, _me(), text: text, accept: accept);
            await After(r);
        }

        private async Task<string?> After((bool Ok, string Message, ReviewItemInfo? Item) r)
        {
            if (!r.Ok) { _messages.Show(ChipKind.Warn, r.Message); _status(r.Message); return r.Message; }
            _selected = r.Item;
            _messages.Show(ChipKind.Good, r.Message);
            _status(r.Message);
            await Refresh();
            return null;
        }

        private async Task Zoom()
        {
            if (_selected == null || _selected.ElementIds.Count == 0) return;
            _status(await _select.SelectAsync(_selected.ElementIds));
        }
    }
}
