using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Rhino.PlugIns;

[assembly: Guid("4b23fea8-1aa1-4121-95f8-fce4088db20f")]
[assembly: PlugInDescription(DescriptionType.Organization, "Formcraft")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://github.com/formcraft/formcraft-revit-tools")]

namespace Formcraft.Rhino
{
    /// <summary>
    /// Starts with Rhino and listens on 127.0.0.1 only (FMC_RHINO_PORT, default 8191; the next free one up to 8199 when a
    /// second Rhino is open) for the MCP server's fmc_rhino. One JSON request per line, {"id","method","params"}, one JSON
    /// reply per line. Commands run one at a time on the bridge's own worker thread: they build geometry in the bridge's
    /// memory and write files with openNURBS, so they never touch the person's drawing or wait on Rhino's window.
    /// The port and process are written to %APPDATA%\Formcraft\apps\rhino.json so the server finds this Rhino.
    /// </summary>
    public class RhinoBridge : PlugIn
    {
        private static TcpListener _listener;
        private static readonly BlockingCollection<Action> Work = new BlockingCollection<Action>();
        public static int Port { get; private set; }
        public static string State { get; private set; } = "Not started";

        public override PlugInLoadTime LoadTime => PlugInLoadTime.AtStartup;

        protected override LoadReturnCode OnLoad(ref string errorMessage)
        {
            try
            {
                int first = int.TryParse(Environment.GetEnvironmentVariable("FMC_RHINO_PORT"), out int p) ? p : 8191;
                for (int port = first; port < first + 9 && _listener == null; port++)
                {
                    try { var l = new TcpListener(IPAddress.Loopback, port); l.Start(); _listener = l; Port = port; }
                    catch (SocketException) { /* another Rhino has it: try the next */ }
                }
                if (_listener == null) { State = "Not listening: ports " + first + "-" + (first + 8) + " are taken"; return LoadReturnCode.Success; }
                new Thread(Worker) { IsBackground = true, Name = "Formcraft worker" }.Start();
                new Thread(Accept) { IsBackground = true, Name = "Formcraft bridge" }.Start();
                WriteState();
                State = "Listening on 127.0.0.1:" + Port;
            }
            catch (Exception e)
            {
                State = "Not listening: " + e.Message;
            }
            // the bridge never stops Rhino from loading
            return LoadReturnCode.Success;
        }

        protected override void OnShutdown()
        {
            try { _listener?.Stop(); } catch (Exception) { /* closing */ }
            try
            {
                // only this Rhino's own state file: a second Rhino may have written it since
                if (File.Exists(StateFile) && JObject.Parse(File.ReadAllText(StateFile)).Value<int>("pid") == System.Diagnostics.Process.GetCurrentProcess().Id)
                    File.Delete(StateFile);
            }
            catch (Exception) { /* closing */ }
        }

        private static string StateFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "apps", "rhino.json");

        private static void WriteState()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StateFile));
            File.WriteAllText(StateFile, new JObject
            {
                ["port"] = Port, ["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id, ["started"] = DateTime.UtcNow.ToString("s") + "Z",
                ["rhino"] = global::Rhino.RhinoApp.Version.ToString(), ["bridge"] = typeof(RhinoBridge).Assembly.GetName().Version.ToString(),
            }.ToString());
        }

        private static void Worker()
        {
            foreach (Action a in Work.GetConsumingEnumerable())
            {
                try { a(); } catch (Exception) { /* each job reports its own error */ }
            }
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
                        using (var done = new ManualResetEventSlim(false))
                        {
                            Work.Add(() =>
                            {
                                try { result = RhinoCommands.Run(method, prms); } catch (Exception e) { error = e; }
                                finally { done.Set(); }
                            });
                            done.Wait();
                        }
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
