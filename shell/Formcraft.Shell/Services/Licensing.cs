using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>The five parts of the bundle. Core is always included.</summary>
    public enum FmcModule { Core, Manage, Flow, Model, Build }

    public enum ModuleStatus { Included, Active, Trial, NotLicensed, Expired }

    public sealed class ModuleLicence
    {
        public ModuleLicence(FmcModule module, ModuleStatus status, DateTime? until)
        {
            Module = module;
            Status = status;
            Until = until;
        }

        public FmcModule Module { get; }
        public ModuleStatus Status { get; }
        public DateTime? Until { get; }
        public bool CanUse => Status == ModuleStatus.Included || Status == ModuleStatus.Active || Status == ModuleStatus.Trial;
    }

    public sealed class Account
    {
        public Account(string name, string email, string organisation, string role, string plan)
        {
            Name = name;
            Email = email;
            Organisation = organisation;
            Role = role;
            Plan = plan;
        }

        public string Name { get; }
        public string Email { get; }
        public string Organisation { get; }
        public string Role { get; }
        public string Plan { get; }
    }

    /// <summary>What the shell knows about the licence on this PC.</summary>
    public sealed class LicenceState
    {
        public LicenceState(Account? account, IReadOnlyList<ModuleLicence> modules, DateTime? lastOnlineCheck, int offlineDaysLeft)
        {
            Account = account;
            Modules = modules;
            LastOnlineCheck = lastOnlineCheck;
            OfflineDaysLeft = offlineDaysLeft;
        }

        public Account? Account { get; }
        public IReadOnlyList<ModuleLicence> Modules { get; }
        public DateTime? LastOnlineCheck { get; }
        public int OfflineDaysLeft { get; }
        public bool SignedIn => Account != null;
        public bool GraceOver => SignedIn && OfflineDaysLeft <= 0;

        public ModuleLicence For(FmcModule module)
        {
            foreach (var m in Modules)
                if (m.Module == module) return m;
            return new ModuleLicence(module, module == FmcModule.Core ? ModuleStatus.Included : ModuleStatus.NotLicensed, null);
        }

        public static LicenceState SignedOut { get; } = new LicenceState(null, new List<ModuleLicence>(), null, 0);
    }

    /// <summary>
    /// Sign-in and licence checks. The real implementation talks to the licence service
    /// (decision D6, open). The shell only ever reads status: payments live on the account website.
    /// </summary>
    public interface ILicenceService
    {
        LicenceState Current { get; }
        event EventHandler? Changed;
        Task<SignInResult> SignInAsync(string email, string password);
        Task<SignInResult> VerifyCodeAsync(string code);
        Task CheckNowAsync();
        Task SignOutAsync();
        Task ReleaseSeatAsync();
        Task<bool> ActivateKeyAsync(string key);
        Task RequestModuleAsync(FmcModule module);
    }

    public enum SignInOutcome { SignedIn, NeedsCode, WrongPassword, NoSeat, Offline }

    public sealed class SignInResult
    {
        public SignInResult(SignInOutcome outcome, string message)
        {
            Outcome = outcome;
            Message = message;
        }

        public SignInOutcome Outcome { get; }
        public string Message { get; }
    }
}
