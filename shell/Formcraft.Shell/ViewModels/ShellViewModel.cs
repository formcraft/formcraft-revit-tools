using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    public enum ShellScreen { SignIn, Welcome, Main }

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
        /// <summary>Roadmap phase that fills this section in (shown until it is built).</summary>
        public string Phase { get; }
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
        public string Title => Section.Group + " › " + Section.Name;
        public string LockedText => "Formcraft " + Section.Module + " isn't on your licence.";
        public string PlaceholderText => "This section is drawn on the central canvas and is built in " + Section.Phase + ". The shell, navigation and licence checks around it already work.";
    }

    public sealed class ShellViewModel : ObservableObject
    {
        private readonly ILicenceService _licence;
        private ShellScreen _screen = ShellScreen.SignIn;
        private GroupItem? _group;
        private SectionBody? _body;
        private string _status = "Revit 2025 · Formcraft 0.1 (shell preview)";
        private string _documentTitle = "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt · 01_WIP";
        private string _documentLock = "Setup tools open";
        private bool _settingsOpen;

        public ShellViewModel(ILicenceService licence)
        {
            _licence = licence;
            SignIn = new SignInViewModel(licence, s => Status = s);
            Welcome = new WelcomeViewModel(() => Screen = ShellScreen.Main);
            Account = new AccountViewModel(licence, s => Status = s);
            Groups = new ObservableCollection<GroupItem>(BuildGroups());
            SelectGroupCommand = new RelayCommand(p => { if (p is GroupItem g) SelectGroup(g); });
            SelectSectionCommand = new RelayCommand(p => { if (p is SectionItem s) SelectSection(s); });
            OpenSettingsCommand = new RelayCommand(() => SettingsOpen = !SettingsOpen);
            _licence.Changed += (_, __) => OnLicenceChanged();
            SelectGroup(Groups[0]);
        }

        public SignInViewModel SignIn { get; }
        public WelcomeViewModel Welcome { get; }
        public AccountViewModel Account { get; }
        public ObservableCollection<GroupItem> Groups { get; }
        public RelayCommand SelectGroupCommand { get; }
        public RelayCommand SelectSectionCommand { get; }
        public RelayCommand OpenSettingsCommand { get; }

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

        public string HeaderStatus => _licence.Current.SignedIn
            ? (_licence.Current.GraceOver ? "Sign in again" : "Connected")
            : "Not signed in";

        public GroupItem? CurrentGroup { get => _group; private set => Set(ref _group, value); }
        public SectionBody? Body { get => _body; private set => Set(ref _body, value); }
        public string Status { get => _status; set => Set(ref _status, value); }
        public string DocumentTitle { get => _documentTitle; set => Set(ref _documentTitle, value); }
        public string DocumentLock { get => _documentLock; set => Set(ref _documentLock, value); }

        public bool SettingsOpen
        {
            get => _settingsOpen;
            set { if (Set(ref _settingsOpen, value)) OnPropertyChanged(nameof(ShowSection)); }
        }

        public bool ShowSection => !SettingsOpen;

        private void SelectGroup(GroupItem g)
        {
            foreach (var x in Groups) x.IsSelected = x == g;
            CurrentGroup = g;
            SelectSection(g.Sections.First());
        }

        private void SelectSection(SectionItem s)
        {
            foreach (var g in Groups)
                foreach (var x in g.Sections) x.IsSelected = x == s;
            Body = new SectionBody(s, _licence.Current.For(s.Module));
            SettingsOpen = false;
        }

        private void OnLicenceChanged()
        {
            OnPropertyChanged(nameof(HeaderStatus));
            if (!_licence.Current.SignedIn) Screen = ShellScreen.SignIn;
            else if (Screen == ShellScreen.SignIn) Screen = ShellScreen.Welcome;
            if (Body != null) SelectSection(Body.Section);
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
                S("Check", "Scripts", FmcModule.Manage, null, "phase 3"),
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
