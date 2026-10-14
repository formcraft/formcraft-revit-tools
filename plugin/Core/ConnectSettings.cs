using System;
using System.IO;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// The AI connection's settings, in %APPDATA%\Formcraft\fmc_connect.json. The add-in and the MCP server both read
    /// this file, so the port always matches. Written with the defaults the first time it's read:
    ///   start_with_revit  switch the AI connection on when Revit starts (default true)
    ///   port              the port on this PC (default 8080); the connection listens on 127.0.0.1 only
    /// </summary>
    public sealed class ConnectSettings
    {
        public const int DefaultPort = 8080;

        public bool StartWithRevit { get; set; } = true;
        public int Port { get; set; } = DefaultPort;

        public static string FilePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "fmc_connect.json");

        public static ConnectSettings Load()
        {
            var s = new ConnectSettings();
            try
            {
                if (!File.Exists(FilePath)) { s.Save(); return s; }
                JObject o = JObject.Parse(File.ReadAllText(FilePath));
                s.StartWithRevit = o.Value<bool?>("start_with_revit") ?? true;
                int port = o.Value<int?>("port") ?? DefaultPort;
                s.Port = port > 0 && port < 65536 ? port : DefaultPort;
            }
            catch (Exception)
            {
                // A file someone broke by hand: fall back to the defaults, never stop Revit starting.
            }
            return s;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                var o = new JObject
                {
                    ["start_with_revit"] = StartWithRevit,
                    ["port"] = Port,
                    ["_help"] = "Formcraft AI connection. start_with_revit: switch on when Revit starts. port: on this PC only (127.0.0.1); the MCP server reads the same file. Restart Revit after changing the port.",
                };
                File.WriteAllText(FilePath, o.ToString());
            }
            catch (Exception)
            {
                // Settings that can't be saved keep their defaults for this session.
            }
        }
    }
}
