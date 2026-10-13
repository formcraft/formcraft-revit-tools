using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>Sign in (board account/PaneSignIn): email and password, Microsoft or Google, or an offline licence file.</summary>
    public sealed class SignInViewModel : ObservableObject
    {
        private readonly ILicenceService _licence;
        private readonly IUserSettings _settings;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private string _email = "";
        private string _message = "One Formcraft account per person. Your organisation's licence decides which modules you get.";

        public SignInViewModel(ILicenceService licence, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
        {
            _licence = licence;
            _settings = settings;
            _status = status;
            _ask = ask;
            SignInCommand = new AsyncCommand(SignInAsync, status);
            MicrosoftCommand = new AsyncCommand(() => ProviderAsync(SignInProvider.Microsoft), status);
            GoogleCommand = new AsyncCommand(() => ProviderAsync(SignInProvider.Google), status);
            ForgotPasswordCommand = new RelayCommand(() => _status("Forgot password: the Formcraft account website resets it, outside Revit."));
            AskAdminCommand = new RelayCommand(() => _status("No account? Ask your admin to invite you in Admin › Licences and seats."));
            WorkOfflineCommand = new RelayCommand(() => _status("Without a seat only Connect, Log file and Help are available."));
        }

        public string Email { get => _email; set => Set(ref _email, value ?? ""); }
        /// <summary>Set from the PasswordBox in code-behind; never stored.</summary>
        public string Password { get; set; } = "";
        public string Message { get => _message; set => Set(ref _message, value); }

        /// <summary>"Keep me signed in on this PC": saved for the person (the real licence service keeps the session, D6).</summary>
        public bool KeepSignedIn
        {
            get => _settings.GetBool(SettingKeys.KeepSignedIn, true);
            set { _settings.SetBool(SettingKeys.KeepSignedIn, value); OnPropertyChanged(); }
        }

        /// <summary>The board's "What signing in does" lines.</summary>
        public IReadOnlyList<string> WhatItDoes { get; } = new[]
        {
            "Checks your seat and modules", "Registers this PC (name only)", "Loads your settings", "Never reads or sends model content",
        };

        public AsyncCommand SignInCommand { get; }
        public AsyncCommand MicrosoftCommand { get; }
        public AsyncCommand GoogleCommand { get; }
        public RelayCommand ForgotPasswordCommand { get; }
        public RelayCommand AskAdminCommand { get; }
        public RelayCommand WorkOfflineCommand { get; }

        private async System.Threading.Tasks.Task SignInAsync()
        {
            var r = await _licence.SignInAsync(Email, Password);
            if (r.Outcome != SignInOutcome.NeedsCode)
            {
                Message = r.Message;
                return;
            }
            // Board: "Check your phone" dialog with the 6-digit code.
            _ask(DialogViewModel.WithInput("Check your phone", "Two-step sign-in is on for your organisation.", "6-digit code", "Verify",
                async code =>
                {
                    // Signed in: the shell moves on to first-run setup, whose footer shows the step.
                    var v = await _licence.VerifyCodeAsync(code);
                    return v.Outcome == SignInOutcome.SignedIn ? null : v.Message;
                }));
        }

        private async System.Threading.Tasks.Task ProviderAsync(SignInProvider provider)
        {
            _status("Opening the browser for " + provider + " sign-in…");
            var r = await _licence.SignInWithAsync(provider);
            Message = r.Message;
            _status(r.Message);
        }

        /// <summary>A dropped or chosen FMC_Licence_&lt;PC&gt;.lic file.</summary>
        public async System.Threading.Tasks.Task UseOfflineLicenceAsync(string path)
        {
            var r = await _licence.UseOfflineLicenceAsync(path);
            Message = r.Message;
            _status(r.Message);
        }
    }

    /// <summary>A step in the first-run bar: done, current or still to come.</summary>
    public sealed class SetupStep : ObservableObject
    {
        private bool _isCurrent;
        private bool _isDone;

        public SetupStep(int number, string name)
        {
            Number = number;
            Name = name;
        }

        public int Number { get; }
        public string Name { get; }
        public string Label => Number + " " + Name;
        public bool IsCurrent { get => _isCurrent; set => Set(ref _isCurrent, value); }
        public bool IsDone { get => _isDone; set => Set(ref _isDone, value); }
    }

    /// <summary>One discipline chip ("Disciplines I model").</summary>
    public sealed class DisciplineChip : ObservableObject
    {
        private readonly Action _changed;
        private bool _isOn;

        public DisciplineChip(string code, bool isOn, Action changed)
        {
            Code = code;
            _isOn = isOn;
            _changed = changed;
        }

        public string Code { get; }
        public bool IsOn { get => _isOn; set { if (Set(ref _isOn, value)) _changed(); } }
    }

    /// <summary>
    /// First-run setup (board account/PaneWelcome): 1 Sign in (done), 2 Kit folder with its checks, 3 role and disciplines,
    /// 4 parts to show, then the tour. Everything can be changed later in Settings.
    /// </summary>
    public sealed class WelcomeViewModel : ObservableObject
    {
        public const string DefaultKitFolder = @"Z:\00_Standards";
        private static readonly string[] DisciplineCodes = { "A", "I", "S", "M", "E", "P", "FP", "L" };

        private readonly IUserSettings _settings;
        private readonly IKitService _kit;
        private readonly Func<string> _role;
        private readonly Action _done;
        private readonly Action<string> _status;
        private int _step = 2;
        private KitCheck _kitCheck;
        private bool _applyShortcuts;

        public WelcomeViewModel(IUserSettings settings, IKitService kit, ObservableCollection<ModuleParts> parts, Func<string> role, Action done, Action<string> status)
        {
            _settings = settings;
            _kit = kit;
            _role = role;
            _done = done;
            _status = status;
            Parts = parts;
            Steps = new[] { new SetupStep(1, "Sign in"), new SetupStep(2, "Kit folder"), new SetupStep(3, "Your role"), new SetupStep(4, "Your parts") };
            var chosen = (settings.Get(SettingKeys.Disciplines) ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            Disciplines = DisciplineCodes.Select(c => new DisciplineChip(c, chosen.Contains(c), SaveDisciplines)).ToList();
            _kitCheck = _kit.Check(KitFolder);
            BackCommand = new RelayCommand(_ => GoTo(Step - 1), _ => Step > 2);
            NextCommand = new RelayCommand(Next);
            GoToCommand = new RelayCommand(p => { if (p is SetupStep s && s.Number >= 2 && s.Number <= Step) GoTo(s.Number); });
            RecheckCommand = new RelayCommand(() => KitCheck = _kit.Check(KitFolder));
            UpdateSteps();
        }

        public IReadOnlyList<SetupStep> Steps { get; }
        public int Step => _step;
        public bool IsKitStep => _step == 2;
        public bool IsRoleStep => _step == 3;
        public bool IsPartsStep => _step == 4;
        public string Title => "Set up this PC · step " + _step + " of 4";
        public string StepText => "Step " + _step + " of 4";
        public string NextText => _step == 4 ? "Finish" : "Next";

        public string KitFolder
        {
            get => _settings.Get(SettingKeys.KitFolder) ?? DefaultKitFolder;
            set
            {
                _settings.Set(SettingKeys.KitFolder, (value ?? "").Trim());
                OnPropertyChanged();
                KitCheck = _kit.Check(KitFolder);
            }
        }

        public KitCheck KitCheck
        {
            get => _kitCheck;
            private set { _kitCheck = value; OnPropertyChanged(); OnPropertyChanged(nameof(KitHint)); }
        }

        public string KitHint => KitCheck.KitFound
            ? "Your BIM Manager gives you this path."
            : "Your BIM Manager gives you this path. Without the kit the pane still works; kit tools wait until it is found.";

        public string Role => _role();
        public IReadOnlyList<DisciplineChip> Disciplines { get; }
        public ObservableCollection<ModuleParts> Parts { get; }

        public bool ShowTour
        {
            get => _settings.GetBool(SettingKeys.ShowTour, true);
            set { _settings.SetBool(SettingKeys.ShowTour, value); OnPropertyChanged(); }
        }

        /// <summary>Revit applies shortcuts through its own import, so this opens that dialog with the file ready (in Revit).</summary>
        public bool ApplyShortcuts { get => _applyShortcuts; set => Set(ref _applyShortcuts, value); }

        public RelayCommand BackCommand { get; }
        public RelayCommand NextCommand { get; }
        public RelayCommand GoToCommand { get; }
        public RelayCommand RecheckCommand { get; }

        /// <summary>Raised when the step changes, so the shell can relabel its footer buttons.</summary>
        public event EventHandler? StepChanged;

        /// <summary>Starts again at step 2 (a new sign-in).</summary>
        public void Restart() => GoTo(2);

        private void Next()
        {
            if (_step < 4)
            {
                GoTo(_step + 1);
                return;
            }
            _settings.SetBool(SettingKeys.SetupDone, true);
            var then = new List<string>();
            if (ShowTour) then.Add("the 2-minute tour starts here (built later)");
            if (ApplyShortcuts) then.Add("Revit's shortcut import opens with the Formcraft file (in Revit)");
            _status(then.Count == 0 ? "This PC is set up. Change anything later in Settings." : "This PC is set up. Next, " + string.Join("; ", then) + ".");
            _done();
        }

        private void GoTo(int step)
        {
            _step = Math.Max(2, Math.Min(4, step));
            UpdateSteps();
            // Role comes from the signed-in account, so read it again on every step.
            foreach (var p in new[] { nameof(Step), nameof(IsKitStep), nameof(IsRoleStep), nameof(IsPartsStep), nameof(Title), nameof(StepText), nameof(NextText), nameof(Role) })
                OnPropertyChanged(p);
            StepChanged?.Invoke(this, EventArgs.Empty);
        }

        private void UpdateSteps()
        {
            foreach (var s in Steps)
            {
                s.IsDone = s.Number < _step;
                s.IsCurrent = s.Number == _step;
            }
        }

        private void SaveDisciplines() =>
            _settings.Set(SettingKeys.Disciplines, string.Join(",", Disciplines.Where(d => d.IsOn).Select(d => d.Code)));
    }
}
