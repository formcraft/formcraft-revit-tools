using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>
    /// Fake licence service for building and testing the shell before the real service exists.
    /// Any email signs in; the code 123456 passes two-step sign-in. Values match the canvas samples.
    /// </summary>
    public sealed class MockLicenceService : ILicenceService
    {
        private string _pendingEmail = "";

        public LicenceState Current { get; private set; } = LicenceState.SignedOut;
        public event EventHandler? Changed;

        public Task<SignInResult> SignInAsync(string email, string password)
        {
            if (string.IsNullOrWhiteSpace(email) || !email.Contains("@"))
                return Task.FromResult(new SignInResult(SignInOutcome.WrongPassword, "Enter your work email."));
            if (string.IsNullOrEmpty(password))
                return Task.FromResult(new SignInResult(SignInOutcome.WrongPassword, "Enter your password."));
            _pendingEmail = email.Trim();
            return Task.FromResult(new SignInResult(SignInOutcome.NeedsCode, "Two-step sign-in is on for your organisation. Enter the code from your phone."));
        }

        public Task<SignInResult> VerifyCodeAsync(string code)
        {
            if ((code ?? "").Replace(" ", "") != "123456")
                return Task.FromResult(new SignInResult(SignInOutcome.WrongPassword, "That code didn't match. Try again."));
            return Task.FromResult(Grant(DateTime.Now, 14, "Signed in. Licence checked."));
        }

        /// <summary>The mock browser flow comes straight back signed in (the provider does its own two-step check).</summary>
        public Task<SignInResult> SignInWithAsync(SignInProvider provider)
        {
            _pendingEmail = "[name.a]@formcraft.example";
            return Task.FromResult(Grant(DateTime.Now, 14, "Signed in with " + provider + ". Licence checked."));
        }

        /// <summary>Any .lic file named FMC_Licence_*.lic is accepted: 30 days, no online check yet.</summary>
        public Task<SignInResult> UseOfflineLicenceAsync(string path)
        {
            var name = System.IO.Path.GetFileName(path ?? "");
            if (!name.StartsWith("FMC_Licence_", StringComparison.OrdinalIgnoreCase) || !name.EndsWith(".lic", StringComparison.OrdinalIgnoreCase))
                return Task.FromResult(new SignInResult(SignInOutcome.WrongPassword, "That isn't a Formcraft licence file. It's named FMC_Licence_<PC>.lic."));
            _pendingEmail = "[name.a]@formcraft.example";
            return Task.FromResult(Grant(null, 30, "Offline licence loaded. It works for 30 days, then needs a check-in."));
        }

        private SignInResult Grant(DateTime? checkedAt, int offlineDays, string message)
        {
            var today = DateTime.Today;
            var yearEnd = new DateTime(today.Year, 12, 31);
            Current = new LicenceState(
                new Account("[NAME A]", _pendingEmail, "Formcraft Design & Construction", "BIM Coordinator", "Team", isAdmin: true),
                new List<ModuleLicence>
                {
                    new ModuleLicence(FmcModule.Core, ModuleStatus.Included, null),
                    new ModuleLicence(FmcModule.Manage, ModuleStatus.Active, yearEnd),
                    new ModuleLicence(FmcModule.Flow, ModuleStatus.Active, yearEnd),
                    new ModuleLicence(FmcModule.Model, ModuleStatus.Trial, today.AddDays(9)),
                    new ModuleLicence(FmcModule.Build, ModuleStatus.NotLicensed, null),
                },
                checkedAt,
                offlineDays);
            Changed?.Invoke(this, EventArgs.Empty);
            return new SignInResult(SignInOutcome.SignedIn, message);
        }

        public Task CheckNowAsync()
        {
            if (Current.SignedIn)
            {
                Current = new LicenceState(Current.Account, Current.Modules, DateTime.Now, 14);
                Changed?.Invoke(this, EventArgs.Empty);
            }
            return Task.CompletedTask;
        }

        public Task SignOutAsync()
        {
            Current = LicenceState.SignedOut;
            Changed?.Invoke(this, EventArgs.Empty);
            return Task.CompletedTask;
        }

        public Task ReleaseSeatAsync() => SignOutAsync();

        public Task<bool> ActivateKeyAsync(string key) => Task.FromResult((key ?? "").StartsWith("FMC-", StringComparison.OrdinalIgnoreCase));

        public Task RequestModuleAsync(FmcModule module) => Task.CompletedTask;
    }
}
