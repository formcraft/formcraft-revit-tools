using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// Every Revit with the AI connection on announces itself in %APPDATA%\Formcraft\instances\&lt;pid&gt;.json: its port,
    /// Revit version and open documents. The MCP server reads these to reach the right Revit when two or more are open,
    /// so two projects can be automated at once. The file goes when the connection stops or Revit closes; a file whose
    /// process is gone is ignored by the server.
    /// </summary>
    public static class InstanceRegistry
    {
        public static string Folder => Path.Combine(Path.GetDirectoryName(ConnectSettings.FilePath), "instances");
        private static string FileFor(int pid) => Path.Combine(Folder, pid + ".json");
        private static readonly DateTime Started = DateTime.UtcNow;
        private static readonly AnnounceGate Gate = new AnnounceGate();

        /// <summary>The port last written for this process, or 0 when the file has been removed.</summary>
        public static int PublishedPort => Gate.Port;

        /// <summary>Write the instance file for this listener generation. An older generation cannot put its port back.</summary>
        public static void Announce(int port, int generation)
        {
            Gate.Publish(generation, port, () => Write(port, FormcraftBrowser.OpenDocuments));
        }

        /// <summary>The open documents changed (called at idle, only when they did). The port is the one the socket is bound to.</summary>
        public static void Documents(IReadOnlyList<DocState> docs, int port, int generation)
        {
            Gate.Publish(generation, port, () => Write(port, docs));
        }

        private static void Write(int port, IReadOnlyList<DocState> docs)
        {
            try
            {
                if (port <= 0) return;
                Directory.CreateDirectory(Folder);
                var o = new JObject
                {
                    ["pid"] = Process.GetCurrentProcess().Id, ["port"] = port, ["revit"] = FormcraftBrowser.RevitBuild,
                    ["user"] = Environment.UserName, ["started"] = Started.ToString("o"), ["updated"] = DateTime.UtcNow.ToString("o"),
                    ["build"] = FmcBuildInfo.Commit,
                    // F75: started by the unattended test runner, which talks only to a Revit that says so
                    ["unattended"] = UnattendedMode.On,
                    ["documents"] = new JArray((docs ?? new List<DocState>()).Select(d => new JObject
                    {
                        ["title"] = d.Title, ["path"] = d.Path, ["active"] = d.IsActive, ["family"] = d.IsFamily, ["workshared"] = d.IsWorkshared,
                    })),
                };
                string file = FileFor(Process.GetCurrentProcess().Id);
                string tmp = file + "." + Guid.NewGuid().ToString("n") + ".tmp";
                File.WriteAllText(tmp, o.ToString());
                if (File.Exists(file)) File.Delete(file);
                File.Move(tmp, file);
            }
            catch (Exception) { /* the registry is a convenience: the connection works without it */ }
        }

        /// <summary>Delete this process's instance file when this generation is still the published one.</summary>
        public static bool Retire(int generation)
        {
            return Gate.Retire(generation, DeleteFile);
        }

        /// <summary>Delete this process's instance file. Call only when this process is not listening.</summary>
        public static void Remove()
        {
            Gate.Clear(DeleteFile);
        }

        private static void DeleteFile()
        {
            try { File.Delete(FileFor(Process.GetCurrentProcess().Id)); } catch (Exception) { /* already gone */ }
        }

        /// <summary>Deletes instance files whose Revit process is gone. A live process removes its own file when its listener stops.</summary>
        public static void SweepDead()
        {
            try
            {
                if (!Directory.Exists(Folder)) return;
                foreach (string file in Directory.GetFiles(Folder, "*.json"))
                {
                    try
                    {
                        int pid = JObject.Parse(File.ReadAllText(file)).Value<int?>("pid") ?? 0;
                        if (pid <= 0 || !Alive(pid)) File.Delete(file);
                    }
                    catch (Exception) { /* a half-written file is read again next time */ }
                }
            }
            catch (Exception) { /* the folder is a convenience */ }
        }

        private static bool Alive(int pid)
        {
            try
            {
                using (Process.GetProcessById(pid)) return true;
            }
            catch (ArgumentException) { return false; }
            catch (Exception) { return true; }
        }
    }
}
