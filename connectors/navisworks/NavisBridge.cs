using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Autodesk.Navisworks.Api.Plugins;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Formcraft.Navis
{
    /// <summary>
    /// Starts with Navisworks and listens on 127.0.0.1 only (FMC_NAVIS_PORT, default 8190) for the MCP server's fmc_navis.
    /// One JSON request per line, {"id","method","params"}, one JSON reply per line. Every command runs on Navisworks' main
    /// thread. The port and process are written to %APPDATA%\Formcraft\navis.json so the server finds this Navisworks.
    /// </summary>
    [Plugin("FormcraftBridge", "FMCF", DisplayName = "Formcraft bridge")]
    public class NavisBridge : EventWatcherPlugin
    {
        private static TcpListener _listener;
        private static Control _ui;
        public static int Port { get; private set; }
        public static string State { get; private set; } = "Not started";

        public override void OnLoaded()
        {
            try
            {
                _ui = new Control();
                _ui.CreateControl(); // a handle on the main thread: Invoke runs commands there
                Port = int.TryParse(Environment.GetEnvironmentVariable("FMC_NAVIS_PORT"), out int p) ? p : 8190;
                _listener = new TcpListener(IPAddress.Loopback, Port);
                _listener.Start();
                new Thread(Accept) { IsBackground = true, Name = "Formcraft bridge" }.Start();
                WriteState();
                State = "Listening on 127.0.0.1:" + Port;
            }
            catch (Exception e)
            {
                State = "Not listening: " + e.Message;
            }
        }

        public override void OnUnloading()
        {
            try { _listener?.Stop(); } catch (Exception) { /* closing */ }
            try { File.Delete(StateFile); } catch (Exception) { /* closing */ }
        }

        private static string StateFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "navis.json");

        private static void WriteState()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StateFile));
            File.WriteAllText(StateFile, new JObject
            {
                ["port"] = Port, ["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id, ["started"] = DateTime.UtcNow.ToString("s") + "Z",
            }.ToString());
        }

        private static void Accept()
        {
            while (true)
            {
                TcpClient client;
                try { client = _listener.AcceptTcpClient(); } catch (Exception) { return; }
                new Thread(() => Serve(client)) { IsBackground = true }.Start();
            }
        }

        private static void Serve(TcpClient client)
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" })
            {
                string line;
                while ((line = SafeRead(reader)) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    JObject reply;
                    JToken id = null;
                    try
                    {
                        JObject req = JObject.Parse(line);
                        id = req["id"];
                        string method = req.Value<string>("method") ?? "";
                        JObject prms = req["params"] as JObject ?? new JObject();
                        JObject result = null;
                        Exception error = null;
                        _ui.Invoke((MethodInvoker)(() =>
                        {
                            try { result = NavisCommands.Run(method, prms); } catch (Exception e) { error = e; }
                        }));
                        reply = error == null ? new JObject { ["id"] = id, ["result"] = result } : new JObject { ["id"] = id, ["error"] = error.Message };
                    }
                    catch (Exception e)
                    {
                        reply = new JObject { ["id"] = id, ["error"] = e.Message };
                    }
                    writer.WriteLine(reply.ToString(Formatting.None));
                }
            }
        }

        private static string SafeRead(StreamReader r)
        {
            try { return r.ReadLine(); } catch (Exception) { return null; }
        }
    }
}
