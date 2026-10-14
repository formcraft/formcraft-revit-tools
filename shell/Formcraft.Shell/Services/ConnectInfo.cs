using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One line of the start-up health check (board core/PaneConnect), with the fix it offers if any.</summary>
    public sealed class HealthCheck
    {
        public HealthCheck(string label, string status, ChipKind kind, string fixLabel = "", string fixId = "", string detail = "")
        {
            Label = label;
            Status = status;
            Kind = kind;
            FixLabel = fixLabel;
            FixId = fixId;
            Detail = detail;
        }

        public string Label { get; }
        public string Status { get; }
        public ChipKind Kind { get; }
        /// <summary>The button on the line ("Create from example…"), empty when there is nothing to fix here.</summary>
        public string FixLabel { get; }
        /// <summary>Which fix <see cref="IConnectInfo.FixAsync"/> runs.</summary>
        public string FixId { get; }
        /// <summary>What the problem blocks and how to fix it by hand.</summary>
        public string Detail { get; }
    }

    /// <summary>
    /// What Connect shows that only the host knows (board core/PaneConnect): the health check, the folders the guard
    /// allows, the Claude (MCP) service and the support exports. In Revit the add-in supplies it over Readiness and
    /// GuardStatus; the preview and tests use <see cref="MockConnectInfo"/>.
    /// </summary>
    public interface IConnectInfo
    {
        /// <summary>Checks only the host can make (Revit, guard, command set, server, kit data files). Kit and licence lines come from the pane.</summary>
        IReadOnlyList<HealthCheck> Checks { get; }

        string GuardPath { get; }
        IReadOnlyList<string> WriteRoots { get; }
        IReadOnlyList<string> NeverWritten { get; }
        string ReportsFolder { get; }
        bool LiveModelLock { get; }

        bool ServiceRunning { get; }
        int Port { get; }
        /// <summary>Starts or stops listening for Claude. The change shows through <see cref="Changed"/>.</summary>
        void SetService(bool on);

        /// <summary>Runs a line's fix (create the guard from the example, open it, locate the server…), then re-checks.</summary>
        Task FixAsync(string fixId);
        /// <summary>Tests the whole chain Claude uses: server, port, command set, Revit. Returns a plain sentence.</summary>
        Task<string> ProbeAsync();
        void Refresh();
        void OpenReportsFolder();

        /// <summary>A zip of logs and settings for support, with file paths removed and no model content. Returns its path.</summary>
        string ExportDiagnostics(string checksText);
        /// <summary>Keeps feedback for sending; returns where it was saved.</summary>
        string SaveFeedback(string text);

        event EventHandler? Changed;
    }

    /// <summary>Sample values from board core/PaneConnect.</summary>
    public sealed class MockConnectInfo : IConnectInfo
    {
        private bool _guard = true;

        public IReadOnlyList<HealthCheck> Checks => new[]
        {
            new HealthCheck("Revit", "2025.4 · same update as the team", ChipKind.Good),
            _guard ? new HealthCheck("fmc_guard.json", "Found", ChipKind.Good)
                   : new HealthCheck("fmc_guard.json", "Missing", ChipKind.Bad, "Create from example…", "create-guard", "Every file write is refused until it exists."),
            new HealthCheck("Write roots reachable", "3 of 3", ChipKind.Good),
            new HealthCheck("Command set", "Up to date", ChipKind.Good),
            new HealthCheck("MCP server", "Found", ChipKind.Good),
        };

        public string GuardPath => @"%APPDATA%\Formcraft\fmc_guard.json";
        public IReadOnlyList<string> WriteRoots { get; } = new[] { @"Z:\Projects\*\01_WIP", @"Z:\00_Standards\04_Families\_Staging", @"Z:\00_Standards\06_Templates\_Staging" };
        public IReadOnlyList<string> NeverWritten { get; } = new[] { "02_Shared", "03_Published", "04_Archive", "05_Incoming" };
        public string ReportsFolder => @"%USERPROFILE%\FMC_Reports";
        public bool LiveModelLock => true;
        public bool ServiceRunning { get; private set; }
        public int Port => 8080;
        public int FixesRun { get; private set; }
        public string LastFeedback { get; private set; } = "";
        public event EventHandler? Changed;

        public void SetService(bool on) { ServiceRunning = on; Changed?.Invoke(this, EventArgs.Empty); }
        public void SetGuardMissing() { _guard = false; Changed?.Invoke(this, EventArgs.Empty); }

        public Task FixAsync(string fixId)
        {
            FixesRun++;
            if (fixId == "create-guard") _guard = true;
            Changed?.Invoke(this, EventArgs.Empty);
            return Task.CompletedTask;
        }

        public Task<string> ProbeAsync() => Task.FromResult(ServiceRunning
            ? "Probe OK in 42 ms: server, port 8080, command set and Revit all answer."
            : "Probe: the Claude service is off, so Claude can't reach Revit. Start it, then probe again.");

        public void Refresh() => Changed?.Invoke(this, EventArgs.Empty);
        public void OpenReportsFolder() { }
        public string ExportDiagnostics(string checksText) => @"%USERPROFILE%\FMC_Reports\FMC_Diagnostics_sample.zip";
        public string SaveFeedback(string text) { LastFeedback = text; return @"%USERPROFILE%\FMC_Reports\FMC_Feedback_sample.txt"; }
    }
}
