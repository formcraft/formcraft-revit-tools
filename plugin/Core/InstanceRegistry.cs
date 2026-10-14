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
        private static int _port;

        public static void Announce(int port)
        {
            _port = port;
            Write(FormcraftBrowser.OpenDocuments);
        }

        /// <summary>The open documents changed (called at idle, only when they did).</summary>
        public static void Documents(IReadOnlyList<DocState> docs)
        {
            if (_port > 0) Write(docs);
        }

        private static void Write(IReadOnlyList<DocState> docs)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                var o = new JObject
                {
                    ["pid"] = Process.GetCurrentProcess().Id, ["port"] = _port, ["revit"] = FormcraftBrowser.RevitBuild,
                    ["user"] = Environment.UserName, ["started"] = Started.ToString("o"), ["updated"] = DateTime.UtcNow.ToString("o"),
                    ["build"] = FmcBuildInfo.Commit,
                    ["documents"] = new JArray((docs ?? new List<DocState>()).Select(d => new JObject
                    {
                        ["title"] = d.Title, ["path"] = d.Path, ["active"] = d.IsActive, ["family"] = d.IsFamily, ["workshared"] = d.IsWorkshared,
                    })),
                };
                string file = FileFor(Process.GetCurrentProcess().Id), tmp = file + ".tmp";
                File.WriteAllText(tmp, o.ToString());
                if (File.Exists(file)) File.Delete(file);
                File.Move(tmp, file);
            }
            catch (Exception) { /* the registry is a convenience: the connection works without it */ }
        }

        public static void Remove()
        {
            _port = 0;
            try { File.Delete(FileFor(Process.GetCurrentProcess().Id)); } catch (Exception) { /* already gone */ }
        }
    }
}
