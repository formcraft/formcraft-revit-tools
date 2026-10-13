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
                DateTime.Now,
                14);
            Changed?.Invoke(this, EventArgs.Empty);
            return Task.FromResult(new SignInResult(SignInOutcome.SignedIn, "Signed in. Licence checked."));
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
