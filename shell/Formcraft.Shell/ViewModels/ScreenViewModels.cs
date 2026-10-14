using System;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    public sealed class ModuleRow
    {
        public ModuleRow(ModuleLicence l, DateTime today)
        {
            Module = l.Module;
            Name = l.Module.ToString();
            Status = l.Status switch
            {
                ModuleStatus.Included => "Included",
                ModuleStatus.Active => "Active",
                ModuleStatus.Trial => l.Until is DateTime end ? "Trial · " + Math.Max(0, (end.Date - today.Date).Days) + " days" : "Trial",
                ModuleStatus.Expired => "Expired",
                _ => "Not on your licence",
            };
            Kind = l.Status switch
            {
                ModuleStatus.Included or ModuleStatus.Active => ChipKind.Good,
                ModuleStatus.Trial => ChipKind.Info,
                ModuleStatus.Expired => ChipKind.Bad,
                _ => ChipKind.Grey,
            };
            Until = l.Until?.ToString("d MMM yyyy") ?? (l.Status == ModuleStatus.Included ? "Always" : "Ask your admin");
            CanRequest = !l.CanUse;
        }

        public FmcModule Module { get; }
        public string Name { get; }
        public string Status { get; }
        public ChipKind Kind { get; }
        public string Until { get; }
        /// <summary>Not on the licence: "Request &lt;module&gt;" sends the request to the admin (Admin › Requests).</summary>
        public bool CanRequest { get; }
        public string RequestText => "Request " + Name;
    }

    public sealed class AccountViewModel : ObservableObject
    {
        private readonly ILicenceService _licence;

        public AccountViewModel(ILicenceService licence, Action<string> status, Action<DialogViewModel> ask)
        {
            _licence = licence;
            RequestModuleCommand = new RelayCommand(async p =>
            {
                if (!(p is ModuleRow row)) return;
                await _licence.RequestModuleAsync(row.Module);
                status("Request for " + row.Name + " sent to your admin (Admin › Licences and seats › Requests).");
            });
            // Board: "Enter a licence key" dialog. Keys come from the account website or the admin.
            EnterKeyCommand = new RelayCommand(() => ask(DialogViewModel.WithInput("Enter a licence key",
                "Keys come from the Formcraft account website or your admin.", "Licence key", "Activate",
                async key =>
                {
                    if (!await _licence.ActivateKeyAsync(key)) return "That key wasn't accepted. Check it on the Formcraft account website.";
                    status("Licence key activated.");
                    return null;
                })));
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
        public string Role => _licence.Current.Account is { } a ? a.Role + " (set by Admin)" : "";
        public string OfflineText => _licence.Current.SignedIn
            ? "Last checked " + (_licence.Current.LastOnlineCheck?.ToString("d MMM HH:mm") ?? "never") + " · works offline for " + _licence.Current.OfflineDaysLeft + " days"
            : "";
        public string Seat => Environment.MachineName.ToLowerInvariant() + " · this PC";
        public string LastChecked => _licence.Current.LastOnlineCheck?.ToString("d MMM HH:mm") ?? "Not yet (offline licence)";
        public string WorksOfflineFor => _licence.Current.OfflineDaysLeft + " days";
        public string ClaudeKey => "Organisation key set by Admin, for the AI provider your organisation chooses";
        public string ClaudeToday => "No Ask AI use yet (Ask AI arrives in U27)";
        public RelayCommand RequestModuleCommand { get; }
        public RelayCommand EnterKeyCommand { get; }
        public AsyncCommand CheckNowCommand { get; }
        public AsyncCommand SignOutCommand { get; }
        public RelayCommand ReleaseSeatCommand { get; }

        public void Refresh()
        {
            Modules.Clear();
            foreach (FmcModule m in Enum.GetValues(typeof(FmcModule)))
                Modules.Add(new ModuleRow(_licence.Current.For(m), DateTime.Today));
            OnPropertyChanged(nameof(Who));
            OnPropertyChanged(nameof(Organisation));
            OnPropertyChanged(nameof(Role));
            OnPropertyChanged(nameof(OfflineText));
            OnPropertyChanged(nameof(LastChecked));
            OnPropertyChanged(nameof(WorksOfflineFor));
        }
    }
}
