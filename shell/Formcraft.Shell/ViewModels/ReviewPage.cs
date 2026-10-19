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

        public static readonly string[] WhisperModels = { "small", "medium" };
        public static readonly string[] Languages = { "auto", "en", "sw" };

        private readonly IVoiceRecorder _recorder;
        /// <summary>The ticket a voice reply is being recorded for.</summary>
        private string? _recordingFor;

        public ReviewPage(IReviewTools tools, IQaTools select, ProjectPage project, IUserSettings settings, Func<string> me, Action<string> status, Action<DialogViewModel> ask,
                          IVoiceRecorder? recorder = null)
            : base("Team › Review", "Say what is wrong, call in every discipline it touches, and close it only when the raiser agrees.")
        {
            _recorder = recorder ?? new WinMmVoiceRecorder();
            ReplyCommand = new RelayCommand(AskReply);
            RecordCommand = new RelayCommand(Record);
            StopCommand = new AsyncCommand(StopAndSend, status);
            DiscardCommand = new RelayCommand(Discard);
            TranscribeCommand = new AsyncCommand(TranscribeNext, status);
            TakeCommand = new AsyncCommand(Take, status);
            WhisperCommand = new AsyncCommand(CheckWhisper, status);
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
            CloudCommand = new AsyncCommand(Cloud, status);
            PrintReviewCommand = new AsyncCommand(() => Print("For review"), status);
            PrintRevisedCommand = new AsyncCommand(() => Print("As revised"), status);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand RaiseCommand { get; }
        public ICommand AnswerCommand { get; }
        public ICommand SolveCommand { get; }
        public ICommand AcceptCommand { get; }
        public ICommand ReopenCommand { get; }
        public ICommand ZoomCommand { get; }
        public ICommand CloudCommand { get; }
        public ICommand PrintReviewCommand { get; }
        public ICommand PrintRevisedCommand { get; }
        public ICommand ReplyCommand { get; }
        public ICommand RecordCommand { get; }
        public ICommand StopCommand { get; }
        public ICommand DiscardCommand { get; }
        public ICommand TranscribeCommand { get; }
        public ICommand TakeCommand { get; }
        public ICommand WhisperCommand { get; }
        public bool IsRecording => _recorder.IsRecording;
        private List<PrintInfo> _prints = new List<PrintInfo>();
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
            var reviewItems = (_items ?? new List<ReviewItemInfo>()).Where(i => !i.IsTicket).ToList();
            if (_items == null) reg.Add(new NoteSetting("Reading the register…"));
            else if (reviewItems.Count == 0) reg.Add(new NoteSetting("No items here."));
            else
            {
                var table = new TableSetting("", new[] { "ID", "Title", "Owner", "Due", "Status" },
                    reviewItems.Select(i => new TableRow(i, i.Id.Substring(Math.Max(0, i.Id.Length - 8)), i.Title, i.Owner, i.Due.Length >= 10 ? i.Due.Substring(5) : i.Due, i.Status)),
                    selectable: true, hint: "Click an item to answer, solve or check it.");
                if (_selected != null) table.Selected = table.Rows.FirstOrDefault(r => (r.Tag as ReviewItemInfo)?.Id == _selected.Id);
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is ReviewItemInfo i) || i == _selected) return;
                    if (_recorder.IsRecording) { _status("Stop or discard the voice reply first."); return; }
                    _selected = i;
                    Rebuild();
                };
                reg.Add(table);
            }
            reg.Add(new ButtonsSetting("", new[] { new SettingButton("Raise an item…", RaiseCommand, primary: true), new SettingButton("Refresh", RefreshCommand) },
                "The project's register: " + Folder + "\\01_WIP\\_Reviews."));
            reg.Add(_messages);
            Groups.Add(new SettingsGroup("Review register", reg.ToArray()));
            Groups.Add(TicketsGroup());

            if (_selected != null && _selected.IsTicket) AddTicket(_selected);
            else if (_selected != null)
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
                items.Add(new ReadOnlySetting("Cloud on the drawing", i.Cloud.Length > 0 ? i.Cloud : i.ElementIds.Count > 0 ? "Not drawn yet" : "No linked elements to cloud"));
                var buttons = new List<SettingButton>();
                if (i.Status != "Closed")
                {
                    buttons.Add(new SettingButton("Answer…", AnswerCommand));
                    if (i.Status != "Resolved") buttons.Add(new SettingButton("Mark done…", SolveCommand, primary: true));
                }
                if (i.ElementIds.Count > 0) buttons.Add(new SettingButton("Zoom (" + i.ElementIds.Count + ")", ZoomCommand));
                if (i.ElementIds.Count > 0 && i.Cloud.Length == 0 && i.Status != "Closed") buttons.Add(new SettingButton("Cloud it (dry run)", CloudCommand));
                items.Add(new ButtonsSetting("", buttons.ToArray(), "Mark done needs every asked discipline's answer; it waits for the raiser's check."));
                Groups.Add(new SettingsGroup("Selected: " + i.Id, items.ToArray()));
                if (i.Status == "Resolved")
                    Groups.Add(new SettingsGroup("Raiser's check",
                        new ButtonsSetting("", new[] { new SettingButton("Accept and close", AcceptCommand, primary: true), new SettingButton("Reopen…", ReopenCommand) },
                            "Closed only after the raiser's check (MAN 10.5).")));
            }

            Groups.Add(new SettingsGroup("Prints of a sheet",
                new TextSetting("Sheet", "", "e.g. A-1001", store: _store, key: "review.sheet", mono: true),
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Print for review", PrintReviewCommand),
                    new SettingButton("Print as revised", PrintRevisedCommand, primary: true),
                }, "The sheet's PDF and its list of items (open ones to fix, or solved ones with their solutions), in 01_WIP\\_Reviews\\Prints."),
                _prints.Count == 0 ? (SettingItem)new NoteSetting("No prints of this sheet yet.")
                    : new TableSetting("Print history", new[] { "Date", "Print", "Items" }, _prints.Select(p => new TableRow(p, p.At, p.Kind, p.Items.ToString())))));
            Groups.Add(new SettingsGroup("Voice notes (offline)",
                new ChoiceSetting(_store, "review.whisper_model", "Transcription model", WhisperModels,
                    hint: "small: about 490 MB, good on site English and accents; medium: about 1.5 GB, for PCs with the memory."),
                new ChoiceSetting(_store, "review.whisper_language", "Language", Languages, hint: "auto detects it; en English, sw Swahili. The audio is always kept."),
                new ButtonsSetting("", new[] { new SettingButton("Check Whisper", WhisperCommand) },
                    "whisper.cpp runs on this PC's processor at low priority; nothing leaves the PC. Downloaded once, after a dry run.")));
            Groups.Add(new SettingsGroup("Clouds, BCF and change requests",
                new NoteSetting("A cloud goes on an unissued revision (Revit's rule): the latest one, or a new \"Review\" revision. BCF import and export come in Phase 2. " +
                                "Codes stay separate: company revision, Revit revision, sheet status, approval.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "review.considerations", _status)));
        }

        // ------------------------------------------------------------------------------------- Mark & Review tickets (R2)

        /// <summary>Tickets: marks, clashes and BCF topics, each with who fixes it, where it came from and its latest note.</summary>
        private SettingsGroup TicketsGroup()
        {
            var tickets = (_items ?? new List<ReviewItemInfo>()).Where(i => i.IsTicket).ToList();
            if (_items == null) return new SettingsGroup("Tickets", new NoteSetting("Reading the register…"));
            if (tickets.Count == 0)
                return new SettingsGroup("Tickets", new NoteSetting("No tickets here. Marks in Revit, Navisworks clashes and BCF topics land in this list, for the AI, a person, a discipline or anyone.", ChipKind.Grey));
            var table = new TableSetting("", new[] { "ID", "For", "From", "Media", "Latest note", "Status" },
                tickets.Select(i => new TableRow(i, i.Id.Substring(Math.Max(0, i.Id.Length - 8)), i.ToShown, i.Source, i.Media, Short(i.LatestNote, 60), i.Status)),
                selectable: true, hint: "Click a ticket to read its thread and reply, typed or by voice.");
            if (_selected != null) table.Selected = table.Rows.FirstOrDefault(r => (r.Tag as ReviewItemInfo)?.Id == _selected.Id);
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is ReviewItemInfo i) || i == _selected) return;
                if (_recorder.IsRecording) { _status("Stop or discard the voice reply first."); return; }
                _selected = i;
                Rebuild();
            };
            return new SettingsGroup("Tickets", table);
        }

        private static string Short(string s, int max) { s = (s ?? "").Replace("\r", " ").Replace("\n", " "); return s.Length <= max ? s : s.Substring(0, max - 1).TrimEnd() + "…"; }

        /// <summary>The selected ticket: what and where, its thread with transcripts, and a reply typed or spoken.</summary>
        private void AddTicket(ReviewItemInfo i)
        {
            var items = new List<SettingItem>
            {
                new ReadOnlySetting(i.Title, i.Description),
                new ReadOnlySetting("For · owner · due", i.ToShown + " · " + i.Owner + " · " + i.Due + " · " + i.Priority),
                new ReadOnlySetting("Status", i.Status + " · raised by " + i.RaisedBy + " · from " + (i.Source.Length > 0 ? i.Source : "mark")),
                new ReadOnlySetting("Where", (i.Elements > 0 ? i.Elements + (i.Elements == 1 ? " element" : " elements") : "A point in the model") + (i.View.Length > 0 ? " · " + i.View : "") + (i.HasPicture ? " · picture kept" : "")),
                i.Notes.Count == 0 ? (SettingItem)new NoteSetting("No notes yet.")
                    : new TableSetting("Thread", new[] { "When", "Who", "Note", "How" },
                        i.Notes.Select((n, k) => new TableRow(n, n.At.Length >= 16 ? n.At.Substring(5, 11).Replace("T", " ") : n.At, n.By, n.Shown, n.How))),
            };
            var buttons = new List<SettingButton>();
            if (_recorder.IsRecording && _recordingFor == i.Id)
            {
                items.Add(new NoteSetting("Recording a voice reply… speak, then Stop and send. It is transcribed on this PC.", ChipKind.Warn));
                buttons.Add(new SettingButton("Stop and send", StopCommand, primary: true));
                buttons.Add(new SettingButton("Discard", DiscardCommand));
            }
            else if (i.Status != "Closed")
            {
                buttons.Add(new SettingButton("Record a voice reply", RecordCommand, primary: true));
                buttons.Add(new SettingButton("Reply…", ReplyCommand));
                if (i.Notes.Any(n => n.NeedsTranscript)) buttons.Add(new SettingButton("Transcribe", TranscribeCommand));
                if (i.Status == "Open" && i.To != "ai") buttons.Add(new SettingButton("Take it", TakeCommand));
            }
            items.Add(new ButtonsSetting("", buttons.ToArray(), i.Status == "Closed" ? "A closed ticket takes no replies: reopen it first." : "Voice replies are 16 kHz WAV, kept beside the register with their transcript."));
            Groups.Add(new SettingsGroup("Ticket: " + i.Id, items.ToArray()));
            if (i.Status == "Resolved")
                Groups.Add(new SettingsGroup("Raiser's check",
                    new ButtonsSetting("", new[] { new SettingButton("Accept and close", AcceptCommand, primary: true), new SettingButton("Reopen…", ReopenCommand) },
                        "Closed only after the raiser's check (MAN 10.5); the AI never closes its own ticket.")));
        }

        private string Model => _store.Get("review.whisper_model") is string m && WhisperModels.Contains(m) ? m : WhisperModels[0];
        private string Language => _store.Get("review.whisper_language") is string l && Languages.Contains(l) ? l : Languages[0];

        private void Say(ChipKind kind, string text) { _messages.Show(kind, text); _status(text); }

        private void AskReply()
        {
            if (_selected == null || !_selected.IsTicket) return;
            var i = _selected;
            var form = new InMemoryUserSettings();
            _ask(DialogViewModel.WithItems("Reply to " + i.Id, i.Title, new SettingItem[]
            {
                new TextSetting("Reply", "", "What you found, changed or need", store: new SettingStore(form, ""), key: "text"),
            }, "Reply", async () =>
            {
                var text = (form.Get("text") ?? "").Trim();
                if (text.Length == 0) return "Write the reply, or record a voice reply.";
                return await After(await _tools.ReplyAsync(Folder, i.Id, _me(), text, ""));
            }));
        }

        private void Record()
        {
            if (_selected == null || !_selected.IsTicket || _recorder.IsRecording) return;
            var problem = _recorder.Problem();
            if (problem != null) { Say(ChipKind.Warn, problem); return; }
            try { _recorder.Start(); }
            catch (Exception ex) { Say(ChipKind.Warn, ex.Message); return; }
            _recordingFor = _selected.Id;
            Say(ChipKind.Info, "Recording a voice reply to " + _selected.Id + "…");
            Rebuild();
        }

        private void Discard()
        {
            if (!_recorder.IsRecording) return;
            _recorder.Discard();
            _recordingFor = null;
            Say(ChipKind.Info, "Voice reply discarded.");
            Rebuild();
        }

        /// <summary>Stop, send the WAV as a reply (copied beside the register), then transcribe it offline.</summary>
        private async Task StopAndSend()
        {
            if (!_recorder.IsRecording || _recordingFor == null) return;
            var id = _recordingFor;
            _recordingFor = null;
            string wav;
            try { wav = _recorder.Stop(); }
            catch (Exception ex) { Say(ChipKind.Warn, ex.Message); Rebuild(); return; }
            try
            {
                var r = await _tools.ReplyAsync(Folder, id, _me(), "", wav);
                if (!r.Ok || r.Item == null) { Say(ChipKind.Warn, "Voice reply not sent: " + r.Message); Rebuild(); return; }
                _selected = r.Item;
                Say(ChipKind.Info, "Voice reply sent; transcribing on this PC…");
                Rebuild();
                await Transcribe(id, r.Item.Notes.Count);
            }
            finally
            {
                try { System.IO.File.Delete(wav); } catch { /* the register keeps its own copy; a temp file left behind is harmless */ }
            }
        }

        private Task TranscribeNext()
        {
            if (_selected == null) return Task.CompletedTask;
            var k = _selected.Notes.FindLastIndex(n => n.NeedsTranscript);
            return k < 0 ? Task.CompletedTask : Transcribe(_selected.Id, k + 1);
        }

        private async Task Transcribe(string id, int note)
        {
            var t = await _tools.TranscribeAsync(Folder, id, note, Model, Language, _me());
            if (t.Ok) _selected = t.Item;
            // the register is read again first, so the message below is the one left showing
            await Refresh();
            if (!t.Ok) Say(ChipKind.Warn, "Voice note kept, not transcribed: " + t.Message);
            else Say(ChipKind.Good, t.Message);
        }

        private async Task Take()
        {
            if (_selected == null) return;
            await After(await _tools.ActAsync(Folder, "take", _selected.Id, _me()));
        }

        /// <summary>Whisper on this PC: what is there; a download only after its dry run and a yes.</summary>
        private async Task CheckWhisper()
        {
            var model = Model;
            var dry = await _tools.WhisperSetupAsync(model, true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Whisper check failed."); return; }
            if (dry.Details.Count == 0) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Whisper is ready."); return; }
            _ask(DialogViewModel.WithItems("Download Whisper (" + model + ")?", "Once per PC, into %LOCALAPPDATA%\\Formcraft\\whisper. Each file's SHA-256 is checked against the published one.",
                new SettingItem[] { new ReadOnlySetting("Will download", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Download", async () =>
                {
                    var r = await _tools.WhisperSetupAsync(model, false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? (r.Ok ? "Whisper is ready." : "Download failed."));
                    return r.Ok ? null : r.Messages.FirstOrDefault()?.Text ?? "Download failed.";
                }));
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

        private async Task Cloud()
        {
            if (_selected == null) return;
            var id = _selected.Id;
            var dry = await _tools.CloudAsync(Folder, id, true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            _ask(DialogViewModel.WithItems("Cloud " + id + "?", "This changes the model: a revision cloud on the drawing. Refused on live projects.",
                new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Cloud it", async () =>
                {
                    var r = await _tools.CloudAsync(Folder, id, false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Clouded.");
                    await Refresh();
                    return null;
                }));
        }

        private async Task Print(string kind)
        {
            var sheet = (_store.Get("review.sheet") ?? "").Trim().ToUpperInvariant();
            if (sheet.Length == 0) { _messages.Show(ChipKind.Warn, "Type the sheet number to print, e.g. A-1001."); _status("Type the sheet number to print, e.g. A-1001."); return; }
            var r = await _tools.PrintAsync(Folder, sheet, kind, _me());
            _messages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "Printed.");
            _prints = await _tools.PrintsAsync(Folder, sheet);
            Rebuild();
        }

        private async Task Zoom()
        {
            if (_selected == null || _selected.ElementIds.Count == 0) return;
            _status(await _select.SelectAsync(_selected.ElementIds));
        }
    }
}
