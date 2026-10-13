using System;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    public sealed class SignInViewModel : ObservableObject
    {
        private readonly ILicenceService _licence;
        private readonly Action<string> _status;
        private string _email = "";
        private string _code = "";
        private string _message = "One Formcraft account per person. Your organisation's licence decides which modules you get.";
        private bool _needsCode;

        public SignInViewModel(ILicenceService licence, Action<string> status)
        {
            _licence = licence;
            _status = status;
            SignInCommand = new AsyncCommand(async () =>
            {
                var r = await _licence.SignInAsync(Email, Password);
                Message = r.Message;
                NeedsCode = r.Outcome == SignInOutcome.NeedsCode;
            }, status);
            VerifyCommand = new AsyncCommand(async () =>
            {
                var r = await _licence.VerifyCodeAsync(Code);
                Message = r.Message;
                if (r.Outcome == SignInOutcome.SignedIn) _status("Signed in. Licence checked.");
            }, status);
            WorkOfflineCommand = new RelayCommand(() => _status("Without a seat only Connect, Log file and Help are available."));
        }

        public string Email { get => _email; set => Set(ref _email, value); }
        /// <summary>Set from the PasswordBox in code-behind; never stored.</summary>
        public string Password { get; set; } = "";
        public string Code { get => _code; set => Set(ref _code, value); }
        public string Message { get => _message; set => Set(ref _message, value); }
        public bool NeedsCode { get => _needsCode; set => Set(ref _needsCode, value); }
        public AsyncCommand SignInCommand { get; }
        public AsyncCommand VerifyCommand { get; }
        public RelayCommand WorkOfflineCommand { get; }
    }

    public sealed class WelcomeViewModel : ObservableObject
    {
        private string _kitFolder = @"Z:\00_Standards";

        public WelcomeViewModel(Action done)
        {
            ContinueCommand = new RelayCommand(done);
        }

        public string KitFolder { get => _kitFolder; set => Set(ref _kitFolder, value); }
        public RelayCommand ContinueCommand { get; }
    }

    public sealed class ModuleRow
    {
        public ModuleRow(ModuleLicence l)
        {
            Name = l.Module.ToString();
            Status = l.Status switch
            {
                ModuleStatus.Included => "Included",
                ModuleStatus.Active => "Active",
                ModuleStatus.Trial => "Trial",
                ModuleStatus.Expired => "Expired",
                _ => "Not on your licence",
            };
            Until = l.Until?.ToString("d MMM yyyy") ?? (l.Status == ModuleStatus.Included ? "Always" : "Ask your admin");
        }

        public string Name { get; }
        public string Status { get; }
        public string Until { get; }
    }

    public sealed class AccountViewModel : ObservableObject
    {
        private readonly ILicenceService _licence;

        public AccountViewModel(ILicenceService licence, Action<string> status)
        {
            _licence = licence;
            CheckNowCommand = new AsyncCommand(async () => { await _licence.CheckNowAsync(); status("Licence checked."); }, status);
            SignOutCommand = new AsyncCommand(() => _licence.SignOutAsync(), status);
            ReleaseSeatCommand = new AsyncCommand(() => _licence.ReleaseSeatAsync(), status);
            Refresh();
        }

        public ObservableCollection<ModuleRow> Modules { get; } = new ObservableCollection<ModuleRow>();
        public string Who => _licence.Current.Account is { } a ? a.Name + " · " + a.Email : "Not signed in";
        public string Organisation => _licence.Current.Account is { } a ? a.Organisation + " · " + a.Plan + " plan" : "";
        public string Role => _licence.Current.Account?.Role ?? "";
        public string OfflineText => _licence.Current.SignedIn
            ? "Last checked " + (_licence.Current.LastOnlineCheck?.ToString("d MMM HH:mm") ?? "never") + " · works offline for " + _licence.Current.OfflineDaysLeft + " days"
            : "";
        public AsyncCommand CheckNowCommand { get; }
        public AsyncCommand SignOutCommand { get; }
        public AsyncCommand ReleaseSeatCommand { get; }

        public void Refresh()
        {
            Modules.Clear();
            foreach (FmcModule m in Enum.GetValues(typeof(FmcModule)))
                Modules.Add(new ModuleRow(_licence.Current.For(m)));
            OnPropertyChanged(nameof(Who));
            OnPropertyChanged(nameof(Organisation));
            OnPropertyChanged(nameof(Role));
            OnPropertyChanged(nameof(OfflineText));
        }
    }
}
