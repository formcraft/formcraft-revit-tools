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
    /// F-064: a running job writes a "heartbeat" line every minute (fmc_job keeps saying "running" while they come, and the
    /// server keeps waiting past its limit), and when it ends Revit writes its result to FMC_LateResults.jsonl itself, so
    /// the answer is kept even when the MCP server stopped waiting or was restarted.
    /// </summary>
    public sealed class RevitJobLog : IDisposable
    {
        public const int RunningAfterMs = 20000;
        public const int HeartbeatMs = 60000;
        /// <summary>Results larger than this are kept cut (characters), so one answer can't swell the file.</summary>
        public const int MaxResultChars = 5_000_000;

        private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
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
            _timer = new Timer(_ => MarkRunning(), null, RunningAfterMs, HeartbeatMs);
        }

        public static RevitJobLog Watch(string job, string command) => new RevitJobLog(job, command);

        /// <summary>When the call arrived (UTC).</summary>
        public DateTime Started => _started;

        private void MarkRunning()
        {
            if (Volatile.Read(ref _done) == 1) return;
            RevitWake.KeepSystemAwake();
            if (Interlocked.Exchange(ref _running, 1) == 1)
            {
                Write(new JObject { ["event"] = "heartbeat", ["started"] = _started.ToString("o"), ["ms"] = (long)(DateTime.UtcNow - _started).TotalMilliseconds });
                return;
            }
            Write(new JObject { ["event"] = "running", ["started"] = _started.ToString("o") });
        }

        /// <summary>F-064: the call waits behind another command (`ahead` commands before it). Written at once, so fmc_job shows
        /// "queued"; heartbeats then follow as for any job.</summary>
        public void Queued(int ahead)
        {
            if (Volatile.Read(ref _done) == 1) return;
            Interlocked.Exchange(ref _running, 1);
            Write(new JObject { ["event"] = "queued", ["started"] = _started.ToString("o"), ["ahead"] = ahead });
        }

        /// <summary>F-064: a queued call got Revit's API thread and starts now.</summary>
        public void LeftQueue()
        {
            if (Volatile.Read(ref _done) == 1) return;
            Write(new JObject { ["event"] = "running", ["started"] = _started.ToString("o"), ["queued_ms"] = (long)(DateTime.UtcNow - _started).TotalMilliseconds });
        }

        /// <summary>F-072: a line of its own for this job (bridge_busy, bridge_free); the job then counts as long, so its
        /// "finished" line and result are written when it ends.</summary>
        public void Event(string name, JObject extra = null)
        {
            if (Volatile.Read(ref _done) == 1) return;
            Interlocked.Exchange(ref _running, 1);
            var line = new JObject { ["event"] = name, ["started"] = _started.ToString("o") };
            if (extra != null) foreach (var p in extra.Properties()) line[p.Name] = p.Value;
            Write(line);
        }

        /// <summary>The call ended (answered or failed); written only when it ran long enough to be a job. A long job's
        /// result (or error) also goes to FMC_LateResults.jsonl from here, so it is never lost (F-064).</summary>
        public void Done(bool ok, string error = null, object result = null)
        {
            if (Interlocked.Exchange(ref _done, 1) == 1) return;
            _timer.Dispose();
            long ms = (long)(DateTime.UtcNow - _started).TotalMilliseconds;
            if (Volatile.Read(ref _running) == 0 && ms < RunningAfterMs) return;
            var line = new JObject { ["event"] = "finished", ["started"] = _started.ToString("o"), ["ms"] = ms, ["ok"] = ok };
            if (!string.IsNullOrEmpty(error)) line["error"] = error.Length > 500 ? error.Substring(0, 500) + "…" : error;
            Write(line);
            WriteResult(ok, error, result);
        }

        private void WriteResult(bool ok, string error, object result)
        {
            try
            {
                JToken body;
                if (!ok) body = new JObject { ["error"] = new JObject { ["message"] = error ?? "failed" } };
                else
                {
                    JToken r = result == null ? JValue.CreateNull() : result as JToken ?? JToken.FromObject(result);
                    string text = r.ToString(Formatting.None);
                    body = new JObject { ["result"] = text.Length > MaxResultChars ? (JToken)(text.Substring(0, MaxResultChars) + "…") : r };
                }
                var line = new JObject { ["at"] = DateTime.UtcNow.ToString("o"), ["job"] = _job, ["command"] = _command, ["from"] = "revit", ["result"] = body };
                Append("FMC_LateResults.jsonl", line);
            }
            catch (Exception)
            {
                // The record must never stop the work.
            }
        }

        public void Dispose() => Done(true);

        private static void Append(string file, JObject line)
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft");
            Directory.CreateDirectory(dir);
            byte[] bytes = Encoding.UTF8.GetBytes(line.ToString(Formatting.None) + "\n");
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    using (var fs = new FileStream(Path.Combine(dir, file), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                        fs.Write(bytes, 0, bytes.Length);
                    return;
                }
                catch (IOException) { Thread.Sleep(20); }
            }
        }

        private void Write(JObject detail)
        {
            try
            {
                // pid: which Revit wrote it, so the unattended test runner reads only its own Revit's jobs (F75)
                var line = new JObject { ["at"] = DateTime.UtcNow.ToString("o"), ["job"] = _job, ["command"] = _command, ["pid"] = Pid };
                foreach (var p in detail.Properties()) line[p.Name] = p.Value;
                Append("FMC_Jobs_Revit.jsonl", line);
            }
            catch (Exception)
            {
                // The record must never stop the work.
            }
        }
    }
}
