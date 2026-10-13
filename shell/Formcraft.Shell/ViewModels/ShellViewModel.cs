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

        public SectionItem(string group, string name, FmcModule module, string? moduleTag, string phase)
        {
            Group = group;
            Name = name;
            Module = module;
            ModuleTag = moduleTag;
            Phase = phase;
        }

        public string Group { get; }
        public string Name { get; }
        public FmcModule Module { get; }
        public string? ModuleTag { get; }
        /// <summary>Roadmap phase or UI step that fills this section in (shown until it is built).</summary>
        public string Phase { get; }
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
        public SectionBody(SectionItem section, ModuleLicence licence)
        {
            Section = section;
            Licence = licence;
        }

        public SectionItem Section { get; }
        public ModuleLicence Licence { get; }
        public bool Locked => !Licence.CanUse;
        public string Title => Section.Group.Length == 0 ? Section.Name : Section.Group + " › " + Section.Name;
        public string LockedText => "Formcraft " + Section.Module + " isn't on your licence.";
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
        private readonly SectionItem _connect = new SectionItem("", "Connect", FmcModule.Core, null, "U12");
        private readonly SectionItem _admin = new SectionItem("", "Admin", FmcModule.Core, null, "U07");
        private ShellScreen _screen = ShellScreen.SignIn;
        private ShellPage _page = ShellPage.Section;
        private GroupItem? _group;
        private SectionItem? _section;
        private SectionBody? _body;
        private DialogViewModel? _dialog;
        private string _status = ReadyStatus;

        public ShellViewModel(ILicenceService licence, IConnectionService connection, IDocumentContext document)
        {
            _licence = licence;
            _connection = connection;
            _document = document;
            SignIn = new SignInViewModel(licence, s => Status = s);
            Welcome = new WelcomeViewModel(() => Screen = ShellScreen.Main);
            Account = new AccountViewModel(licence, s => Status = s, ShowDialog);
            Groups = new ObservableCollection<GroupItem>(BuildGroups());
            SelectGroupCommand = new RelayCommand(p => { if (p is GroupItem g) SelectGroup(g); });
            SelectSectionCommand = new RelayCommand(p => { if (p is SectionItem s) SelectSection(s); });
            OpenConnectCommand = new RelayCommand(() => Open(ShellPage.Connect));
            OpenSettingsCommand = new RelayCommand(() => Open(ShellPage.Settings));
            // The Admin button is only shown to admins; the check here keeps it that way for keyboard and MCP too.
            OpenAdminCommand = new RelayCommand(() => { if (IsAdmin) Open(ShellPage.Admin); });
            HelpCommand = new RelayCommand(() => Status = "Help: opens this section of the guide and the first-run tour.");
            QuickToolCommand = new RelayCommand(p => Status = p + ": in the plugin this runs here (built in U22).");
            _licence.Changed += (_, __) => OnLicenceChanged();
            _connection.Changed += (_, __) => { OnPropertyChanged(nameof(IsConnected)); OnPropertyChanged(nameof(ConnectionText)); };
            _document.Changed += (_, __) => OnPropertyChanged(nameof(Document));
            SelectGroup(Groups[0]);
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
                }
            }
        }

        public bool IsSignIn => Screen == ShellScreen.SignIn;
        public bool IsWelcome => Screen == ShellScreen.Welcome;
        public bool IsMain => Screen == ShellScreen.Main;

        // Header: the Connected chip is the Revit/Claude service; licence problems show in the state banners (U08).
        public bool IsConnected => _connection.State == ConnectionState.Connected;
        public string ConnectionText => IsConnected ? "Connected" : "Not connected";
        public bool IsAdmin => _licence.Current.Account?.IsAdmin == true;

        /// <summary>Touch, Section Box and Tag Tidy: only when Flow is on the licence.</summary>
        public bool ShowQuickTools => _licence.Current.SignedIn && _licence.Current.For(FmcModule.Flow).CanUse;
        public IReadOnlyList<string> QuickTools { get; } = new[] { "Touch", "Section Box", "Tag Tidy" };

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
                OnPropertyChanged(nameof(ShowSection));
            }
        }

        public bool IsConnectOpen => Page == ShellPage.Connect;
        public bool SettingsOpen => Page == ShellPage.Settings;
        public bool IsAdminOpen => Page == ShellPage.Admin;
        public bool ShowSection => !SettingsOpen;

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
            _section = s;
            Page = ShellPage.Section;
            Body = new SectionBody(s, _licence.Current.For(s.Module));
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
            OnPropertyChanged(nameof(ShowQuickTools));
            if (!_licence.Current.SignedIn) Screen = ShellScreen.SignIn;
            else if (Screen == ShellScreen.SignIn) Screen = ShellScreen.Welcome;
            if (Page == ShellPage.Admin && !IsAdmin) Page = ShellPage.Section;
            if (Page == ShellPage.Section && _section != null) SelectSection(_section);
            Account.Refresh();
        }

        /// <summary>The pane's groups and sections, as on the canvas (GROUPS in the generator).</summary>
        private static IEnumerable<GroupItem> BuildGroups()
        {
            SectionItem S(string g, string n, FmcModule m, string? tag, string phase) => new SectionItem(g, n, m, tag, phase);
            yield return new GroupItem("Setup", new[]
            {
                S("Setup", "Project", FmcModule.Manage, null, "phase 2"),
                S("Setup", "Templates", FmcModule.Manage, null, "phase 2"),
                S("Setup", "Families", FmcModule.Manage, "+Model", "phase 2"),
                S("Setup", "Materials", FmcModule.Manage, null, "phase 3"),
            });
            yield return new GroupItem("Drawings", new[]
            {
                S("Drawings", "Sheets", FmcModule.Manage, "+Flow", "phase 3"),
                S("Drawings", "Annotate", FmcModule.Manage, "+Flow", "phase 3"),
                S("Drawings", "Issue", FmcModule.Manage, null, "phase 3"),
            });
            yield return new GroupItem("Team", new[]
            {
                S("Team", "Review", FmcModule.Manage, null, "phase 3"),
                S("Team", "Workshare", FmcModule.Manage, null, "phase 3"),
                S("Team", "Links", FmcModule.Manage, null, "phase 3"),
            });
            yield return new GroupItem("Check", new[]
            {
                S("Check", "QA", FmcModule.Manage, null, "phase 2"),
                S("Check", "Rules", FmcModule.Manage, null, "phase 2"),
                S("Check", "Reports", FmcModule.Manage, null, "phase 3"),
                S("Check", "Scripts", FmcModule.Model, "+Model", "phase 4"),
            });
            yield return new GroupItem("Engineer", new[]
            {
                S("Engineer", "Brief", FmcModule.Model, "+Model", "phase 4"),
                S("Engineer", "Systems", FmcModule.Model, "+Model", "phase 5"),
            });
            yield return new GroupItem("Build", new[]
            {
                S("Build", "Build", FmcModule.Build, "+Build", "phase 6"),
            });
        }
    }
}
