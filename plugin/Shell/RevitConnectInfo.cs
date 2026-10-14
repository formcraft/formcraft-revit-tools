using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using revit_mcp_plugin.Core;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Connect's live values in Revit (U12): the same readiness checks the server refuses on (fmc_guard.json, the command
    /// set, the MCP server, the kit data files), the guard's folders, the Claude service, and the support exports.
    /// </summary>
    public sealed class RevitConnectInfo : IConnectInfo
    {
        private GuardStatus _guard = GuardStatus.Load();
        private bool _running = SocketService.Instance.IsRunning;

        public event EventHandler Changed;

        public IReadOnlyList<HealthCheck> Checks
        {
            get
            {
                var list = new List<HealthCheck>
                {
                    new HealthCheck("Revit", string.IsNullOrEmpty(FormcraftBrowser.RevitBuild) ? FormcraftBrowser.RevitVersion : FormcraftBrowser.RevitBuild, ChipKind.Good),
                };
                if (!_guard.Found && _guard.Problem == "No fmc_guard.json")
                    list.Add(new HealthCheck("fmc_guard.json", "Missing", ChipKind.Bad, "Create from example…", "create-guard",
                        "Every file write is refused until it exists."));
                else if (!_guard.Found)
                    list.Add(new HealthCheck("fmc_guard.json", "Not valid JSON", ChipKind.Bad, "Open fmc_guard.json", "open-guard",
                        "The server refuses every write until the file is fixed."));
                else
                    list.Add(new HealthCheck("fmc_guard.json", "Found", ChipKind.Good));

                var roots = _guard.WriteRoots;
                int reachable = roots.Count(Reachable);
                list.Add(new HealthCheck("Write roots reachable", reachable + " of " + roots.Count,
                    roots.Count == 0 ? ChipKind.Bad : reachable == roots.Count ? ChipKind.Good : ChipKind.Warn,
                    detail: reachable == roots.Count ? "" : "A write root that isn't reachable (a drive not mapped?) refuses every write there."));

                list.Add(Readiness.FmcCommandsEnabled()
                    ? new HealthCheck("Command set", "Up to date", ChipKind.Good)
                    : new HealthCheck("Command set", "Out of date", ChipKind.Bad, "Command settings…", "command-settings",
                        "The live-model lock can't read the active file, so model tools are refused."));

                string server = ServerCli.Problem;
                list.Add(server == null
                    ? new HealthCheck("MCP server", "Found", ChipKind.Good)
                    : new HealthCheck("MCP server", server, ChipKind.Bad, server == "Node.js not found" ? "" : "Locate server folder…", "locate-server",
                        server == "Node.js not found" ? "Install Node.js 20 or later, then check again." : "The pane runs the same checks Claude does, from the installed server."));

                if (_guard.Found)
                {
                    bool specs = File.Exists(GuardStatus.ExpandEnv(_guard.SpecsPath));
                    list.Add(new HealthCheck("Family specs", specs ? "Found" : "Not found", specs ? ChipKind.Good : ChipKind.Warn,
                        detail: specs ? "" : "Family builds need FMC_Family_Specs.json: run the kit build, or fix specs_path in fmc_guard.json."));
                    bool sp = File.Exists(GuardStatus.ExpandEnv(_guard.SharedParameterFile));
                    list.Add(new HealthCheck("Shared parameter file", sp ? "Found" : "Not found", sp ? ChipKind.Good : ChipKind.Warn,
                        detail: sp ? "" : "Builds are refused without it. Fix shared_parameter_file in fmc_guard.json."));
                }
                return list;
            }
        }

        /// <summary>A write root is reachable when its folder (or, for a wildcard, the folder above it) exists.</summary>
        private static bool Reachable(string root)
        {
            string path = GuardStatus.ExpandEnv(root);
            int star = path.IndexOf('*');
            if (star >= 0) path = Path.GetDirectoryName(path.Substring(0, star).TrimEnd('\\', '/') + "\\x");
            try { return !string.IsNullOrEmpty(path) && Directory.Exists(path); } catch { return false; }
        }

        public string GuardPath => GuardStatus.DefaultConfigPath();
        public IReadOnlyList<string> WriteRoots => _guard.WriteRoots;
        public IReadOnlyList<string> NeverWritten => _guard.BlockedSegments;
        public string ReportsFolder => GuardStatus.ExpandEnv(_guard.ReportsDir);
        public bool LiveModelLock => _guard.LiveModelLock;
        public bool ServiceRunning => SocketService.Instance.IsRunning;
        public int Port => SocketService.Instance.Port;

        public void SetService(bool on)
        {
            if (on != SocketService.Instance.IsRunning) FormcraftBrowser.RequestToggleService();
        }

        /// <summary>Called on Idling: tells the pane when the Claude service starts or stops.</summary>
        public void Poll()
        {
            bool running = SocketService.Instance.IsRunning;
            if (running == _running) return;
            _running = running;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public Task FixAsync(string fixId)
        {
            switch (fixId)
            {
                case "create-guard": FmcFixes.CreateGuardFromExample(); break;
                case "open-guard": FormcraftBrowser.OpenGuardFile(); break;
                case "command-settings": FmcFixes.OpenCommandSettings(); break;
                case "locate-server": FmcFixes.LocateServer(); break;
            }
            Refresh();
            return Task.CompletedTask;
        }

        public async Task<string> ProbeAsync() => (await FmcFixes.ProbeAsync()).Text;

        public void Refresh()
        {
            _guard = GuardStatus.Load();
            ServerCli.Locate();
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void OpenReportsFolder() => FormcraftBrowser.OpenReports(_guard);

        /// <summary>
        /// FMC_Diagnostics_&lt;time&gt;.zip in the reports folder: the checks, versions, fmc_guard.json, the person's pane
        /// settings and the last 200 log lines, with file paths replaced by &lt;path&gt;. No model content.
        /// </summary>
        public string ExportDiagnostics(string checksText)
        {
            string folder = ReportsFolder;
            Directory.CreateDirectory(folder);
            string zip = Path.Combine(folder, "FMC_Diagnostics_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".zip");
            using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
            {
                Add(archive, "checks.txt", "Formcraft " + typeof(RevitConnectInfo).Assembly.GetName().Version + Environment.NewLine +
                                           "Revit " + FormcraftBrowser.RevitBuild + Environment.NewLine + Environment.NewLine + checksText);
                if (File.Exists(GuardPath)) Add(archive, "fmc_guard.json", Scrub(File.ReadAllText(GuardPath)));
                if (File.Exists(JsonUserSettings.DefaultPath)) Add(archive, "settings.json", Scrub(File.ReadAllText(JsonUserSettings.DefaultPath)));
                string log = Path.Combine(folder, "FMC_MCP_FileLog.csv");
                if (File.Exists(log)) Add(archive, "FMC_MCP_FileLog_last200.csv", Scrub(string.Join(Environment.NewLine, File.ReadAllLines(log).Reverse().Take(200).Reverse())));
            }
            return zip;
        }

        public string SaveFeedback(string text)
        {
            string folder = ReportsFolder;
            Directory.CreateDirectory(folder);
            string file = Path.Combine(folder, "FMC_Feedback_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".txt");
            File.WriteAllText(file, Scrub(text), Encoding.UTF8);
            return file;
        }

        private static void Add(ZipArchive archive, string name, string text)
        {
            using (var w = new StreamWriter(archive.CreateEntry(name).Open(), Encoding.UTF8)) w.Write(text);
        }

        /// <summary>Drive and network paths become &lt;path&gt;: support sees what happened, not where people keep files.</summary>
        public static string Scrub(string text) =>
            Regex.Replace(text ?? "", @"([A-Za-z]:\\|\\\\)[^,""\r\n;|]*", "<path>");
    }
}
