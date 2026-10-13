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
        private readonly IUserSettings _settings;
        private readonly SectionRegistry _registry;
        private readonly SectionItem _connect = new SectionItem("", "Connect", FmcModule.Core, null, "U12", "core/PaneConnect");
        private readonly SectionItem _admin = new SectionItem("", "Admin", FmcModule.Core, null, "U07", "core/PaneAdmin");
        private ShellScreen _screen = ShellScreen.SignIn;
        private ShellPage _page = ShellPage.Section;
        private GroupItem? _group;
        private SectionItem? _section;
        private SectionBody? _body;
        private DialogViewModel? _dialog;
        private string _status = ReadyStatus;

        public ShellViewModel(ILicenceService licence, IConnectionService connection, IDocumentContext document,
                              IUserSettings settings, SectionRegistry? registry = null)
        {
            _licence = licence;
            _connection = connection;
            _document = document;
            _settings = settings;
            _registry = registry ?? SectionRegistry.Default;
            SignIn = new SignInViewModel(licence, s => Status = s);
            Welcome = new WelcomeViewModel(() => Screen = ShellScreen.Main);
            Account = new AccountViewModel(licence, s => Status = s, ShowDialog);
            Groups = new ObservableCollection<GroupItem>();
            Parts = new ObservableCollection<ModuleParts>();
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
            _settings.Changed += (_, __) => Rebuild();
            Rebuild();
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
        public bool ShowQuickTools => _licence.Current.SignedIn && _licence.Current.For(FmcModule.Flow).CanUse && QuickTools.Count > 0;
        /// <summary>Quick tools whose Flow part is on (Touch, Section Box, Tag Tidy).</summary>
        public ObservableCollection<string> QuickTools { get; } = new ObservableCollection<string>();

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
                OnPropertyChanged(nameof(ShowSection));
                OnPropertyChanged(nameof(ShowNoParts));
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
            if (!_licence.Current.SignedIn) Screen = ShellScreen.SignIn;
            else if (Screen == ShellScreen.SignIn) Screen = ShellScreen.Welcome;
            if (Page == ShellPage.Admin && !IsAdmin) Page = ShellPage.Section;
            Rebuild();
            Account.Refresh();
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

            Parts.Clear();
            foreach (var m in _registry.Parts.Select(p => p.Module).Distinct())
            {
                if (!_licence.Current.For(m).CanUse) continue;
                Parts.Add(new ModuleParts(m, _registry.Parts.Where(p => p.Module == m)
                    .Select(p => new PartSwitch(p, _settings.IsPartOn(p.Id), on => _settings.SetPart(p.Id, on)))));
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
        }


    }
}
