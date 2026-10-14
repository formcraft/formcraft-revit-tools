using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Model › Start from brief (board model/PaneModelBrief, U23): reads the approved Concept Information Set and sets up a
    /// new model from it: levels, Project Information, the room programme as unplaced rooms, and the chosen kit families.
    /// Information only, never geometry; blanks stay blank; only on a new, unsaved model; dry run first, one Undo.
    /// </summary>
    public sealed class BriefPage : SectionPage
    {
        private readonly IBriefTools _tools;
        private readonly IFilePicker _picker;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private BriefPlan? _plan;

        public BriefPage(IBriefTools tools, IFilePicker picker, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Model › Start from brief", "Sets up a new model from the approved concept: levels, Project Information, rooms and families. Never geometry.")
        {
            _tools = tools;
            _picker = picker;
            _settings = settings;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            ReadCommand = new AsyncCommand(Read, status);
            DryRunCommand = new AsyncCommand(DryRun, status);
            Rebuild();
        }

        public ICommand ReadCommand { get; }
        public ICommand DryRunCommand { get; }
        public MessagesSetting Messages => _messages;
        public BriefPlan? Plan => _plan;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Read CIS", ReadCommand),
            new FooterAction("Dry run", DryRunCommand, primary: true),
        };

        public string CisFile => _store.Get("model.cis") ?? "";
        private string Kit => _settings.Get(SettingKeys.KitFolder) ?? "";

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(new SettingsGroup("Approved concept",
                new TextSetting("Concept Information Set", CisFile, "…\\F26001_CIS_R4.json", store: _store, key: "model.cis", mono: true,
                    hint: "The CIS approved with the concept booklet, as JSON (fmc-cis/0.1, docs/CIS.md)."),
                new ButtonsSetting("", new[] { new SettingButton("Browse", new RelayCommand(Browse)), new SettingButton("Read CIS", ReadCommand, primary: true) }),
                _plan == null ? (SettingItem)new NoteSetting("Runs only on a new, unsaved model started from the kit template. On a saved or live model it is locked.", ChipKind.Info)
                    : _plan.ModelProblem.Length > 0 ? new NoteSetting(_plan.ModelProblem + ".", ChipKind.Warn)
                    : new ReadOnlySetting("New model", _plan.Model + " · not saved yet")));
            if (_plan == null) return;
            if (!_plan.Ok)
            {
                Groups.Add(new SettingsGroup("What will be created", new NoteSetting(_plan.Message, ChipKind.Bad), _messages));
                return;
            }
            var created = new List<SettingItem>
            {
                new ReadOnlySetting("CIS", $"{_plan.Project} · {_plan.Revision} · approved {_plan.Approved}"),
                new TableSetting("", new[] { "Will create", "Count" }, new[]
                {
                    new TableRow(null, "Levels with their floor plans", _plan.Levels.ToString()),
                    new TableRow(null, "Project Information values", _plan.ProjectInfo.ToString()),
                    new TableRow(null, "Rooms, unplaced, with programme data", _plan.Rooms.ToString()),
                    new TableRow(null, "Door and window families from the kit", _plan.Families.ToString()),
                    new TableRow(null, "Blank in the CIS: left blank", _plan.Blanks.Count.ToString()),
                }),
            };
            if (_plan.RoomRows.Count > 0)
                created.Add(new TableSetting("Rooms (first rows)", new[] { "No.", "Name", "Target m²", "Finish set" },
                    _plan.RoomRows.Take(6).Select(r => new TableRow(r, r.Number, r.Name, r.Area, r.Finish))));
            foreach (var p in _plan.Problems) created.Add(new NoteSetting(p, ChipKind.Bad));
            foreach (var s in _plan.Skipped) created.Add(new NoteSetting(s, ChipKind.Grey));
            created.Add(new ButtonsSetting("", new[] { new SettingButton("Dry run", DryRunCommand, primary: true) }));
            created.Add(_messages);
            Groups.Add(new SettingsGroup("What will be created", created.ToArray()));
            Groups.Add(new SettingsGroup("After it runs",
                new NoteSetting("Place the rooms once walls exist (a modeller's job), then run the brief compliance check in Check › QA.", ChipKind.Info),
                new NoteSetting("It never draws walls or other geometry, never saves, and never guesses a blank.", ChipKind.Warn)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "model.brief.considerations", _status)));
        }

        private void Browse()
        {
            var file = _picker.Open("Concept Information Set", "CIS (*.json)|*.json", System.IO.Path.GetDirectoryName(CisFile) ?? "");
            if (file == null) return;
            _store.Set("model.cis", file);
            _plan = null;
            Rebuild();
        }

        private bool Ready()
        {
            string why = CisFile.Length == 0 ? "Choose the CIS file first." : Kit.Length == 0 ? "Set the kit folder in Settings › General first." : "";
            if (why.Length == 0) return true;
            _messages.Show(ChipKind.Warn, why);
            _status(why);
            return false;
        }

        private async Task Read()
        {
            if (!Ready()) return;
            _plan = await _tools.PlanAsync(CisFile, Kit);
            Rebuild();
            _status(_plan.Ok ? (_plan.Problems.Count > 0 ? $"The CIS has {_plan.Problems.Count} problems to fix first." : _plan.Message) : _plan.Message);
        }

        private async Task DryRun()
        {
            if (!Ready()) return;
            if (_plan == null) await Read();
            if (_plan == null || !_plan.Ok) return;
            if (_plan.Problems.Count > 0) { _messages.Show(ChipKind.Warn, "Fix the CIS problems first: the kit wins."); _status("Fix the CIS problems first."); return; }
            if (_plan.ModelProblem.Length > 0) { _messages.Show(ChipKind.Warn, _plan.ModelProblem + "."); _status(_plan.ModelProblem + "."); return; }
            var dry = await _tools.ApplyAsync(CisFile, Kit, dryRun: true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            _ask(DialogViewModel.WithItems("Start from brief · dry run", "Nothing is written until you approve. One Undo, then a log line in FMC_MCP_FileLog.csv.",
                new SettingItem[] { new ReadOnlySetting("Will create", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Create", async () =>
                {
                    var r = await _tools.ApplyAsync(CisFile, Kit, dryRun: false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    return null;
                }));
        }
    }
}
