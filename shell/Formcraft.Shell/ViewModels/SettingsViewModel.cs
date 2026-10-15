using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    public sealed class SettingsGroup
    {
        public SettingsGroup(string title, params SettingItem[] items)
        {
            Title = title;
            Items = items;
        }

        public string Title { get; }
        public IReadOnlyList<SettingItem> Items { get; }
    }

    public sealed class SettingsTab
    {
        public SettingsTab(string name, FmcModule module, IReadOnlyList<SettingsGroup> groups)
        {
            Name = name;
            Module = module;
            Groups = groups;
        }

        public string Name { get; }
        public FmcModule Module { get; }
        public bool IsAccount => Name == "Account";
        public IReadOnlyList<SettingsGroup> Groups { get; }
    }

    /// <summary>
    /// The one Settings page (boards core/PaneSettings, account/PaneAccount, */PaneSettings*): Account and General always,
    /// then a tab for each licensed module with its parts, its ribbon buttons and its settings. Values are saved for the
    /// person in settings.json and never loosen a team rule (locked rows stay locked).
    /// </summary>
    public sealed class SettingsViewModel : ObservableObject
    {
        /// <summary>The shell's version (Formcraft.Shell.csproj Version).</summary>
        public static string ProductVersion => typeof(SettingsViewModel).Assembly.GetName().Version is Version v ? v.ToString(3) : "0.1.0";

        public static readonly string[] AllTabs = { "Account", "General", "Manage", "Flow", "Model", "Build", "Updates" };

        private readonly ILicenceService _licence;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly ObservableCollection<ModuleParts> _parts;
        private readonly ThemeService _theme;
        private readonly IKitService _kit;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly IUpdateService _updates;
        private readonly Action _openLog;
        private readonly ITouchService? _touch;
        private readonly IFlowTools _flow;
        private readonly ILiveDataService? _liveData;
        private readonly List<Action> _touchRefresh = new List<Action>();
        private SettingsTab? _current;

        public SettingsViewModel(ILicenceService licence, IUserSettings settings, ObservableCollection<ModuleParts> parts, ThemeService theme,
                                 IKitService kit, Action<string> status, Action<DialogViewModel> ask, IUpdateService? updates = null, Action? openLog = null,
                                 ITouchService? touch = null, IFlowTools? flow = null, ILiveDataService? liveData = null)
        {
            _touch = touch;
            _liveData = liveData;
            _flow = flow ?? new MockFlowTools();
            if (_touch != null) _touch.Changed += (_, __) => { foreach (var refresh in _touchRefresh) refresh(); };
            _updates = updates ?? new MockUpdateService();
            _openLog = openLog ?? (() => { });
            _updates.Changed += (_, __) => { if (Current?.Name == "Updates") Rebuild(); };
            _licence = licence;
            _settings = settings;
            _store = new SettingStore(settings);
            _parts = parts;
            _theme = theme;
            _kit = kit;
            _status = status;
            _ask = ask;
            ApplyTheme();
            Rebuild();
            // Another model opened, or the switch changed: the Manage tab shows the open model's setting.
            if (_liveData != null) _liveData.Changed += (_, __) => Rebuild();
        }

        public ObservableCollection<SettingsTab> Tabs { get; } = new ObservableCollection<SettingsTab>();
        public IReadOnlyList<string> TabNames => Tabs.Select(t => t.Name).ToList();

        /// <summary>The open tab's name, for the segmented control. Remembered for next time.</summary>
        public string CurrentName
        {
            get => Current?.Name ?? "Account";
            set
            {
                var tab = Tabs.FirstOrDefault(t => t.Name == value);
                if (tab == null || tab == Current) return;
                Current = tab;
                _store.Set("tab", value);
            }
        }

        public SettingsTab? Current
        {
            get => _current;
            private set
            {
                if (!Set(ref _current, value)) return;
                OnPropertyChanged(nameof(CurrentName));
                OnPropertyChanged(nameof(IsAccount));
                OnPropertyChanged(nameof(IsGroups));
                OnPropertyChanged(nameof(TabHint));
            }
        }

        public bool IsAccount => Current?.IsAccount == true;
        public bool IsGroups => !IsAccount;

        /// <summary>The line under the tab switcher, from each board.</summary>
        public string TabHint => Current?.Name switch
        {
            "Account" => "Account and licence sit first in Settings.",
            "General" => "One Settings for every module. General is Core's; a module's tab appears when it is licensed.",
            "Updates" => "Version, updates that wait for Revit to close, rollback and support.",
            _ => "One Settings page. General is Core's; each licensed module adds a tab.",
        };

        /// <summary>Module tabs appear and go with the licence; parts follow the parts switches.</summary>
        public void Rebuild()
        {
            // The tab the person last chose, even if its module wasn't licensed a moment ago (before sign-in).
            var keep = _store.Get("tab") ?? Current?.Name ?? "Account";
            _touchRefresh.Clear();
            Tabs.Clear();
            Tabs.Add(new SettingsTab("Account", FmcModule.Core, new SettingsGroup[0]));
            Tabs.Add(new SettingsTab("General", FmcModule.Core, General()));
            foreach (var m in new[] { FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build })
                if (Licensed(m)) Tabs.Add(new SettingsTab(m.ToString(), m, ModuleTab(m)));
            Tabs.Add(new SettingsTab("Updates", FmcModule.Core, Updates()));
            OnPropertyChanged(nameof(TabNames));
            _current = null;
            Current = Tabs.FirstOrDefault(t => t.Name == keep) ?? Tabs[0];
        }

        /// <summary>Opens a tab from elsewhere (a module tab link, search).</summary>
        public void Open(string tab) => CurrentName = tab;

        /// <summary>The group the view scrolls to and focuses (search, banners: F-012). Raised again for the same group.</summary>
        public string? FocusGroup { get; private set; }

        /// <summary>Opens a tab on one group: the view brings it into view and puts the cursor in its first field.</summary>
        public void Open(string tab, string? focus)
        {
            CurrentName = tab;
            FocusGroup = focus;
            OnPropertyChanged(nameof(FocusGroup));
        }

        private bool Licensed(FmcModule m) => _licence.Current.For(m).CanUse;

        private string Status(FmcModule m) =>
            m == FmcModule.Core ? "Always" : Licensed(m) ? "Licensed" : "Not licensed";

        private ChipKind Kind(FmcModule m) =>
            m == FmcModule.Core || Licensed(m) ? ChipKind.Good : ChipKind.Grey;

        private void ApplyTheme()
        {
            var saved = _store.Get("general.theme");
            _theme.Choice = saved == "Light" ? ThemeChoice.Light : saved == "Dark" ? ThemeChoice.Dark : ThemeChoice.FollowRevit;
        }

        // ---------- General (core/PaneSettings) ----------
        private IReadOnlyList<SettingsGroup> General()
        {
            var a = _licence.Current.Account;
            var disciplines = (_settings.Get(SettingKeys.Disciplines) ?? "").Replace(",", ", ");
            var who = a == null ? "Not signed in" : a.Name + " · " + a.Role + (disciplines.Length > 0 ? " · disciplines " + disciplines : "");
            var kit = _kit.Check(_settings.Get(SettingKeys.KitFolder) ?? WelcomeViewModel.DefaultKitFolder);
            var rulebooks = kit.Lines.FirstOrDefault(l => l.Label.StartsWith("Rulebooks v"))?.Label.Substring("Rulebooks ".Length) ?? "not found";
            var modules = string.Join(" + ", new[] { FmcModule.Core, FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build }
                .Where(m => m == FmcModule.Core || Licensed(m)));

            return new[]
            {
                new SettingsGroup("Modules",
                    new WorksWithSetting(new[] { FmcModule.Core, FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build }
                        .Select(m => new WorksWithRow(m + (m == FmcModule.Core ? " · always" : Licensed(m) ? " · licensed" : " · not yet"),
                                                      m == FmcModule.Core ? "Always" : Licensed(m) ? "Licensed" : "Not yet", Kind(m))).ToList())),
                new SettingsGroup("General · you",
                    new ReadOnlySetting("Name and role", who),
                    new ReadOnlySetting("Revit user name", Environment.UserName, "Checked against the team file once Admin has the team (U07).")),
                new SettingsGroup("General · kit",
                    new TextSetting("Formcraft kit folder", WelcomeViewModel.DefaultKitFolder, store: new SettingStore(_settings, ""), key: SettingKeys.KitFolder, mono: true,
                        hint: "Your BIM Manager gives you this path. " + (kit.KitFound
                            ? string.Join(" · ", kit.Lines.Select(l => l.Label + ": " + l.Status))
                            : "No kit found here: kit tools wait until it is.")),
                    new ButtonsSetting("", new[] { new SettingButton("Check the kit again", new RelayCommand(() => { Rebuild(); _status("Kit checked."); })) })),
                new SettingsGroup("General · pane",
                    new ChoiceSetting(_store, "general.theme", "Theme", new[] { "Follow Revit", "Light", "Dark" }, changed: _ => ApplyTheme()),
                    new ChoiceSetting(_store, "general.textsize", "Text size", new[] { "Normal", "Large" }),
                    new ChoiceSetting(_store, "general.openon", "Open on", new[] { "Home: start-of-day card", "The last section I used", "QA" }, dropdown: true),
                    new ReadOnlySetting("Narrowest", "320 px"),
                    new ReadOnlySetting("Widest", "560 px", "Below 400 px the pane switches to its compact layout; above 560 px the content stops growing so lines stay readable."),
                    new ToggleSetting(_store, "general.tour", "Show the first-run tour again", false),
                    new NoteSetting("Which parts of each module show in the pane is set in that module's tab, or with its parts switch on the ribbon.")),
                new SettingsGroup("General · start-of-day card and notifications",
                    new ToggleSetting(_store, "general.card", "Show the card when I open a model", true),
                    new MultiSetting(_store, "general.tellme", "Tell me when",
                        new[] { "A review item is assigned to me", "An item I raised is solved", "A scheduled sync is coming (60 s)", "My feedback ships" },
                        new[] { "A review item is assigned to me", "An item I raised is solved", "A scheduled sync is coming (60 s)" }, asChecks: true),
                    new ChoiceSetting(_store, "general.how", "How", new[] { "In the pane", "Pane and email" })),
                new SettingsGroup("General · defaults, privacy, updates",
                    new ChoiceSetting(_store, "general.units", "Units shown", new[] { "mm, m², m³", "m, m², m³" }),
                    new ChoiceSetting(_store, "general.language", "Language", new[] { "English (UK)", "English (US)" }, dropdown: true),
                    new ToggleSetting(_store, "general.usage", "Share anonymous usage counts", false, "Never model content or names"),
                    new ChoiceSetting(_store, "general.channel", "Update channel", new[] { "Stable", "Beta (testers)" }),
                    new ReadOnlySetting("Version", "Formcraft " + ProductVersion + " · " + modules + " · rulebooks " + rulebooks)),
                new SettingsGroup("Module tabs",
                    new ButtonsSetting("", new[] { FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build }
                        .Where(Licensed)
                        .Select(m => new SettingButton("Settings › " + m, new RelayCommand(() => Open(m.ToString())))).ToList(),
                        "Each module keeps its settings in its own tab, with its parts switch and its two ribbon buttons. A module that isn't licensed has no tab yet."),
                    new NoteSetting("General holds what Core gives every module.")),
                new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "general.considerations", _status)),
            };
        }

        // ---------- Updates (account/PaneUpdates) ----------
        private IReadOnlyList<SettingsGroup> Updates()
        {
            var kit = _kit.Check(_settings.Get(SettingKeys.KitFolder) ?? WelcomeViewModel.DefaultKitFolder);
            var kitLine = kit.KitFound ? string.Join(" · ", kit.Lines.Where(l => l.Label.StartsWith("FMC Kit") || l.Label.StartsWith("Rulebooks")).Select(l => l.Label.Replace(" found", ""))) : "Kit not found";
            var modules = string.Join(", ", new[] { FmcModule.Core, FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build }
                .Where(m => m == FmcModule.Core || Licensed(m))
                .Select(m => m + (_licence.Current.For(m).Status == ModuleStatus.Trial ? " (trial)" : "")));
            var available = _updates.Available;
            var groups = new List<SettingsGroup>
            {
                new SettingsGroup("Formcraft for Revit",
                    new ReadOnlySetting("Installed", _updates.Installed + " · " + modules + " · Revit 2025"),
                    new ReadOnlySetting("Kit", kitLine),
                    // The same setting as General › Update channel.
                    new ChoiceSetting(_store, "general.channel", "Update channel", new[] { "Stable", "Beta (testers)" })),
            };
            if (_updates.Feed == null)
                groups.Add(new SettingsGroup("Updates", new NoteSetting(NoFeed, ChipKind.Info)));
            if (available != null)
            {
                groups.Add(new SettingsGroup(_updates.Feed == "sample" ? "Update available · sample feed (preview only)" : "Update available",
                    new ReadOnlySetting(available.Version, available.Notes + " · " + available.Gates),
                    new NoteSetting(_updates.UpdatePending
                        ? available.Version + " installs when Revit closes. Your settings are kept; " + _updates.Installed + " is kept for rollback."
                        : "Before updating: close Revit or the update waits until it closes. Your settings are kept. The previous version is kept for rollback.",
                        _updates.UpdatePending ? ChipKind.Good : ChipKind.Info),
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Update when Revit closes", new RelayCommand(() => { _updates.UpdateWhenRevitCloses(); _status(available.Version + " installs when Revit closes."); }), primary: true),
                        new SettingButton("Release notes", new RelayCommand(() => _status("Release notes: " + available.Notes + "."))),
                        new SettingButton("Roll back to " + (_updates.RollbackVersion ?? "—"), new RelayCommand(AskRollBack)),
                    })));
            }
            groups.Add(new SettingsGroup("Help and support",
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Guide", new RelayCommand(() => _status("Guide: opens the Formcraft guide at this section."))),
                    new SettingButton("Replay the tour", new RelayCommand(() => { _store.Set("general.tour", "true"); _status("The 2-minute tour plays next time the pane opens."); })),
                    new SettingButton("Send a support report", new RelayCommand(() => _status("Support report made: versions and log rows, no model content (Manual 7.7)."))),
                    new SettingButton("Open the log file", new RelayCommand(_openLog)),
                }, "A support report holds versions and log rows, never model content.")));
            groups.Add(new SettingsGroup("Legal",
                new ReadOnlySetting("Licence terms and privacy", "Formcraft terms · Data Protection Act 2019 notice")));
            return groups;
        }

        /// <summary>Said instead of "latest version" while there is no update feed (F-013).</summary>
        public const string NoFeed = "No update feed yet: updates come with the installer. On the pilot PC the Formcraft Updater installs each new build when Revit is closed.";

        public void CheckForUpdates()
        {
            _ = _updates.CheckAsync(_store.Get("general.channel") ?? "Stable");
            _status(_updates.Feed == null ? NoFeed
                : _updates.Available == null ? "You have the latest version."
                : "Update " + _updates.Available.Version + " is available" + (_updates.Feed == "sample" ? " (sample feed, preview only)." : "."));
        }

        private void AskRollBack() => _ask(new DialogViewModel("Roll back to " + (_updates.RollbackVersion ?? "—"),
            "Puts the previous version back when Revit closes. Your settings are kept.", "Roll back",
            () => { _updates.RollBack(); _status("Rolls back to " + _updates.RollbackVersion + " when Revit closes."); return System.Threading.Tasks.Task.CompletedTask; }));

        // ---------- Module tabs (*/PaneSettings*) ----------
        private IReadOnlyList<SettingsGroup> ModuleTab(FmcModule m)
        {
            var groups = new List<SettingsGroup>();
            var parts = _parts.FirstOrDefault(p => p.Module == m);
            if (parts != null) groups.Add(new SettingsGroup(m + " · parts in the pane", new PartsSetting(parts)));
            groups.AddRange(m switch
            {
                FmcModule.Manage => Manage(),
                FmcModule.Flow => Flow(),
                FmcModule.Model => Model(),
                _ => Build(),
            });
            groups.Add(new SettingsGroup("Works with", new WorksWithSetting(WorksWith(m)), new NoteSetting("A module that isn't licensed is simply skipped; nothing breaks.", ChipKind.Good)));
            groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, m.ToString().ToLowerInvariant() + ".considerations", _status)));
            return groups;
        }

        private SettingsGroup Ribbon(string module, string[] options, int first, int second) => new SettingsGroup(module + " · ribbon buttons",
            new ReadOnlySetting("Big button", module + " parts (fixed)"),
            new ChoiceSetting(_store, module.ToLowerInvariant() + ".small1", "Small button 1", options, first, dropdown: true),
            new ChoiceSetting(_store, module.ToLowerInvariant() + ".small2", "Small button 2", options, second, dropdown: true),
            new NoteSetting("Three tools per module on the ribbon, never more. Everything else is in the pane and Ctrl+K."));

        private IEnumerable<SettingsGroup> Manage() => new[]
        {
            Ribbon("Manage", new[] { "Run QA", "Raise issue", "Ready to issue", "Sync reminder" }, 0, 1),
            new SettingsGroup("Manage · sync and start-of-day card",
                new ChoiceSetting(_store, "manage.sync", "Remind me to sync after", new[] { "2 hours", "1 hour", "Never" }),
                new NoteSetting("A reminder only: you synchronise with central in Revit. No tool saves or syncs a workshared model.", ChipKind.Warn),
                new MultiSetting(_store, "manage.card", "Show on my card",
                    new[] { "Issues assigned to me", "QA on this model", "Ready to issue status", "Links changed since reload" },
                    new[] { "Issues assigned to me", "QA on this model", "Ready to issue status", "Links changed since reload" }, asChecks: true)),
            new SettingsGroup("Manage · QA and issues",
                new ChoiceSetting(_store, "manage.runqa", "Run QA", new[] { "When I press Run QA", "On open and before issue" }, dropdown: true),
                new ReadOnlySetting("QA reports", @"06_QA\Health\", mono: true),
                new ChoiceSetting(_store, "manage.issuesto", "New issues go to", new[] { "Me", "BIM Coordinator" }, dropdown: true),
                new ReadOnlySetting("Issue IDs and statuses", "F26001-ISS-#### · Open, In progress, Resolved, Closed (Manual 10.5)")),
            new SettingsGroup("Manage · materials",
                new ChoiceSetting(_store, "manage.library", "Material library", new[] { @"FMC Materials v1.0 · 00_Standards\12_Materials", "Project copy" }, dropdown: true),
                new ToggleSetting(_store, "manage.textures", "Show texture previews", true),
                new ReadOnlySetting("Library owner", "Visualisation Lead · names FMC_[Group]_[Description]")),
            LiveData(),
        };

        public const string LiveDataGroup = "Manage · keep FMC data filled";

        /// <summary>The BIM Manager (or an admin) switches "Keep FMC data filled" on per project; others see it.</summary>
        private bool MaySwitchLiveData()
        {
            var a = _licence.Current.Account;
            return a != null && (a.IsAdmin || a.Role.IndexOf("BIM Manager", StringComparison.OrdinalIgnoreCase) >= 0);
        }

        /// <summary>
        /// Keep FMC data filled (docs/LIVE_DATA.md): Revit fills derived FMC fields as people model, per project, off by
        /// default. The setting lives in the model, so everyone on the project gets it after they sync.
        /// </summary>
        private SettingsGroup LiveData()
        {
            const string fills = "Fills only copies and look-ups as people model: FMC_Keynote_Code from the type's Keynote, "
                + "FMC_Code_Description and FMC_Code_Group from the kit, FMC_Role_Code from the model's file name, FMC_Panel_ID "
                + "from the board's Panel Name, FMC_Circuit_Ref as panel/circuit, and FMC_Data_Sync_Stamp. Only where the field "
                + "exists; a value a person typed is kept unless the field is a pure copy.";
            const string never = "Never sizes, ratings, loads, demand factors or anything a professional decides. Never saves or "
                + "syncs: you sync in Revit. Every value it fills is logged (no names).";
            if (_liveData == null)
                return new SettingsGroup(LiveDataGroup,
                    new NoteSetting("Keep FMC data filled runs in Revit, from the Formcraft add-in."),
                    new NoteSetting(fills), new NoteSetting(never, ChipKind.Warn));

            var s = _liveData.Current;
            var items = new List<SettingItem>();
            if (!s.Applies)
            {
                items.Add(new ReadOnlySetting("This project", s.Model.Length == 0 ? "No model open" : s.Model, s.Why));
            }
            else
            {
                var state = s.On
                    ? "On" + (s.By.Length > 0 ? " · switched on by " + s.By : "") + (s.At.Length > 0 ? " · " + s.At.Replace("T", " ") : "")
                    : "Off";
                items.Add(new ReadOnlySetting("This project", state, s.Model));
                if (s.On) items.Add(new ReadOnlySetting("Filled in this session", s.FilledThisSession + " values"));
                if (MaySwitchLiveData())
                    items.Add(new ButtonsSetting("", new[]
                    {
                        s.On
                            ? new SettingButton("Switch off for this project", new RelayCommand(() => AskLiveData(false)))
                            : new SettingButton("Switch on for this project", new RelayCommand(() => AskLiveData(true)), primary: true),
                    }));
                else
                    items.Add(new NoteSetting("Only the BIM Manager switches this on or off for a project.", ChipKind.Info));
            }
            items.Add(new NoteSetting(fills));
            items.Add(new NoteSetting(never, ChipKind.Warn));
            items.Add(new ReadOnlySetting("Log", _liveData.LogPath, mono: true));
            return new SettingsGroup(LiveDataGroup, items.ToArray());
        }

        private void AskLiveData(bool on)
        {
            var model = _liveData?.Current.Model ?? "";
            _ask(on
                ? new DialogViewModel("Keep FMC data filled",
                    "Switch on for " + model + "? From now on Revit fills the derived FMC fields on elements people add or change, "
                    + "as part of their own change (one Undo). Nothing is filled until someone changes the model. The setting is "
                    + "saved in the model: sync so the team gets it.", "Switch on",
                    () => { _liveData?.SetOn(true, _status); return System.Threading.Tasks.Task.CompletedTask; })
                : new DialogViewModel("Keep FMC data filled",
                    "Switch off for " + model + "? Values already filled stay as they are.", "Switch off",
                    () => { _liveData?.SetOn(false, _status); return System.Threading.Tasks.Task.CompletedTask; }));
        }

        private IEnumerable<SettingsGroup> Flow() => new[]
        {
            Ribbon("Flow", new[] { "Touch on", "Section box", "View range", "Tag Tidy", "Align" }, 0, 1),
        }.Concat(Touch()).Concat(new[]
        {
            new SettingsGroup("Flow · sheet layout and tags",
                new ChoiceSetting(_store, "flow.align", "Align viewports to", new[] { "Sheet grid from Manage", "Title block guides only" }, dropdown: true,
                    hint: Licensed(FmcModule.Manage) ? "" : "Manage isn't licensed, so the sheet grid falls back to title block guides."),
                new ToggleSetting(_store, "flow.ghost", "Ghost preview before moving", true),
                new MultiSetting(_store, "flow.tagtidy", "Tag Tidy defaults",
                    new[] { "Leaders never cross", "One elbow", "Clear of geometry", "Keep text horizontal" },
                    new[] { "Leaders never cross", "One elbow", "Clear of geometry", "Keep text horizontal" }, asChecks: true)),
            new SettingsGroup("Flow · 3D and shortcuts",
                new ChoiceSetting(_store, "flow.boxoffset", "Section box offset", new[] { "300 mm around the area", "500 mm", "1 m" }, dropdown: true),
                new ToggleSetting(_store, "flow.boxlevels", "Level-aware: box from the plan's level to the level above", true),
                new ReadOnlySetting("Shortcuts", "The kit has no Formcraft shortcuts file yet"),
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Keyboard Shortcuts", new RelayCommand(AskApplyShortcuts)),
                })),
        });

        /// <summary>
        /// Settings › Flow › Touch (board flow/PaneFlowTouch): the master switch, touch per view, gestures and what shows
        /// on the view, all live: a change applies at once and is saved on this computer. Gestures follow board
        /// flow/Flow_Gestures.
        /// </summary>
        private IEnumerable<SettingsGroup> Touch()
        {
            if (_touch == null)
                return new[] { new SettingsGroup("Flow · touch", new NoteSetting("Touch runs in Revit 2025 and later, from the Formcraft add-in.")) };
            if (!_touch.Available)
                return new[] { new SettingsGroup("Flow · touch", new NoteSetting(_touch.Problem, ChipKind.Warn),
                    new ButtonsSetting("", new[] { new SettingButton("Touch probe", new RelayCommand(() => _touch.OpenProbe())) })) };

            var store = new SettingStore(new TouchSettingsStore(_touch), "");
            ToggleSetting Toggle(string key, string label, string hint = "")
            {
                var t = new ToggleSetting(store, key, label, TouchKeys.Defaults.TryGetValue(key, out var d) && d == "true", hint);
                _touchRefresh.Add(t.Refresh);
                return t;
            }
            ChoiceSetting Choice(string key, string label, string[] options, bool dropdown = false, string hint = "")
            {
                var c = new ChoiceSetting(store, key, label, options, Array.IndexOf(options, TouchKeys.Defaults[key]), dropdown, hint);
                _touchRefresh.Add(c.Refresh);
                return c;
            }

            var views = new TouchViewsSetting(_touch);
            _touchRefresh.Add(views.Update);
            return new[]
            {
                new SettingsGroup("Flow · touch",
                    Toggle(TouchSettingsStore.MasterKey, "Touch on", "Master switch · also Touch on on the ribbon and Touch in the quick tools strip"),
                    views,
                    Choice(TouchKeys.NewViews, "New views start with touch", TouchKeys.NewViewsOptions),
                    new MultiSetting(store, TouchKeys.ViewTypes, "By view type", TouchKeys.ViewTypeOptions, TouchKeys.Defaults[TouchKeys.ViewTypes].Split('|'),
                        hint: "Used when new views start with touch by view type.")),
                new SettingsGroup("Flow · gestures",
                    Choice(TouchKeys.SelectWith, "Select elements with", TouchKeys.SelectWithOptions,
                        hint: "Long press selects, so orbit and zoom never select by accident."),
                    Choice(TouchKeys.Tap, "Single tap", TouchKeys.TapOptions),
                    Choice(TouchKeys.TwoFingerTap, "Two-finger tap", TouchKeys.TwoFingerTapOptions),
                    Choice(TouchKeys.DoubleTap, "Double tap", TouchKeys.DoubleTapOptions),
                    Choice(TouchKeys.Drag3D, "One-finger drag in 3D", TouchKeys.Drag3DOptions),
                    Choice(TouchKeys.Drag2D, "One-finger drag in plans, sections and sheets", TouchKeys.Drag2DOptions),
                    Choice(TouchKeys.Zoom, "Zoom sensitivity", TouchKeys.SpeedOptions),
                    Choice(TouchKeys.Orbit, "Orbit speed", TouchKeys.SpeedOptions),
                    Toggle(TouchKeys.InvertZoom, "Invert pinch zoom"),
                    new NoteSetting("Pinch zooms about your fingers; two fingers pan in any view.")),
                new SettingsGroup("Flow · on the view",
                    Toggle(TouchKeys.Frame, "Thin Studio Green frame on views Flow handles"),
                    Toggle(TouchKeys.Ring, "Ring that fills while holding to select"),
                    Toggle(TouchKeys.Badge, "'Touch on' badge in the view corner", "Tap the badge to switch touch for that view."),
                    new NoteSetting("Moving a finger while holding turns the press into a pan, so nothing is selected by accident."),
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Reset touch settings", new RelayCommand(AskResetTouch)),
                        new SettingButton("Touch probe", new RelayCommand(() => _touch.OpenProbe())),
                    })),
            };
        }

        private void AskResetTouch() => _ask(new DialogViewModel("Reset touch settings",
            "Puts gestures and sensitivity back to the defaults on this computer.", "Reset",
            () => { _touch?.ResetToDefaults(); _status("Touch settings are back to the defaults."); return System.Threading.Tasks.Task.CompletedTask; }));

        private IEnumerable<SettingsGroup> Model() => new[]
        {
            Ribbon("Model", new[] { "Check system", "Quantities", "Diagram" }, 0, 1),
            new SettingsGroup("Model · systems",
                new ChoiceSetting(_store, "model.pack", "Electrical rules pack", new[] { "Formcraft electrical pack (engineer-approved)", "Client pack…" }, dropdown: true),
                new NoteSetting("Rules packs are data in the kit. An engineer approves a pack; demand factors stay the engineer's.", ChipKind.Warn),
                new MultiSetting(_store, "model.systems", "Systems I work on",
                    new[] { "Power", "Small power", "Lighting", "Fire alarm", "ICT", "Cold water", "HVAC" }, new[] { "Power", "Small power", "Lighting" }),
                new ChoiceSetting(_store, "model.diagram", "Diagram detail", new[] { "Boards and feeders", "Down to final circuits" })),
            new SettingsGroup("Model · structural",
                new ReadOnlySetting("Design basis", "Set per project by the Structural EoR (Manual 2.3)"),
                new ReadOnlySetting("Analysis", "Robot via the Autodesk link · results in FMC_FEA_*"),
                new ToggleSetting(_store, "model.sectionapproval", "Section changes need SEoR approval", true, locked: true, lockedWhy: "Never decided for a professional (CLAUDE.md rule 5).")),
            new SettingsGroup("Model · enrich and links",
                new ToggleSetting(_store, "model.realdata", "Keep real data; only fill blanks", true, locked: true, lockedWhy: "Team rule."),
                new ToggleSetting(_store, "model.flagguess", "Flag every guess for review", true, locked: true, lockedWhy: "Team rule."),
                new MultiSetting(_store, "model.links", "Include links from", new[] { "ARC", "STR", "ELE", "PLB", "MEC", "ELV" }, new[] { "ARC", "STR" })),
        };

        private IEnumerable<SettingsGroup> Build() => new[]
        {
            new SettingsGroup("Build · ribbon buttons",
                new ReadOnlySetting("On the ribbon", "Build parts · Workspace · Web app"),
                new NoteSetting("Everything else lives in the workspace window (in Revit) or the web app (for outsiders).")),
            new SettingsGroup("Build · views on the model",
                new ChoiceSetting(_store, "build.colour", "Colour the active view by", new[] { "Nothing", "Progress", "Package" }),
                new ReadOnlySetting("Filters use", "FMC_Construction_Status · FMC_Trade_Package", mono: true)),
            new SettingsGroup("Build · BoQ and rates",
                new ReadOnlySetting("BoQ", "fmc_boq_build.py · MR-xxx rules · PKG-01 to PKG-14", mono: true),
                new ReadOnlySetting("Rates", "Rates sheet · Approved rows only, never typed"),
                new ToggleSetting(_store, "build.showrates", "Show rates", true, "Your role allows it", locked: true, lockedWhy: "Set by your role in Admin.")),
            new SettingsGroup("Build · 4D and web app",
                new ReadOnlySetting("4D link", "FMC_Task_ID + FMC_Zone · programme stays in P6 / MS Project"),
                new ReadOnlySetting("Web app", "[WEB APP ADDRESS] on the Formcraft CDE"),
                new ToggleSetting(_store, "build.outsiders", "Outsiders' accounts", false, "Read only, expire after 30 days", locked: true, lockedWhy: "Set by Admin.")),
        };

        private IReadOnlyList<WorksWithRow> WorksWith(FmcModule m)
        {
            (FmcModule With, string What)[] rows = m switch
            {
                FmcModule.Manage => new[] { (FmcModule.Core, "pane, Connect AI, log file, roles"), (FmcModule.Flow, "sheet and annotation rules"), (FmcModule.Model, "families, materials, QA"), (FmcModule.Build, "schedules and issues") },
                FmcModule.Flow => new[] { (FmcModule.Core, "pane, licence, log file"), (FmcModule.Manage, "sheet grid, annotation standard"), (FmcModule.Model, "system tags and colours"), (FmcModule.Build, "package views on sheets") },
                FmcModule.Model => new[] { (FmcModule.Core, "pane, Connect AI, log file"), (FmcModule.Manage, "families, materials, QA"), (FmcModule.Flow, "touch and section box"), (FmcModule.Build, "quantities") },
                _ => new[] { (FmcModule.Core, "pane, Connect AI, log file, roles"), (FmcModule.Manage, "schedules, finishes, issues"), (FmcModule.Model, "quantities"), (FmcModule.Flow, "package views on sheets") },
            };
            return rows.Select(r => new WorksWithRow(r.With + ": " + r.What, Status(r.With), Kind(r.With))).ToList();
        }

        /// <summary>Board core/PaneSettings dialog: Revit applies shortcuts through its own import, so the last click is there.</summary>
        // Rule 7: the shortcuts standard comes from the kit, and the kit has none yet, so nothing is merged or applied
        // here; Revit's own Keyboard Shortcuts dialog opens for an import or export by hand.
        private void AskApplyShortcuts() => _ask(new DialogViewModel("Keyboard Shortcuts",
            "The kit has no Formcraft shortcuts file yet, so there is no standard to apply. Revit's Keyboard Shortcuts opens: " +
            "export yours there first if you change anything.",
            "Open in Revit",
            () => { _flow.OpenShortcutsImport(); _status("Shortcuts: Revit's Keyboard Shortcuts is open."); return System.Threading.Tasks.Task.CompletedTask; }));

        /// <summary>Board core/PaneSettings dialog: puts the person's General and module settings back to the defaults.</summary>
        public void AskReset() => _ask(new DialogViewModel("Reset my settings",
            "Puts your General, Manage and Flow settings back to the defaults. Admin and project settings are not touched.",
            "Reset",
            () =>
            {
                foreach (var key in SettingKeysToReset()) _store.Set(key, null);
                ApplyTheme();
                Rebuild();
                _status("Your settings are back to the defaults.");
                return System.Threading.Tasks.Task.CompletedTask;
            }));

        private IEnumerable<string> SettingKeysToReset()
        {
            var keys = new List<string>();
            foreach (var tab in Tabs)
                foreach (var g in tab.Groups)
                    foreach (var item in g.Items)
                        keys.AddRange(KeysOf(item));
            return keys.Distinct();
        }

        private static IEnumerable<string> KeysOf(SettingItem item) => item switch
        {
            ChoiceSetting c => new[] { c.KeyForReset },
            ToggleSetting t => new[] { t.KeyForReset },
            MultiSetting mu => new[] { mu.KeyForReset },
            ConsiderationsSetting cs => new[] { cs.KeyForReset + ".text", cs.KeyForReset + ".saved" },
            _ => new string[0],
        };
    }
}
