using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace Formcraft.Navis
{
    /// <summary>
    /// Send to review (docs/PLAN_MARK_REVIEW.md, R5): a clash test's New and Active clashes become tickets in the
    /// project's review register, through the Formcraft server (fmc_review clashes), so they sit in the same list as the
    /// marks people make in Revit; a click there selects the elements and opens a section box on the clash. The server
    /// reads the clashes back through this bridge, so the call runs off Navisworks' main thread.
    /// </summary>
    public static class NavisReview
    {
        /// <summary>The project folder: the nearest folder above the Navisworks file that has 01_WIP; empty when there is none.</summary>
        public static string ProjectFolder(string file)
        {
            try
            {
                var dir = string.IsNullOrEmpty(file) ? null : new DirectoryInfo(Path.GetDirectoryName(file));
                while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "01_WIP"))) dir = dir.Parent;
                return dir?.FullName ?? "";
            }
            catch (Exception) { return ""; }
        }

        /// <summary>The Formcraft server's folder, found as the Revit add-in finds it: FMC_SERVER_DIR, the Claude config, the default folder.</summary>
        public static string ServerDir()
        {
            string env = Environment.GetEnvironmentVariable("FMC_SERVER_DIR");
            if (IsServer(env)) return env;
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            foreach (string config in new[] { Path.Combine(roaming, "Claude", "claude_desktop_config.json") }.Where(File.Exists))
            {
                try
                {
                    var entry = JObject.Parse(File.ReadAllText(config))["mcpServers"]?["mcp-server-for-revit"] as JObject;
                    string index = (entry?["args"] as JArray)?.Select(a => a.ToString()).FirstOrDefault(a => a.EndsWith("index.js", StringComparison.OrdinalIgnoreCase));
                    string dir = index == null ? null : Path.GetDirectoryName(Path.GetDirectoryName(index));
                    if (IsServer(dir)) return dir;
                }
                catch (Exception) { /* the next place */ }
            }
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "mcp", "revit-fmc");
            return IsServer(fallback) ? fallback : null;
        }

        private static bool IsServer(string dir) => !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "build", "fmc", "cli.js"));

        /// <summary>The clash test's clashes into the register (a real run: the person pressed Send); the server's answer.</summary>
        public static Task<JObject> SendAsync(string test, string projectFolder) => Task.Run(() =>
        {
            string server = ServerDir() ?? throw new InvalidOperationException("The Formcraft server isn't installed on this PC");
            var args = new JObject { ["action"] = "clashes", ["test"] = test, ["project_folder"] = projectFolder, ["dry_run"] = false, ["by"] = Environment.UserName };
            var psi = new ProcessStartInfo("node", "\"" + Path.Combine(server, "build", "fmc", "cli.js") + "\" fmc_review")
            {
                UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8,
            };
            using (var p = Process.Start(psi) ?? throw new InvalidOperationException("Node didn't start"))
            {
                p.StandardInput.Write(args.ToString());
                p.StandardInput.Close();
                string outText = p.StandardOutput.ReadToEnd();
                p.WaitForExit(120000);
                try { return JObject.Parse(outText); }
                catch (Exception) { throw new InvalidOperationException("The server's answer wasn't readable: " + outText.Substring(0, Math.Min(300, outText.Length))); }
            }
        });
    }
}
