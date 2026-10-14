using System;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class UpdateInfo
    {
        public UpdateInfo(string version, string notes, string gates)
        {
            Version = version;
            Notes = notes;
            Gates = gates;
        }

        public string Version { get; }
        public string Notes { get; }
        /// <summary>Only versions that passed release gates R1–R3 reach the stable channel (board account/PaneUpdates).</summary>
        public string Gates { get; }
    }

    /// <summary>
    /// What is installed, and updates that passed the release gates. An update installs when Revit closes and keeps the
    /// previous version for rollback; settings are kept (board account/PaneUpdates, Manual Part 19).
    /// </summary>
    public interface IUpdateService
    {
        string Installed { get; }
        string? RollbackVersion { get; }
        UpdateInfo? Available { get; }
        bool UpdatePending { get; }
        Task CheckAsync(string channel);
        void UpdateWhenRevitCloses();
        void RollBack();
        event EventHandler? Changed;
        /// <summary>Where updates come from: "sample" for the preview's sample feed, null when there is no feed yet (F-013).</summary>
        string? Feed { get; }
    }

    /// <summary>
    /// No update feed yet (F-013): the installed build and nothing to offer. Until the installer's feed exists, builds
    /// arrive through the Formcraft Updater when Revit closes (pilot PC), so the pane never shows a sample update as real.
    /// </summary>
    public sealed class NoFeedUpdateService : IUpdateService
    {
        public NoFeedUpdateService(string installed) { Installed = installed; }
        public string Installed { get; }
        public string? RollbackVersion => null;
        public UpdateInfo? Available => null;
        public bool UpdatePending => false;
        public string? Feed => null;
        public event EventHandler? Changed { add { } remove { } }
        public Task CheckAsync(string channel) => Task.CompletedTask;
        public void UpdateWhenRevitCloses() { }
        public void RollBack() { }
    }

    /// <summary>Sample update for the preview and tests; the real feed comes with the installer.</summary>
    public sealed class MockUpdateService : IUpdateService
    {
        public string Installed { get; private set; } = typeof(MockUpdateService).Assembly.GetName().Version is Version v ? v.ToString(3) : "0.1.0";
        public string? RollbackVersion { get; private set; } = "0.0.9 (sample)";
        public UpdateInfo? Available { get; private set; } = new UpdateInfo("0.1.1",
            "Fixes Tag Tidy on rotated views; Search finds settings (sample notes)", "passed release gates R1–R3");
        public bool UpdatePending { get; private set; }
        public event EventHandler? Changed;
        public string? Feed => "sample";

        public Task CheckAsync(string channel)
        {
            var beta = channel.StartsWith("Beta", StringComparison.Ordinal);
            Available = new UpdateInfo(beta ? "0.1.2-beta" : "0.1.1",
                beta ? "Testers first: Admin seats table (sample notes)" : "Fixes Tag Tidy on rotated views; Search finds settings (sample notes)",
                beta ? "passed R1 · testers only" : "passed release gates R1–R3");
            Changed?.Invoke(this, EventArgs.Empty);
            return Task.CompletedTask;
        }

        public void UpdateWhenRevitCloses()
        {
            if (Available == null) return;
            UpdatePending = true;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void RollBack()
        {
            if (RollbackVersion == null) return;
            UpdatePending = false;
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
