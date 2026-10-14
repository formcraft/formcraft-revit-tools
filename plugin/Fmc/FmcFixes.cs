using System;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Core;
using revit_mcp_plugin.UI;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// The fixes the readiness checks offer, and the probe, shared by Connect (U12) and the families and files page:
    /// create fmc_guard.json from the example, open it, open the command settings, locate the server, test the chain.
    /// </summary>
    public static class FmcFixes
    {
        /// <summary>Writes the example guard to its default place after a yes, then opens it. False when nothing was written.</summary>
        public static bool CreateGuardFromExample()
        {
            string target = GuardStatus.DefaultConfigPath();
            if (File.Exists(target)) return true;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("fmc_guard.example.json"))
            {
                if (s == null) { FmcDialog.Info("Create fmc_guard.json", "The example is missing from this add-in build."); return false; }
                if (!FmcDialog.Confirm("Create fmc_guard.json", $"Writes the example folder rules to\n{target}\n\n" +
                        "Then edit the folders to match this PC: the example uses Z:\\00_Standards and Z:\\Projects.",
                        null, "Create and open")) return false;
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (var f = File.Create(target)) s.CopyTo(f);
            }
            FormcraftBrowser.OpenGuardFile();
            return true;
        }

        /// <summary>Asks for the MCP server folder (the one with build\index.js) and remembers it.</summary>
        public static bool LocateServer()
        {
            using (var dlg = new System.Windows.Forms.FolderBrowserDialog
            {
                Description = "Choose the MCP server folder (the one with build\\index.js), e.g. C:\\Users\\<you>\\mcp\\revit-fmc",
                ShowNewFolderButton = false,
            })
            {
                if (dlg.ShowDialog() != System.Windows.Forms.DialogResult.OK) return false;
                if (!File.Exists(Path.Combine(dlg.SelectedPath, "build", "index.js")))
                {
                    FmcDialog.Info("Locate server folder", $"{dlg.SelectedPath} has no build\\index.js.");
                    return false;
                }
                BrowserSettings.ServerDir = dlg.SelectedPath;
            }
            ServerCli.Locate();
            return true;
        }

        /// <summary>The add-in's command settings window (enable or disable its MCP commands).</summary>
        public static void OpenCommandSettings()
        {
            var window = new SettingsWindow();
            _ = new System.Windows.Interop.WindowInteropHelper(window) { Owner = System.Diagnostics.Process.GetCurrentProcess().MainWindowHandle };
            window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            window.Show();
        }

        /// <summary>Tests the chain Claude uses (node server, port 8080, command set, Revit). A sentence, and whether it passed.</summary>
        public static async Task<(bool Ok, string Text)> ProbeAsync()
        {
            if (!SocketService.Instance.IsRunning)
                return (false, "Probe: the Claude service is off, so Claude can't reach Revit. Start it, then probe again.");
            CliResult r = await ServerCli.RunAsync("probe");
            if (!r.Ok) return (false, "Probe failed: " + string.Join(" ", r.Reasons()));
            string active = r.Body["active"]?.Value<string>("title");
            int open = (r.Body["documents"] as JArray)?.Count ?? 0;
            return (true, $"Probe OK in {r.Body.Value<int>("ms")} ms: server, port 8080, command set and Revit all answer. " +
                          (active == null ? "No active document." : $"Active: {active}; {open} open."));
        }
    }
}
