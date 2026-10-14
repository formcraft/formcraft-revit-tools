using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    public enum ShellScreen { SignIn, Welcome, Main }

    /// <summary>What the pane body shows: a section, or a page opened from the header.</summary>
    public enum ShellPage { Section, Connect, Settings, Admin }

    /// <summary>One section button in the pane (e.g. Setup › Project).</summary>
    public sealed class SectionItem : ObservableObject
    {
        private bool _isSelected;

        public SectionItem(string group, string name, FmcModule module, string? moduleTag, string phase, string board = "")
        {
            Group = group;
            Name = name;
            Module = module;
            ModuleTag = moduleTag;
            Phase = phase;
            Board = board;
        }

        public string Group { get; }
        public string Name { get; }
        public FmcModule Module { get; }
        public string? ModuleTag { get; }
        /// <summary>Roadmap phase or UI step that fills this section in (shown until it is built).</summary>
        public string Phase { get; }
        /// <summary>Its board under design/boards (core/PaneConnect...).</summary>
        public string Board { get; }
        /// <summary>Key of the section's icon in Theme/FmcIcons.xaml.</summary>
        public string IconKey => "Icon." + Name;
        public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }
    }

    public sealed class GroupItem : ObservableObject
    {
        private bool _isSelected;

        public GroupItem(string name, IEnumerable<SectionItem> sections)
        {
            Name = name;
            Sections = new ObservableCollection<SectionItem>(sections);
        }

        public string Name { get; }
        public ObservableCollection<SectionItem> Sections { get; }
        public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }
    }

    /// <summary>What the body shows for a section: the feature, or why it is locked.</summary>
    public sealed class SectionBody
    {
        public SectionBody(SectionItem section, ModuleLicence licence, bool graceOver = false)
        {
            Section = section;
            Licence = licence;
            GraceOver = graceOver && section.Module != FmcModule.Core;
        }

        public SectionItem Section { get; }
        public ModuleLicence Licence { get; }
        /// <summary>Offline grace is over: only Connect, the log and Help work until the person signs in.</summary>
        public bool GraceOver { get; }
        public bool Locked => GraceOver || !Licence.CanUse;
        public bool NotLicensed => !GraceOver && !Licence.CanUse;
        public string Title => Section.Group.Length == 0 ? Section.Name : Section.Group + " › " + Section.Name;
        public string LockedText => GraceOver ? "Sign in to keep using Formcraft." : "Formcraft " + Section.Module + " isn't on your licence.";
        public string WhatItAdds => ModulePitch.WhatItAdds(Section.Module);
        public string PlaceholderText => "This section is drawn on the central canvas and is built in " + Section.Phase + ". The shell, navigation and licence checks around it already work.";
    }

    /// <summary>A button in the footer bar. Each section supplies its own (its board's footer).</summary>
    public sealed class FooterAction
    {
        public FooterAction(string label, ICommand command, bool primary = false, bool ai = false)
        {
            Label = label;
            Command = command;
            Primary = primary;
            Ai = ai;
        }

        public string Label { get; }
        public ICommand Command { get; }
        public bool Primary { get; }
        public bool Ai { get; }
    }

    public sealed class ShellViewModel : ObservableObject
    {
        public const string ReadyStatus = "Revit 2025 · Formcraft 0.1 (shell preview)";

        private readonly ILicenceService _licence;
        private readonly IConnectionService _connection;
        private readonly IDocumentContext _document;
        private readonly IUserSettings _settings;
        private readonly SectionRegistry _registry;
        private readonly IKitService _kit;
        private StateBannerInfo? _stateBanner;
        private readonly SectionItem _connect = new SectionItem("", "Connect", FmcModule.Core, null, "U12", "core/PaneConnect");
        private readonly SectionItem _admin = new SectionItem("", "Admin", FmcModule.Core, null, "U07", "core/PaneAdmin");
        private ShellScreen _screen = ShellScreen.SignIn;
        private ShellPage _page = ShellPage.Section;
        private GroupItem? _group;
        private SectionItem? _section;
        private SectionBody? _body;
        private DialogViewModel? _dialog;
        private string _status = ReadyStatus;
        private SectionItem? _shownSection;

        public ShellViewModel(ILicenceService licence, IConnectionService connection, IDocumentContext document,
                              IUserSettings settings, SectionRegistry? registry = null, IKitService? kit = null, ThemeService? theme = null,
                              IAdminService? admin = null, IUpdateService? updates = null, ITouchService? touch = null,
                              IConnectInfo? connect = null, IFamilyTools? families = null, IFileTools? files = null, IFilePicker? picker = null,
                              IProjectTools? project = null, ITemplateTools? templates = null,
                              ILibraryTools? library = null, IQaTools? qa = null,
                              IMaterialTools? materials = null, ISheetTools? sheets = null,
                              IAnnotateTools? annotate = null, IIssueTools? issue = null, ILinkTools? links = null, IWorkshareTools? workshare = null, IReviewTools? review = null, IReportTools? reports = null,
                              IFlowTools? flow = null, IBriefTools? brief = null)
        {
            _licence = licence;
            _connection = connection;
            _document = document;
            _settings = settings;
            _registry = registry ?? SectionRegistry.Default;
            _kit = kit ?? new FolderKitService();
            StartTrialCommand = new AsyncCommand(StartTrialAsync, s => Status = s);
            AskAdminCommand = new AsyncCommand(AskAdminAsync, s => Status = s);
            SeeWhatItDoesCommand = new RelayCommand(() => Status = (Body?.Section.Module.ToString() ?? "This module") + ": see what it does on the Formcraft account website.");
            SignInAgainCommand = new AsyncCommand(() => _licence.SignOutAsync(), s => Status = s);
            CheckLicenceCommand = new AsyncCommand(async () => { await _licence.CheckNowAsync(); Status = "Licence checked."; }, s => Status = s);
            Groups = new ObservableCollection<GroupItem>();
            Parts = new ObservableCollection<ModuleParts>();
            SignIn = new SignInViewModel(licence, settings, s => Status = s, ShowDialog);
            Welcome = new WelcomeViewModel(settings, kit ?? new FolderKitService(), Parts, () => _licence.Current.Account?.Role ?? "",
                                           () => Screen = ShellScreen.Main, s => Status = s);
            Welcome.StepChanged += (_, __) => UpdateFooter();
            Account = new AccountViewModel(licence, s => Status = s, ShowDialog);
            Settings = new SettingsViewModel(licence, settings, Parts, theme ?? ThemeService.Shared, kit ?? new FolderKitService(), s => Status = s, ShowDialog,
                                             updates, () => OpenLogRequested?.Invoke(this, EventArgs.Empty), touch, flow);
            Settings.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(SettingsViewModel.CurrentName)) UpdateFooter(); };
            CheckUpdatesCommand = new RelayCommand(() => Settings.CheckForUpdates());
            Connect = new ConnectViewModel(connect ?? new MockConnectInfo(), kit ?? new FolderKitService(), licence, settings, s => Status = s, ShowDialog,
                                           () => OpenSettingsTab("General", "Kit folder: Settings › General › kit.", "General · kit"));
            // Setup sections the pane builds itself (the families and files tools that were the Formcraft Browser).
            Project = new ProjectPage(project ?? new MockProjectTools(), settings, picker ?? new WindowsFilePicker(), s => Status = s, ShowDialog);
            Families = new FamiliesPage(families ?? new MockFamilyTools(), library ?? new MockLibraryTools(), picker ?? new WindowsFilePicker(), settings, s => Status = s, ShowDialog);
            Templates = new TemplatesPage(files ?? new MockFileTools(), templates ?? new MockTemplateTools(), picker ?? new WindowsFilePicker(), settings, Project, s => Status = s, ShowDialog);
            Qa = new QaPage(qa ?? new MockQaTools(), Project, settings, s => Status = s);
            Rules = new RulesPage(qa ?? new MockQaTools(), settings, () => IsAdmin, s => Status = s, ShowDialog);
            Materials = new MaterialsPage(materials ?? new MockMaterialTools(), settings, s => Status = s, ShowDialog);
            _hostSections["Materials"] = Materials;
            Sheets = new SheetsPage(sheets ?? new MockSheetTools(), Project, picker ?? new WindowsFilePicker(), settings, s => Status = s, ShowDialog,
                                    () => { var issue = Groups.SelectMany(g => g.Sections).FirstOrDefault(x => x.Name == "Issue"); if (issue != null) SelectSection(issue); });
            _hostSections["Sheets"] = Sheets;
            Annotate = new AnnotatePage(annotate ?? new MockAnnotateTools(), qa ?? new MockQaTools(), settings, s => Status = s, ShowDialog);
            _hostSections["Annotate"] = Annotate;
            Issue = new IssuePage(issue ?? new MockIssueTools(), qa ?? new MockQaTools(), Project, () => Sheets.Register(), settings, s => Status = s, ShowDialog);
            _hostSections["Issue"] = Issue;
            Links = new LinksPage(links ?? new MockLinkTools(), Project, picker ?? new WindowsFilePicker(), settings, s => Status = s, ShowDialog);
            _hostSections["Links"] = Links;
            Workshare = new WorksharePage(workshare ?? new MockWorkshareTools(), Project, settings, s => Status = s, ShowDialog);
            _hostSections["Workshare"] = Workshare;
            Review = new ReviewPage(review ?? new MockReviewTools(), qa ?? new MockQaTools(), Project, settings,
                                    () => _licence.Current.Account?.Name ?? "", s => Status = s, ShowDialog);
            _hostSections["Review"] = Review;
            Reports = new ReportsPage(reports ?? new MockReportTools(), Project, settings, s => Status = s, ShowDialog);
            _hostSections["Reports"] = Reports;
            Brief = new BriefPage(brief ?? new MockBriefTools(), picker ?? new WindowsFilePicker(), settings, s => Status = s, ShowDialog);
            _hostSections["Brief"] = Brief;
            _hostSections["QA"] = Qa;
            _hostSections["Rules"] = Rules;
            _hostSections["Project"] = Project;
            _hostSections["Families"] = Families;
            _hostSections["Templates"] = Templates;
            Admin = new AdminViewModel(admin ?? new MockAdminService(), licence, s => Status = s, ShowDialog);
            OpenTeamFileCommand = new RelayCommand(() => Status = @"Open team file: <project>\FMC_Team.json beside the central model (with the team file, U12).");
            SaveAdminCommand = new RelayCommand(() => Status = "Saved. Admin changes are logged in the audit log as you make them.");
            SaveSettingsCommand = new RelayCommand(() => Status = "Saved. Settings are saved for you as you change them.");
            ResetSettingsCommand = new RelayCommand(() => Settings.AskReset());
            Search = new SearchViewModel(_registry, () => Groups.SelectMany(g => g.Sections),
                                         m => _licence.Current.For(m).CanUse, AnyShown, OpenResult);
            SelectGroupCommand = new RelayCommand(p => { if (p is GroupItem g) SelectGroup(g); });
            SelectSectionCommand = new RelayCommand(p => { if (p is SectionItem s) SelectSection(s); });
            OpenConnectCommand = new RelayCommand(() => Open(ShellPage.Connect));
            OpenSettingsCommand = new RelayCommand(() => Open(ShellPage.Settings));
            // The Admin button is only shown to admins; the check here keeps it that way for keyboard and MCP too.
            OpenAdminCommand = new RelayCommand(() => { if (IsAdmin) Open(ShellPage.Admin); });
            HelpCommand = new RelayCommand(() => Status = "Help: opens this section of the guide and the first-run tour.");
            // Board flow/PaneFlowTouch: Touch in the quick tools strip opens Settings › Flow › Touch.
            // U22: Section box, Align (Sheet Layout) and Tag Tidy run in Revit; each asks first and is one Undo.
            var flowTools = flow ?? new MockFlowTools();
            QuickToolCommand = new RelayCommand(p =>
            {
                var tool = p as string ?? "";
                if (tool == "Touch") OpenSettingsTab("Flow", "Touch: master switch, views, gestures and what shows on the view.");
                else
                {
                    flowTools.Run(tool);
                    Status = tool + ": " + FlowHint(tool);
                }
            });
            _licence.Changed += (_, __) => OnLicenceChanged();
            _connection.Changed += (_, __) => { OnPropertyChanged(nameof(IsConnected)); OnPropertyChanged(nameof(ConnectionText)); OnPropertyChanged(nameof(ConnectionTip)); UpdateState(); };
            _document.Changed += (_, __) => OnPropertyChanged(nameof(Document));
            _settings.Changed += (_, __) => { Rebuild(); UpdateState(); };
            Rebuild();
            UpdateState();
            UpdateFooter();
        }

        public AsyncCommand StartTrialCommand { get; }
        public AsyncCommand AskAdminCommand { get; }
        public RelayCommand SeeWhatItDoesCommand { get; }
        public AsyncCommand SignInAgainCommand { get; }
        public AsyncCommand CheckLicenceCommand { get; }

        /// <summary>The state banner (board account/PaneStates), or null when all is well.</summary>
        public StateBannerInfo? StateBanner
        {
            get => _stateBanner;
            private set
            {
                if (!Set(ref _stateBanner, value)) return;
                OnPropertyChanged(nameof(State));
                OnPropertyChanged(nameof(HasStateBanner));
                OnPropertyChanged(nameof(RevitReady));
            }
        }

        public PaneState State => StateBanner?.State ?? PaneState.Normal;
        public bool HasStateBanner => StateBanner != null;
        /// <summary>Revit busy: nothing new starts (footer buttons wait).</summary>
        public bool RevitReady => State != PaneState.RevitBusy;

        /// <summary>Works out the state, the most urgent first. Never touches what the person has typed.</summary>
        private void UpdateState()
        {
            var l = _licence.Current;
            StateBannerInfo? s = null;
            if (!l.SignedIn) s = null;
            else if (l.GraceOver)
                s = new StateBannerInfo(PaneState.GraceOver, ChipKind.Bad, "Sign in to keep using Formcraft", "Connect, Log and Help still work", "Sign in", SignInAgainCommand);
            // No banner for the AI connection being off: the chip by the pane title shows it and opens Connect, and the
            // ribbon has Connect AI. A banner here took space from every page (your feedback, 14 Oct).
            else if (_connection.State == ConnectionState.RevitBusy)
                s = new StateBannerInfo(PaneState.RevitBusy, ChipKind.Grey, "Waiting for Revit to finish…", "Nothing new starts until Revit is ready");
            else if (!_kit.Check(_settings.Get(SettingKeys.KitFolder) ?? WelcomeViewModel.DefaultKitFolder).KitFound)
                s = new StateBannerInfo(PaneState.KitMissing, ChipKind.Warn, "Point to the kit folder in Settings", "Connect and Settings still work", "Open Settings",
                    new RelayCommand(() => { if (Page != ShellPage.Settings) Open(ShellPage.Settings); Settings.Open("General", "General · kit"); }));
            else if (l.Offline)
            {
                var days = l.LastOnlineCheck is DateTime t ? Math.Max(0, (DateTime.Today - t.Date).Days) : 0;
                s = new StateBannerInfo(PaneState.Offline, ChipKind.Info,
                    "Licence checked " + (days == 0 ? "today" : days == 1 ? "1 day ago" : days + " days ago") + " · " + l.OfflineDaysLeft + " days left",
                    "Everything still works", "Check now", CheckLicenceCommand);
            }
            StateBanner = s;
        }

        private async System.Threading.Tasks.Task StartTrialAsync()
        {
            if (Body == null) return;
            var module = Body.Section.Module;
            Status = await _licence.StartTrialAsync(module)
                ? "Formcraft " + module + " trial started: 14 days."
                : "A trial of " + module + " couldn't start here. Ask your admin.";
        }

        private async System.Threading.Tasks.Task AskAdminAsync()
        {
            if (Body == null) return;
            await _licence.RequestModuleAsync(Body.Section.Module);
            Status = "Request for " + Body.Section.Module + " sent to your admin (Admin › Licences and seats › Requests).";
        }

        public SignInViewModel SignIn { get; }
        public WelcomeViewModel Welcome { get; }
        public AccountViewModel Account { get; }
        public ObservableCollection<GroupItem> Groups { get; }
        public RelayCommand SelectGroupCommand { get; }
        public RelayCommand SelectSectionCommand { get; }
        public RelayCommand OpenConnectCommand { get; }
        public RelayCommand OpenSettingsCommand { get; }
        public RelayCommand OpenAdminCommand { get; }
        public RelayCommand HelpCommand { get; }
        public RelayCommand QuickToolCommand { get; }

        /// <summary>What the person does next in Revit for each Flow tool.</summary>
        public static string FlowHint(string tool) => tool switch
        {
            "Section Box" or "Section box" => "on a floor plan, drag the area; your own 3D view opens with the box.",
            "Align" or "Sheet Layout" => "on a sheet, select the viewports (or none for all) and pick how to line them up.",
            "Tag Tidy" => "select the tags in the view, then pick how to tidy them.",
            _ => "runs in Revit.",
        };

        public ShellScreen Screen
        {
            get => _screen;
            set
            {
                if (Set(ref _screen, value))
                {
                    OnPropertyChanged(nameof(IsSignIn));
                    OnPropertyChanged(nameof(IsWelcome));
                    OnPropertyChanged(nameof(IsMain));
                    UpdateFooter();
                }
            }
        }

        public bool IsSignIn => Screen == ShellScreen.SignIn;
        public bool IsWelcome => Screen == ShellScreen.Welcome;
        public bool IsMain => Screen == ShellScreen.Main;

        // Header: the Connected chip is the Revit/Claude service; licence problems show in the state banners (U08).
        public bool IsConnected => _connection.State != ConnectionState.NotConnected;
        public string ConnectionText => IsConnected ? "Connected" : "Not connected";
        /// <summary>The chip by the pane title is where the AI connection shows; clicking it opens Connect.</summary>
        public string ConnectionTip => IsConnected ? "AI connection on. Connect: health, kit, folders, safety, AI"
                                                   : "AI connection off: click to open Connect and switch it on (or Core › Connect AI on the ribbon)";
        public bool IsAdmin => _licence.Current.Account?.IsAdmin == true;

        /// <summary>Touch, Section Box and Tag Tidy: only when Flow is on the licence.</summary>
        public bool ShowQuickTools => _licence.Current.SignedIn && _licence.Current.For(FmcModule.Flow).CanUse && QuickTools.Count > 0;
        /// <summary>Quick tools whose Flow part is on (Touch, Section Box, Tag Tidy).</summary>
        public ObservableCollection<string> QuickTools { get; } = new ObservableCollection<string>();

        /// <summary>Raised to open the Log file window (board core/UI_Log); the view opens it.</summary>
        public event EventHandler? OpenLogRequested;

        /// <summary>The log the window reads: FMC_MCP_FileLog.csv in the reports folder (the host can point elsewhere).</summary>
        public string LogPath { get; set; } = CsvLogReader.DefaultPath;
        public RelayCommand CheckUpdatesCommand { get; }

        /// <summary>The one Settings page with its tabs (boards core/PaneSettings, account/PaneAccount, */PaneSettings*).</summary>
        public SettingsViewModel Settings { get; }
        public RelayCommand SaveSettingsCommand { get; }
        public RelayCommand ResetSettingsCommand { get; }

        /// <summary>Admin (boards core/PaneAdmin, account/PaneSeats). Only admins can open it.</summary>
        public AdminViewModel Admin { get; }
        public RelayCommand OpenTeamFileCommand { get; }
        public RelayCommand SaveAdminCommand { get; }

        /// <summary>Ctrl+K search (board core/UI_Palette).</summary>
        public SearchViewModel Search { get; }

        /// <summary>Settings: parts in the pane, one row of switches per licensed module.</summary>
        public ObservableCollection<ModuleParts> Parts { get; }

        /// <summary>Every part is off: the body says how to get them back.</summary>
        public bool NoParts => Groups.Count == 0;
        public bool ShowNoParts => NoParts && Page == ShellPage.Section;

        public DocumentInfo Document => _document.Current;

        public ShellPage Page
        {
            get => _page;
            private set
            {
                if (!Set(ref _page, value)) return;
                OnPropertyChanged(nameof(IsConnectOpen));
                OnPropertyChanged(nameof(SettingsOpen));
                OnPropertyChanged(nameof(IsAdminOpen));
                OnPropertyChanged(nameof(ShowNoParts));
                OnHostChanged();
                UpdateFooter();
            }
        }

        public bool IsConnectOpen => Page == ShellPage.Connect;
        public bool SettingsOpen => Page == ShellPage.Settings;
        public bool IsAdminOpen => Page == ShellPage.Admin;
        /// <summary>A section's placeholder or locked state; hidden while the host supplies the section (<see cref="HostContent"/>).</summary>
        public bool ShowSection => Page == ShellPage.Section && HostContent == null;

        /// <summary>Connect (board core/PaneConnect).</summary>
        public ConnectViewModel Connect { get; }
        /// <summary>Drawings › Annotate: the kit's annotation standard against the model.</summary>
        public AnnotatePage Annotate { get; }

        /// <summary>Drawings › Issue: the readiness check, exceptions and the issue into 01_WIP\_Issue.</summary>
        public IssuePage Issue { get; }

        /// <summary>Team › Links: coordinates, the links audit, link and pin.</summary>
        public LinksPage Links { get; }

        /// <summary>Team › Workshare: worksets by the rule, the sync preflight and message; never syncs.</summary>
        public WorksharePage Workshare { get; }

        /// <summary>Team › Review: the project's review register (MAN 10.5).</summary>
        public ReviewPage Review { get; }

        /// <summary>Check › Reports: reports traced to the plugin's own saved files.</summary>
        public ReportsPage Reports { get; }

        /// <summary>Model › Start from brief: a new model set up from the approved concept (U23).</summary>
        public BriefPage Brief { get; }
        /// <summary>Drawings › Sheets: the register against the model.</summary>
        public SheetsPage Sheets { get; }
        /// <summary>Setup › Materials: the kit's material database.</summary>
        public MaterialsPage Materials { get; }
        /// <summary>Check › QA: the kit's rules run on the open model.</summary>
        public QaPage Qa { get; }
        /// <summary>Check › Rules: the kit's rulebooks.</summary>
        public RulesPage Rules { get; }
        /// <summary>Setup › Project: start a project (folder tree, manifest, models).</summary>
        public ProjectPage Project { get; }
        /// <summary>Setup › Families: the family builder from the kit.</summary>
        public FamiliesPage Families { get; }
        /// <summary>Setup › Templates: new files from a template and the files open in Revit.</summary>
        public TemplatesPage Templates { get; }

        private readonly Dictionary<string, object> _hostSections = new Dictionary<string, object>();

        /// <summary>A section with its own page instead of the placeholder (the pane's own pages, or one the host supplies).</summary>
        public void SetHostSection(string sectionName, object content)
        {
            _hostSections[sectionName] = content;
            OnHostChanged();
        }

        /// <summary>The host's content for the open section, if it supplies one and the section isn't locked.</summary>
        public object? HostContent => Page == ShellPage.Section && _section != null && Body?.Locked != true &&
                                      _hostSections.TryGetValue(_section.Name, out var content) ? content : null;
        public bool ShowHostSection => HostContent != null;

        private void OnHostChanged()
        {
            OnPropertyChanged(nameof(HostContent));
            OnPropertyChanged(nameof(ShowHostSection));
            OnPropertyChanged(nameof(ShowSection));
        }

        public GroupItem? CurrentGroup { get => _group; private set => Set(ref _group, value); }
        public SectionBody? Body { get => _body; private set => Set(ref _body, value); }
        public string Status { get => _status; set => Set(ref _status, value); }

        /// <summary>The footer's buttons for what is open. Sections fill this as they are built (Stage C).</summary>
        public ObservableCollection<FooterAction> FooterActions { get; } = new ObservableCollection<FooterAction>();

        public DialogViewModel? Dialog
        {
            get => _dialog;
            private set { if (Set(ref _dialog, value)) OnPropertyChanged(nameof(IsDialogOpen)); }
        }

        /// <summary>Two-way with FmcDialog.IsOpen, so Esc and the close button clear the dialog.</summary>
        public bool IsDialogOpen
        {
            get => Dialog != null;
            set { if (!value) Dialog = null; }
        }

        public void ShowDialog(DialogViewModel dialog)
        {
            dialog.Attach(() => { if (Dialog == dialog) Dialog = null; }, s => Status = s);
            Dialog = dialog;
        }

        private void SelectGroup(GroupItem g)
        {
            foreach (var x in Groups) x.IsSelected = x == g;
            CurrentGroup = g;
            SelectSection(g.Sections.First());
        }

        private void SelectSection(SectionItem s)
        {
            foreach (var g in Groups)
            {
                g.IsSelected = g.Sections.Contains(s);
                foreach (var x in g.Sections) x.IsSelected = x == s;
            }
            // A section opened from search or elsewhere brings its group's buttons with it.
            CurrentGroup = Groups.FirstOrDefault(g => g.Sections.Contains(s)) ?? CurrentGroup;
            _section = s;
            // A footer message belongs to the section that wrote it (F-006): a new section starts clean.
            if (s != _shownSection) Status = ReadyStatus;
            _shownSection = s;
            Page = ShellPage.Section;
            Body = new SectionBody(s, _licence.Current.For(s.Module), _licence.Current.GraceOver);
            OnHostChanged();
            (HostContent as SectionPage)?.Opened();
            UpdateFooter();
        }

        /// <summary>Opens a header page; pressing its button again goes back to the section.</summary>
        private void Open(ShellPage page)
        {
            if (Page == page)
            {
                if (_section != null) SelectSection(_section);
                return;
            }
            // As on the boards: while a header page is open, no group tab or section is selected.
            foreach (var g in Groups)
            {
                g.IsSelected = false;
                foreach (var x in g.Sections) x.IsSelected = false;
            }
            Page = page;
            if (page == ShellPage.Connect) Body = new SectionBody(_connect, _licence.Current.For(FmcModule.Core));
            if (page == ShellPage.Admin) Body = new SectionBody(_admin, _licence.Current.For(FmcModule.Core));
        }

        private void OnLicenceChanged()
        {
            OnPropertyChanged(nameof(IsAdmin));
            if (!_licence.Current.SignedIn) Screen = ShellScreen.SignIn;
            else if (Screen == ShellScreen.SignIn)
            {
                // First run on this PC: four short steps; afterwards straight to the pane.
                if (_settings.GetBool(SettingKeys.SetupDone, false)) Screen = ShellScreen.Main;
                else
                {
                    Welcome.Restart();
                    Screen = ShellScreen.Welcome;
                }
            }
            if (Page == ShellPage.Admin && !IsAdmin) Page = ShellPage.Section;
            Rebuild();
            Settings.Rebuild();
            Admin.Rebuild();
            Account.Refresh();
            UpdateState();
        }

        /// <summary>The footer's buttons for the screen (boards: sign in: Sign in, Work offline; first run: Back, Next).</summary>
        private void UpdateFooter()
        {
            FooterActions.Clear();
            if (Screen == ShellScreen.SignIn)
            {
                FooterActions.Add(new FooterAction("Sign in", SignIn.SignInCommand, primary: true));
                FooterActions.Add(new FooterAction("Work offline", SignIn.WorkOfflineCommand));
            }
            else if (Screen == ShellScreen.Welcome)
            {
                FooterActions.Add(new FooterAction("Back", Welcome.BackCommand));
                FooterActions.Add(new FooterAction(Welcome.NextText, Welcome.NextCommand, primary: true));
                Status = Welcome.StepText;
            }
            else if (Page == ShellPage.Section && Body?.NotLicensed == true)
            {
                // Board account/PaneStates footer.
                FooterActions.Add(new FooterAction("Start a trial", StartTrialCommand, primary: true));
            }
            else if (Page == ShellPage.Section && HostContent is SectionPage page)
            {
                foreach (var action in page.Footer) FooterActions.Add(action);
            }
            else if (Page == ShellPage.Connect)
            {
                // Board core/PaneConnect footer.
                FooterActions.Add(new FooterAction("Health check", Connect.HealthCheckCommand, primary: true));
                FooterActions.Add(new FooterAction("Feedback", Connect.FeedbackCommand));
            }
            else if (Page == ShellPage.Admin)
            {
                // Board core/PaneAdmin footer.
                FooterActions.Add(new FooterAction("Open team file", OpenTeamFileCommand));
                FooterActions.Add(new FooterAction("Save", SaveAdminCommand, primary: true));
            }
            else if (Page == ShellPage.Settings)
            {
                // Board core/PaneSettings footer; Updates adds "Check for updates" (account/PaneUpdates).
                if (Settings.CurrentName == "Updates") FooterActions.Add(new FooterAction("Check for updates", CheckUpdatesCommand));
                FooterActions.Add(new FooterAction("Save", SaveSettingsCommand, primary: true));
                FooterActions.Add(new FooterAction("Reset mine", ResetSettingsCommand));
            }
        }

        /// <summary>
        /// A part counts only while its module is licensed: a module you don't have shows its sections with the
        /// locked page instead (U08), whatever was switched off before.
        /// </summary>
        private bool PartShown(string id)
        {
            var part = _registry.Part(id);
            return !_licence.Current.For(part.Module).CanUse || _settings.IsPartOn(id);
        }

        private bool AnyShown(string[]? parts) => parts == null || parts.Length == 0 || parts.Any(PartShown);

        /// <summary>Rebuilds groups, sections, quick tools and the parts switches; keeps the open section if it still shows.</summary>
        private void Rebuild()
        {
            var openName = _section?.Name;
            Groups.Clear();
            foreach (var g in _registry.Groups.Where(g => AnyShown(g.Parts)))
            {
                var sections = g.Sections.Where(s => AnyShown(s.Parts))
                    .Select(s => new SectionItem(g.Name, s.Name, s.Module, AnyShown(s.TagParts) ? s.Tag : null, s.Phase, s.Board))
                    .ToList();
                if (sections.Count > 0) Groups.Add(new GroupItem(g.Name, sections));
            }

            QuickTools.Clear();
            foreach (var t in _registry.QuickTools.Where(t => AnyShown(t.Parts))) QuickTools.Add(t.Name);


            // The switches stay the same objects while the licensed modules don't change, so Settings, first-run setup and
            // the pane all show the same chips; only their on/off state is refreshed.
            var licensedModules = _registry.Parts.Select(p => p.Module).Distinct().Where(m => _licence.Current.For(m).CanUse).ToList();
            if (!Parts.Select(p => p.Module).SequenceEqual(licensedModules))
            {
                Parts.Clear();
                foreach (var m in licensedModules)
                    Parts.Add(new ModuleParts(m, _registry.Parts.Where(p => p.Module == m)
                        .Select(p => new PartSwitch(p, _settings.IsPartOn(p.Id), on => _settings.SetPart(p.Id, on)))));
            }
            else
            {
                foreach (var s in Parts.SelectMany(p => p.Switches)) s.Refresh(_settings.IsPartOn(s.Id));
            }

            OnPropertyChanged(nameof(ShowQuickTools));
            OnPropertyChanged(nameof(NoParts));
            OnPropertyChanged(nameof(ShowNoParts));

            var open = Groups.SelectMany(x => x.Sections).FirstOrDefault(x => x.Name == openName);
            if (open != null)
            {
                CurrentGroup = Groups.First(x => x.Sections.Contains(open));
                if (Page == ShellPage.Section) SelectSection(open);
                else _section = open;
            }
            else if (Groups.Count > 0)
            {
                if (Page == ShellPage.Section) SelectGroup(Groups[0]);
                else
                {
                    CurrentGroup = Groups[0];
                    _section = Groups[0].Sections[0];
                }
            }
            else
            {
                CurrentGroup = null;
                _section = null;
                if (Page == ShellPage.Section) Body = null;
            }

            Search.Refresh();
        }

        /// <summary>
        /// Opens a search result like its button would: a section opens; an action opens its section (it runs there with a
        /// dry run first, once built); a setting opens Settings; help says which part of the guide it opens.
        /// </summary>
        /// <summary>Opens Settings on one tab (quick tools, the ribbon).</summary>
        public void OpenSettingsTab(string tab, string status, string? focus = null)
        {
            if (!IsMain) return;
            if (Page != ShellPage.Settings) Open(ShellPage.Settings);
            Settings.Open(tab, focus);
            Status = status;
        }

        private void OpenResult(SearchResult r)
        {
            var section = Groups.SelectMany(g => g.Sections).FirstOrDefault(s => s.Name == r.Opens);
            if (section != null) SelectSection(section);
            if (r.Opens == "Settings")
            {
                if (Page != ShellPage.Settings) Open(ShellPage.Settings);
                // "Settings › Flow" opens that tab; a focus lands on the setting itself (F-012).
                var tab = r.Detail.StartsWith("Settings › ") ? r.Detail.Substring("Settings › ".Length).Split(' ')[0] : "General";
                Settings.Open(tab, r.Focus);
            }

            if (!r.Allowed)
                Status = r.Title + ": " + r.Module + " isn't on your licence. Ask your admin, or start a 14-day trial.";
            else if (r.Kind == SearchKind.Action && section != null)
                Status = r.Title + ": runs from " + Body!.Title + ", dry run first. It arrives with that section.";
            else if (r.Kind == SearchKind.Setting)
                Status = r.Title + ": " + r.Detail + ".";
            else if (r.Kind == SearchKind.Help)
                Status = "Help: " + r.Title + " · " + r.Detail + ".";

            Search.Close();
        }


    }
}
