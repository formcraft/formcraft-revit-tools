using System;
using System.IO;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// F-030/F-036 (issues #122, #128): what Revit itself saw of a long AI call, in %APPDATA%\Formcraft\FMC_Jobs_Revit.jsonl.
    /// A call still running after <see cref="RunningAfterMs"/> gets a "running" line, and when it ends a "finished" line
    /// with its time and whether it failed. Short calls write nothing. fmc_job reads this file with the server's own job
    /// record and late results, so a job's state is known even when the MCP server that sent it has gone.
    /// The command set adds "dialog" and "cancelled" lines (commandset/Bridge/FmcAiJob.cs).
    /// </summary>
    public sealed class RevitJobLog : IDisposable
    {
        public const int RunningAfterMs = 20000;

        private readonly string _job;
        private readonly string _command;
        private readonly DateTime _started = DateTime.UtcNow;
        private readonly Timer _timer;
        private int _running;
        private int _done;

        private RevitJobLog(string job, string command)
        {
            _job = job ?? "";
            _command = command ?? "";
            _timer = new Timer(_ => MarkRunning(), null, RunningAfterMs, Timeout.Infinite);
        }

        public static RevitJobLog Watch(string job, string command) => new RevitJobLog(job, command);

        private void MarkRunning()
        {
            if (Volatile.Read(ref _done) == 1 || Interlocked.Exchange(ref _running, 1) == 1) return;
            Write(new JObject { ["event"] = "running", ["started"] = _started.ToString("o") });
        }

        /// <summary>The call ended (answered or failed); written only when it ran long enough to be a job.</summary>
        public void Done(bool ok, string error = null)
        {
            if (Interlocked.Exchange(ref _done, 1) == 1) return;
            _timer.Dispose();
            long ms = (long)(DateTime.UtcNow - _started).TotalMilliseconds;
            if (Volatile.Read(ref _running) == 0 && ms < RunningAfterMs) return;
            var line = new JObject { ["event"] = "finished", ["started"] = _started.ToString("o"), ["ms"] = ms, ["ok"] = ok };
            if (!string.IsNullOrEmpty(error)) line["error"] = error.Length > 500 ? error.Substring(0, 500) + "…" : error;
            Write(line);
        }

        public void Dispose() => Done(true);

        private void Write(JObject detail)
        {
            try
            {
                var line = new JObject { ["at"] = DateTime.UtcNow.ToString("o"), ["job"] = _job, ["command"] = _command };
                foreach (var p in detail.Properties()) line[p.Name] = p.Value;
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft");
                Directory.CreateDirectory(dir);
                byte[] bytes = Encoding.UTF8.GetBytes(line.ToString(Formatting.None) + "\n");
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    try
                    {
                        using (var fs = new FileStream(Path.Combine(dir, "FMC_Jobs_Revit.jsonl"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                            fs.Write(bytes, 0, bytes.Length);
                        return;
                    }
                    catch (IOException) { Thread.Sleep(20); }
                }
            }
            catch (Exception)
            {
                // The record must never stop the work.
            }
        }
    }
}
