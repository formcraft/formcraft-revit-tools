using System;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
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

        public AccountViewModel(ILicenceService licence, Action<string> status, Action<DialogViewModel> ask)
        {
            _licence = licence;
            CheckNowCommand = new AsyncCommand(async () => { await _licence.CheckNowAsync(); status("Licence checked."); }, status);
            SignOutCommand = new AsyncCommand(() => _licence.SignOutAsync(), status);
            // Board account/PaneAccount: releasing the seat asks first.
            ReleaseSeatCommand = new RelayCommand(() => ask(new DialogViewModel(
                "Release this seat",
                "Frees your seat so someone else can use it. You'll need to sign in again here.",
                "Release",
                () => _licence.ReleaseSeatAsync())));
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
        public RelayCommand ReleaseSeatCommand { get; }

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
