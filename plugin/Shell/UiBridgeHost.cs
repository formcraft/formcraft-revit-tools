using System;
using System.Collections.Generic;
using System.Linq;
using Formcraft.Shell.Services;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// The add-in end of the fmc_ui MCP tool (U11). The command set (a separate assembly) finds this class by name and
    /// calls <see cref="Run"/> on Revit's main thread, which is also the pane's UI thread. JSON strings in and out keep the
    /// two assemblies free of each other's types. Read-only for the model: it only reads and steers the pane.
    /// </summary>
    public static class UiBridgeHost
    {
        private static UiBridge _bridge;

        /// <summary>
        /// set_mock_licence is for testing: a Debug build, FMC_UI_TEST=1 in Revit's environment, or the test PC's file
        /// %APPDATA%\Formcraft\fmc_test.json {"ui_test": true, "pc": "&lt;computer name&gt;"} (F-020). The file counts only on
        /// the PC it names, so a copy elsewhere does nothing; it is never part of a customer install.
        /// </summary>
        public static bool AllowMockLicence
        {
            get
            {
#if DEBUG
                return true;
#else
                return Environment.GetEnvironmentVariable("FMC_UI_TEST") == "1" || TestPcFile();
#endif
            }
        }

        public static string TestFilePath => System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "fmc_test.json");

        private static bool TestPcFile()
        {
            try
            {
                if (!System.IO.File.Exists(TestFilePath)) return false;
                var o = JObject.Parse(System.IO.File.ReadAllText(TestFilePath));
                return o.Value<bool?>("ui_test") == true
                    && string.Equals(o.Value<string>("pc") ?? "", Environment.MachineName, StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
        }

        internal static void Attach(UiBridge bridge) => _bridge = bridge;

        /// <summary>Runs one fmc_ui action. Returns the result as JSON; throws with a message Claude can act on.</summary>
        public static string Run(string action, string parametersJson)
        {
            if (_bridge == null) throw new InvalidOperationException("The Formcraft pane hasn't started in this Revit session.");
            var p = string.IsNullOrEmpty(parametersJson) ? new JObject() : JObject.Parse(parametersJson);
            object result;
            switch (action)
            {
                case "get_state":
                    // With the installed build, so a tester sees at once which build is in Revit.
                    var state = JObject.FromObject(_bridge.GetState());
                    state["build"] = new JObject { ["commit"] = revit_mcp_plugin.FmcBuildInfo.Commit, ["built"] = revit_mcp_plugin.FmcBuildInfo.Time };
                    result = state;
                    break;
                case "open_section":
                    result = _bridge.OpenSection((string)p["section"] ?? "");
                    break;
                case "set_mock_licence":
                    var modules = (p["modules"] as JObject)?.Properties().ToDictionary(x => x.Name, x => (string)x.Value);
                    result = _bridge.SetMockLicence((string)p["preset"] ?? "", modules);
                    break;
                case "screenshot_pane":
                    var folder = GuardStatus.ExpandEnv(GuardStatus.Load().ReportsDir);
                    result = new Dictionary<string, object> { ["path"] = _bridge.ScreenshotPane(folder) };
                    break;
                default:
                    throw new ArgumentException("Unknown fmc_ui action '" + action + "'. Actions: get_state, open_section, set_mock_licence, screenshot_pane.");
            }
            return JsonConvert.SerializeObject(result);
        }
    }
}
