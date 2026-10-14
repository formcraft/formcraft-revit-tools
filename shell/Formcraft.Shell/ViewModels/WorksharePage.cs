using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Team › Workshare (board manage/PaneWorkshare, U20): the model's worksets against the naming rule, the standard set
    /// (created after a dry run, refused on live projects), a sync preflight and the sync message in the fixed format.
    /// The pane prepares the sync; a person syncs in Revit. Neither the plugin nor Claude ever syncs or saves (CLAUDE.md
    /// rule 6), so the board's "Sync with this message" and scheduled sync aren't built.
    /// </summary>
    public sealed class WorksharePage : SectionPage
    {
        private readonly IWorkshareTools _tools;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Action<string> _copy;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private WorkshareFacts? _facts;
        private string _message = "";

        public WorksharePage(IWorkshareTools tools, ProjectPage project, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask, Action<string>? copy = null)
            : base("Team › Workshare", "Worksets by the rule, a safe sync: the pane prepares it, you sync in Revit.")
        {
            _tools = tools;
            _project = project;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _copy = copy ?? (t => { try { System.Windows.Clipboard.SetText(t); } catch (Exception) { /* clipboard busy: the preview still shows it */ } });
            RefreshCommand = new AsyncCommand(Refresh, status);
            CreateCommand = new AsyncCommand(() => Create(new string[0]), status);
            NewWorksetCommand = new RelayCommand(AskNewWorkset);
            ComposeCommand = new AsyncCommand(() => Compose(false), status);
            RecordCommand = new AsyncCommand(() => Compose(true), status);
            CopyCommand = new RelayCommand(Copy);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand CreateCommand { get; }
        public ICommand NewWorksetCommand { get; }
        public ICommand ComposeCommand { get; }
        public ICommand RecordCommand { get; }
        public ICommand CopyCommand { get; }
        public WorkshareFacts? LastFacts => _facts;
        public string Message => _message;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Check before sync", RefreshCommand, primary: true),
            new FooterAction("Create worksets (dry run)", CreateCommand),
        };

        public override void Opened() { if (_facts == null) _ = Refresh(); else Rebuild(); }

        /// <summary>Roles this model links, for Z_Links_&lt;Role&gt;: chosen here, else the project's roles.</summary>
        private List<string> LinkedRoles() =>
            (_store.Get("workshare.linked") is string s ? s.Split('|') : _project.Request().Roles.ToArray()).Where(x => x.Length > 0).ToList();

        private static List<string> Items(string? text) =>
            (text ?? "").Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).Where(x => x.Length > 0).ToList();

        public void Rebuild()
        {
            Groups.Clear();
            var f = _facts;
            var model = new List<SettingItem>();
            if (f == null) model.Add(new NoteSetting("Reading the model's worksets…"));
            else
            {
                model.Add(new ReadOnlySetting("Model", f.Model, mono: true));
                model.Add(new ReadOnlySetting("Central model", f.Workshared ? (f.Central.Length > 0 ? f.Central : "Not found") : "Not workshared",
                    hint: f.Workshared ? "You: " + f.User : "Collaborate › Worksets in Revit makes it workshared."));
            }
            model.Add(_messages);
            Groups.Add(new SettingsGroup("This model", model.ToArray()));

            if (f != null && f.Workshared)
            {
                Groups.Add(new SettingsGroup("Worksets · " + f.Worksets.Count,
                    new TableSetting("", new[] { "Workset", "Editing now", "Name" },
                        f.Worksets.Select(w => new TableRow(w, w.Name, w.Owner.Length > 0 ? w.Owner : "—", w.Problem.Length > 0 ? "Fix" : "OK")), selectable: true,
                        hint: "Click a row to see a naming problem."),
                    new NoteSetting("Revit has no workset permissions. Assignments come with the team file; the coordinator can hold a workset by owning it.", ChipKind.Grey)));
                var table = (TableSetting)Groups.Last().Items[0];
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is WorksetLine w)
                        _status(w.Name + (w.Problem.Length > 0 ? ": " + w.Problem : ": named by the rule") + (w.Owner.Length > 0 ? " · editing: " + w.Owner : ""));
                };

                Groups.Add(new SettingsGroup("Standard set (MAN 9.10)",
                    new MultiSetting(_store, "workshare.linked", "Links from", ProjectPage.Roles, LinkedRoles(), hint: "Each role linked gets Z_Links_<Role>."),
                    new ReadOnlySetting("The set", string.Join(" · ", f.StandardSet), mono: true),
                    f.Missing.Count == 0 ? (SettingItem)new NoteSetting("The standard set is complete.", ChipKind.Good)
                        : new NoteSetting("Missing: " + string.Join(", ", f.Missing), ChipKind.Warn),
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Create the standard set (dry run)", CreateCommand, primary: f.Missing.Count > 0),
                        new SettingButton("New workset…", NewWorksetCommand),
                    }, "A dry run first, then a yes; refused on live projects. A person syncs to share them.")));

                Groups.Add(new SettingsGroup("Sync preflight (advice, not a guarantee)",
                    new TableSetting("", new[] { "Check", "State", "Detail" }, f.Preflight.Select(p => new TableRow(p, p.Check, p.State, p.Detail))),
                    new ButtonsSetting("", new[] { new SettingButton("Check before sync", RefreshCommand) })));

                var q = _project.Request();
                Groups.Add(new SettingsGroup("Sync message (required)",
                    new TextSetting("Revision worked on", "", "e.g. P02, or empty for general modelling", store: _store, key: "workshare.revision", mono: true),
                    new TextSetting("Review items worked on", "", "e.g. ISS-0014, ISS-0013", store: _store, key: "workshare.worked"),
                    new TextSetting("New items raised", "", "e.g. ISS-0015", store: _store, key: "workshare.raised"),
                    new TextSetting("What you did", "", "Short and plain, e.g. Beam B12 reduced, corridor ceiling reset", store: _store, key: "workshare.what"),
                    new ReadOnlySetting("Message", _message.Length > 0 ? _message : "Compose it to see it", mono: true,
                        hint: (q.Code.Length > 0 ? q.Code : "PROJ") + " | role | revision | Worked | New | what | who"),
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Compose", ComposeCommand, primary: true),
                        new SettingButton("Copy message", CopyCommand),
                        new SettingButton("Save to the sync log", RecordCommand),
                    }),
                    new NoteSetting("Paste the message into Revit's Synchronize with Central comment and sync there. The plugin and Claude never sync or save a shared model (rule 6).", ChipKind.Info)));
            }

            Groups.Add(new SettingsGroup("People, roles and team activity",
                new NoteSetting("Who is in which model, their modelling roles and who has unsynced work come with the team file (FMC_Team.json beside the central model). For helping people sync safely, never for ranking them (Manual 14.5).")));
            Groups.Add(new SettingsGroup("Scheduled sync",
                new NoteSetting("Not built: a tool never syncs a shared model (CLAUDE.md rule 6). Sync reminders come with the team file.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "workshare.considerations", _status)));
        }

        private async Task Refresh()
        {
            _status("Reading worksets…");
            var f = await _tools.FactsAsync(LinkedRoles());
            _facts = f.Ok ? f : null;
            _messages.Show(f.Ok ? ChipKind.Info : ChipKind.Bad, f.Message);
            _status(f.Message);
            Rebuild();
        }

        private async Task Create(IReadOnlyList<string> names)
        {
            var dry = await _tools.CreateAsync(names, LinkedRoles(), true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            if (dry.Details.Count == 0) { _messages.Show(ChipKind.Good, "The standard set is complete."); _status("The standard set is complete."); return; }
            _ask(DialogViewModel.WithItems("Create " + dry.Details.Count + " worksets?", "This changes the model. A person syncs to share them.",
                new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Create", async () =>
                {
                    var r = await _tools.CreateAsync(names, LinkedRoles(), false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Created.");
                    await Refresh();
                    return null;
                }));
        }

        private void AskNewWorkset()
        {
            var form = new InMemoryUserSettings();
            var name = new TextSetting("Name", "", "[Role]_[Content], e.g. A_Facade", store: new SettingStore(form, ""), key: "name", mono: true);
            _ask(DialogViewModel.WithItems("New workset", "Named by the rule (MAN 4.6). A dry run comes next.", new SettingItem[] { name }, "Next", async () =>
            {
                var n = (form.Get("name") ?? "").Trim();
                if (n.Length == 0) return "Name the workset.";
                await Create(new[] { n });
                return null;
            }));
        }

        private async Task Compose(bool record)
        {
            var q = _project.Request();
            var r = await _tools.MessageAsync(new SyncMessageRequest
            {
                ProjectCode = q.Code, ProjectFolder = q.Folder, Revision = (_store.Get("workshare.revision") ?? "").Trim().ToUpperInvariant(),
                Worked = Items(_store.Get("workshare.worked")), Raised = Items(_store.Get("workshare.raised")), What = _store.Get("workshare.what") ?? "",
            }, record);
            if (!r.Ok) { _messages.Show(ChipKind.Warn, r.Message); _status(r.Message); return; }
            _message = r.Text;
            _messages.Show(ChipKind.Good, r.Message);
            _status(r.Message);
            Rebuild();
        }

        private void Copy()
        {
            if (_message.Length == 0) { _messages.Show(ChipKind.Warn, "Compose the message first."); _status("Compose the message first."); return; }
            _copy(_message);
            _status("Message copied: paste it into Synchronize with Central.");
        }
    }
}
