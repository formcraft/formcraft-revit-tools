using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>One health-check line as a row: label, status chip, and its fix button when there is one.</summary>
    public sealed class CheckRow
    {
        public CheckRow(HealthCheck check, ICommand? fix)
        {
            Check = check;
            FixCommand = fix;
        }

        public HealthCheck Check { get; }
        public string Label => Check.Label;
        public string Status => Check.Status;
        public ChipKind Kind => Check.Kind;
        public string Detail => Check.Detail;
        public bool HasDetail => Check.Detail.Length > 0;
        public string FixLabel => Check.FixLabel;
        public bool HasFix => FixCommand != null && Check.FixLabel.Length > 0;
        public ICommand? FixCommand { get; }
    }

    /// <summary>The start-up health check as a Settings row (board core/PaneConnect).</summary>
    public sealed class CheckListSetting : SettingItem
    {
        public CheckListSetting(IEnumerable<CheckRow> rows, string hint = "") : base("", hint) { Rows = rows.ToList(); }
        public IReadOnlyList<CheckRow> Rows { get; }
        public string Summary => Rows.Any(r => r.Kind == ChipKind.Bad) ? "Something blocks the plugin: see the lines in red."
                               : Rows.Any(r => r.Kind == ChipKind.Warn) ? "The plugin works; the lines in amber need a look."
                               : "Everything the plugin needs is reachable.";
    }

    /// <summary>
    /// Connect (board core/PaneConnect): health, kit and rules, folders, chat through MCP, the AI buttons to come,
    /// safety, support. Live values come from <see cref="IConnectInfo"/> (the add-in in Revit), the kit service and the
    /// licence; the person's own choices are saved with their settings.
    /// </summary>
    public sealed class ConnectViewModel : ObservableObject
    {
        public static readonly string[] ClientKits = { "Formcraft (internal)", "[CLIENT A] Developments", "[CLIENT B] Health" };

        private readonly IConnectInfo _info;
        private readonly IKitService _kit;
        private readonly ILicenceService _licence;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Action _openKitSettings;
        private string _probe = "";

        public ConnectViewModel(IConnectInfo info, IKitService kit, ILicenceService licence, IUserSettings settings,
                                Action<string> status, Action<DialogViewModel> ask, Action openKitSettings)
        {
            _info = info;
            _kit = kit;
            _licence = licence;
            _settings = settings;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _openKitSettings = openKitSettings;
            HealthCheckCommand = new RelayCommand(ShowHealthCheck);
            FeedbackCommand = new RelayCommand(AskFeedback);
            _info.Changed += (_, __) => Rebuild();
            _licence.Changed += (_, __) => Rebuild();
            Rebuild();
        }

        public ObservableCollection<SettingsGroup> Groups { get; } = new ObservableCollection<SettingsGroup>();
        public ICommand HealthCheckCommand { get; }
        public ICommand FeedbackCommand { get; }

        /// <summary>AI in shared models (D1, CLAUDE.md rule 1): each person's own switch, never an admin's.</summary>
        public const string SharedModelsKey = "connect.sharedmodels";

        /// <summary>Every line of the health check: the host's, then kit, rulebooks, licence and the AI service.</summary>
        public IReadOnlyList<HealthCheck> AllChecks()
        {
            var list = new List<HealthCheck>(_info.Checks);
            var folder = _settings.Get(SettingKeys.KitFolder) ?? "";
            var kit = folder.Length == 0 ? null : _kit.Check(folder);
            if (kit == null || !kit.KitFound)
                list.Add(new HealthCheck("FMC Kit folder", folder.Length == 0 ? "Not set" : "Not found", ChipKind.Bad, "Point to the kit…", "kit",
                    "Every tool reads the kit from here. Set it in Settings › General › kit."));
            else
            {
                list.Add(new HealthCheck("FMC Kit folder", kit.IsSample ? "Sample kit" : "Found", kit.IsSample ? ChipKind.Warn : ChipKind.Good));
                foreach (var line in kit.Lines)
                    list.Add(new HealthCheck(line.Label, line.Status, line.Kind));
            }
            var l = _licence.Current;
            list.Add(new HealthCheck("Licence", !l.SignedIn ? "Signed out" : l.GraceOver ? "Sign in again" : l.Offline ? "Offline · " + l.OfflineDaysLeft + " days left" : l.Account?.Plan ?? "Active",
                !l.SignedIn || l.GraceOver ? ChipKind.Bad : l.Offline ? ChipKind.Warn : ChipKind.Good));
            list.Add(new HealthCheck("AI service", "Not used yet", ChipKind.Grey));
            return list;
        }

        public void Rebuild()
        {
            Groups.Clear();
            var checks = AllChecks().Select(c => new CheckRow(c, c.FixId.Length == 0 ? null : new AsyncCommand(() => Fix(c.FixId), _status))).ToList();
            Groups.Add(new SettingsGroup("Start-up health check",
                new CheckListSetting(checks),
                new NoteSetting("Offline mode: every feature works without internet. Only the AI buttons (Phase 2) need it.", ChipKind.Good)));

            var folder = _settings.Get(SettingKeys.KitFolder) ?? "";
            var kit = folder.Length == 0 ? null : _kit.Check(folder);
            Groups.Add(new SettingsGroup("Kit and rules",
                new ReadOnlySetting("FMC Kit folder", folder.Length == 0 ? "Not set" : folder, mono: true),
                new ButtonsSetting("", new[] { new SettingButton("Browse…", new RelayCommand(_openKitSettings)) }),
                new ChoiceSetting(_store, "connect.clientkit", "Client Kit", ClientKits, dropdown: true,
                    hint: "New clients come from the Formcraft account website, with their logo and disciplines."),
                new ReadOnlySetting("Rulebooks", kit?.Lines.FirstOrDefault(x => x.Label.StartsWith("Rulebooks"))?.Label ?? "From the kit"),
                new ReadOnlySetting("Kit version", kit?.Lines.FirstOrDefault(x => x.Label.StartsWith("FMC Kit"))?.Label ?? "No kit")));

            Groups.Add(new SettingsGroup("Folders the plugin may write",
                new ReadOnlySetting("Write roots", string.Join(Environment.NewLine, _info.WriteRoots), mono: true,
                    hint: "From " + _info.GuardPath + ". The only folders files may be written to."),
                new ReadOnlySetting("Never written", string.Join(" · ", _info.NeverWritten)),
                new ReadOnlySetting("Reports folder", _info.ReportsFolder, mono: true),
                new ButtonsSetting("", new[] { new SettingButton("Open reports folder", new RelayCommand(_info.OpenReportsFolder)) })));

            var service = new ServiceToggle(_info);
            Groups.Add(new SettingsGroup("AI connection (MCP) · experimental",
                new ToggleSetting(new SettingStore(service, ""), "on", "AI connection", false,
                    "Port " + _info.Port + ". Any AI app that speaks MCP connects here: Claude, ChatGPT, Copilot or a model on this PC. Hiding the pane never stops it."),
                new ReadOnlySetting("Tools offered", "Files and families with guard rails · document info · the pane (fmc_ui) · read-only model tools"),
                new ButtonsSetting("", new[] { new SettingButton("Probe the chain", new AsyncCommand(Probe, _status)) }, _probe),
                new NoteSetting("No feature needs an AI. Every AI request passes the same checks as a pane button.")));

            Groups.Add(new SettingsGroup("AI buttons · Phase 2",
                new ReadOnlySetting("API key", "Kept in Windows Credential Manager, never in logs or the kit"),
                new ReadOnlySetting("Monthly cap", "Set by your admin in Admin › AI"),
                new NoteSetting("Arrives after 1.0, so the engine proves itself first.")));

            Groups.Add(new SettingsGroup("Safety",
                new ToggleSetting(_store, SharedModelsKey, "AI in shared models", false,
                    "Setup tools on workshared models (D1). Only you set this; it never saves or syncs a model."),
                new ToggleSetting(_store, "connect.lock", "Live-model lock", true, _info.LiveModelLock
                    ? "AI model tools never run on live projects" : "Switched off in fmc_guard.json on this PC", locked: true, lockedWhy: "Set in fmc_guard.json"),
                new ToggleSetting(_store, "connect.dryrun", "Dry run first", true, "Every change shows its plan first", locked: true, lockedWhy: "Fixed principle"),
                new ToggleSetting(_store, "connect.neversave", "AI never saves, syncs or moves coordinates", true, "Fixed principle", locked: true, lockedWhy: "Fixed principle")));

            Groups.Add(new SettingsGroup("Support",
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Export diagnostics (zip)", new RelayCommand(ExportDiagnostics)),
                    new SettingButton("Send feedback", FeedbackCommand),
                }, "The zip and feedback never hold model content. You see exactly what is sent.")));

            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "connect.considerations", _status)));
        }

        private async System.Threading.Tasks.Task Fix(string id)
        {
            if (id == "kit") { _openKitSettings(); return; }
            await _info.FixAsync(id);
            _status("Checked again.");
        }

        private async System.Threading.Tasks.Task Probe()
        {
            _status("Probe: asking Revit through the MCP server…");
            _probe = await _info.ProbeAsync();
            _status(_probe);
            Rebuild();
        }

        /// <summary>The checklist as text, for the diagnostics zip and the feedback preview.</summary>
        public string ChecksText() => string.Join(Environment.NewLine, AllChecks().Select(c => c.Label + ": " + c.Status));

        private void ExportDiagnostics()
        {
            try { _status("Diagnostics saved: " + _info.ExportDiagnostics(ChecksText())); }
            catch (Exception e) { _status("Couldn't save the diagnostics: " + e.Message); }
        }

        /// <summary>Health check dialog (footer): every line, and Done.</summary>
        private void ShowHealthCheck()
        {
            _info.Refresh();
            var rows = new CheckListSetting(AllChecks().Select(c => new CheckRow(c, null)));
            _ask(DialogViewModel.WithItems("Health check", rows.Summary, new SettingItem[] { rows }, "Done",
                () => System.Threading.Tasks.Task.FromResult<string?>(null)));
        }

        /// <summary>Feedback dialog (board core/PaneConnect): kind, where, what happened, what to attach, a preview.</summary>
        private void AskFeedback()
        {
            var form = new InMemoryUserSettings();
            var store = new SettingStore(form, "");
            var kind = new ChoiceSetting(store, "kind", "Kind", new[] { "This was hard", "This was great", "Idea" });
            var where = new ChoiceSetting(store, "where", "Where", new[] { "Connect", "Project", "Templates", "Families", "Sheets", "Annotate", "Review", "Workshare", "QA", "Issue", "Touch" }, dropdown: true);
            var what = new TextSetting("What happened", "", "One or two lines", store: store, key: "what");
            var attach = new MultiSetting(store, "attach", "Attach (you choose)", new[] { "Last 20 log lines", "Revit and plugin version" },
                new[] { "Revit and plugin version" }, asChecks: true,
                hint: "Preview: plugin " + (typeof(ConnectViewModel).Assembly.GetName().Version?.ToString(3) ?? "0.1.0") + " · file paths removed. No model content.");
            _ask(DialogViewModel.WithItems("Send feedback", "", new SettingItem[] { kind, where, what, attach }, "Send", () =>
            {
                var text = kind.Selected + " · " + where.Selected + Environment.NewLine + (form.Get("what") ?? "") + Environment.NewLine +
                           "Attached: " + string.Join(", ", attach.On);
                if ((form.Get("what") ?? "").Trim().Length == 0) return System.Threading.Tasks.Task.FromResult<string?>("Say what happened in a line or two.");
                var path = _info.SaveFeedback(text + (attach.On.Contains("Revit and plugin version") ? Environment.NewLine + ChecksText() : ""));
                _status("Thanks. Feedback saved for sending: " + path);
                return System.Threading.Tasks.Task.FromResult<string?>(null);
            }));
        }

        /// <summary>The MCP service switch as a settings store, so it uses the ordinary switch row.</summary>
        private sealed class ServiceToggle : IUserSettings
        {
            private readonly IConnectInfo _info;
            public ServiceToggle(IConnectInfo info) { _info = info; }
            public string? Get(string key) => _info.ServiceRunning ? "true" : "false";
            public void Set(string key, string? value) => _info.SetService(value == "true");
            public bool IsPartOn(string partId) => true;
            public void SetPart(string partId, bool on) { }
            public event EventHandler? Changed { add { } remove { } }
        }
    }
}
