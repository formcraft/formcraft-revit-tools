using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// The AI job running now on Revit's API thread (F-030/F-032, issues #122 and #124).
    /// <para>Every call from the MCP server is a job: its id is the JSON-RPC request id, which the add-in puts in the
    /// command's parameters as <c>_fmcJob</c>. A handler calls <see cref="Enter"/> when it starts work (FmcTarget.Resolve
    /// does it for every Formcraft handler; send_code_to_revit does it itself). While a job is executing:</para>
    /// <list type="bullet">
    /// <item>failures in any transaction get the default handling of <see cref="FmcFailures"/> (warnings deleted and
    /// listed, errors roll back with their text) when the transaction has no preprocessor of its own that handled them;</item>
    /// <item>Revit's "Project Not Saved Recently" reminder is closed without saving (never saved: rule 6), and every
    /// other dialog is recorded (not answered) so fmc_job can say what Revit is waiting for. See docs/BRIDGE.md.</item>
    /// </list>
    /// <para>The executing flag clears at Revit's next Idling (no add-in code runs then), so a person's own work in Revit
    /// never gets this handling.</para>
    /// <para>Cancel (fmc_job cancel) is a file, %APPDATA%\Formcraft\jobs\cancel\&lt;job&gt;: a job that hasn't started is
    /// skipped, a script can call <see cref="ThrowIfCancelled"/> between steps, and send_code's own transaction is rolled
    /// back instead of committed. Revit is never closed or interrupted.</para>
    /// </summary>
    public static class FmcAiJob
    {
        public const string JobParameter = "_fmcJob";

        private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;

        private static bool _hooked;
        private static volatile bool _executing;
        private static string _current = "";
        private static readonly List<JObject> _dialogs = new List<JObject>();

        /// <summary>The running job's failures: transactions an AI tool opens attach it, and the default handling fills it.</summary>
        public static FmcFailures Failures { get; } = new FmcFailures();

        /// <summary>Dialogs Revit showed during the running job, each with what was answered (or "left for a person").</summary>
        public static IReadOnlyList<JObject> Dialogs => _dialogs;

        /// <summary>The job id of the call running now (or last run), "" when unknown.</summary>
        public static string Current => _current;

        /// <summary>True while an AI handler is executing on Revit's API thread.</summary>
        public static bool Executing => _executing;

        /// <summary>The job id the add-in put in a command's parameters, "" when there is none.</summary>
        public static string JobOf(JObject parameters)
        {
            try { return parameters?.Value<string>(JobParameter) ?? ""; }
            catch (Exception) { return ""; }
        }

        /// <summary>
        /// Marks an AI job as executing now (call on Revit's API thread, at the start of the handler's work). Throws
        /// OperationCanceledException with FMC-JOB-CANCELLED when the job was cancelled before it started.
        /// </summary>
        public static void Enter(UIApplication app, string job)
        {
            Hook(app);
            job = job ?? "";
            bool sameJob = _executing && string.Equals(job, _current, StringComparison.Ordinal);
            if (!sameJob)
            {
                _current = job;
                Failures.Clear();
                _dialogs.Clear();
            }
            _executing = true;
            if (job.Length > 0 && CancelRequested(job))
            {
                _executing = false;
                Log(job, "cancelled", new JObject { ["when"] = "before it started" });
                throw new OperationCanceledException($"FMC-JOB-CANCELLED: job {job} was cancelled before it started; nothing was changed.");
            }
        }

        /// <summary>Marks the AI job as finished (the next Idling does it too).</summary>
        public static void Exit() => _executing = false;

        /// <summary>True when a person (or the AI) asked fmc_job to cancel this job.</summary>
        public static bool CancelRequested(string job)
        {
            if (string.IsNullOrEmpty(job) || !SafeId(job)) return false;
            try { return File.Exists(Path.Combine(FormcraftDir(), "jobs", "cancel", job)); }
            catch (Exception) { return false; }
        }

        /// <summary>For scripts and long handlers: stop here if the running job was cancelled.</summary>
        public static void ThrowIfCancelled()
        {
            string job = _current;
            if (CancelRequested(job))
            {
                Log(job, "cancelled", new JObject { ["when"] = "at a cancel check" });
                throw new OperationCanceledException($"FMC-JOB-CANCELLED: job {job} was cancelled.");
            }
        }

        private static void Hook(UIApplication app)
        {
            if (_hooked || app == null) return;
            try
            {
                app.Application.FailuresProcessing += OnFailuresProcessing;
                app.DialogBoxShowing += OnDialogBoxShowing;
                app.Idling += OnIdling;
                _hooked = true;
            }
            catch (Exception)
            {
                // Without the hooks AI transactions still use their own preprocessors; dialogs then wait for a person.
            }
        }

        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            // Revit is idle: no AI handler is executing, so a person's own work never gets the AI's handling.
            if (_executing) _executing = false;
        }

        private static void OnFailuresProcessing(object sender, FailuresProcessingEventArgs e)
        {
            if (!_executing) return;
            try
            {
                FailuresAccessor accessor = e.GetFailuresAccessor();
                FailureProcessingResult result;
                if (CancelRequested(_current))
                {
                    Log(_current, "cancelled", new JObject { ["when"] = "at a transaction commit (rolled back)" });
                    result = Failures.RollBackForCancel(accessor, $"FMC-JOB-CANCELLED: job {_current} was cancelled; the transaction was rolled back.");
                }
                else result = Failures.Process(accessor);
                if (result != FailureProcessingResult.Continue) e.SetProcessingResult(result);
            }
            catch (Exception)
            {
                // Leave the failures to Revit's own handling.
            }
        }

        /// <summary>
        /// The one dialog answered for an AI job is the save reminder ("Project Not Saved Recently"): it is closed with
        /// Cancel, which leaves the model unsaved. Nothing ever saves (rule 6). Every other dialog is left for a person
        /// and recorded with its id and text, so fmc_job status shows what Revit is waiting for.
        /// </summary>
        private static void OnDialogBoxShowing(object sender, DialogBoxShowingEventArgs e)
        {
            if (!_executing) return;
            string id = e.DialogId ?? "";
            string message = e is TaskDialogShowingEventArgs t ? t.Message ?? "" : e is MessageBoxShowingEventArgs m ? m.Message ?? "" : "";
            string answer = "left for a person";
            if (IsSaveReminder(id, message))
            {
                bool closed = false;
                try { closed = e.OverrideResult((int)TaskDialogResult.Cancel); } catch (Exception) { closed = false; }
                answer = closed ? "closed with Cancel (not saved)" : "not answered: Revit refused Cancel, so it waits for a person (still not saved)";
            }
            else if (DialogRules.Unattended)
            {
                // F75: the unattended test runner's Revit answers its short safe list; anything else waits and the runner
                // records it as a finding and cancels the step
                int? result = DialogRules.Answer(id, message, out string rule);
                if (result.HasValue)
                {
                    bool done = false;
                    try { done = e.OverrideResult(result.Value); } catch (Exception) { done = false; }
                    answer = done ? "answered by rule (unattended test run): " + rule : "not answered: Revit refused the rule's answer (" + rule + ")";
                }
                else answer = "left for a person (unattended test run: no rule answers it; the runner cancels the step)";
            }
            var record = new JObject { ["at"] = DateTime.UtcNow.ToString("o"), ["dialog_id"] = id, ["message"] = Trim(message, 400), ["answer"] = answer };
            _dialogs.Add(record);
            Log(_current, "dialog", record);
        }

        /// <summary>
        /// F-032: what the command set's tools used to show in a modal TaskDialog when they failed. Every handler in the
        /// command set runs for an AI call, and a modal dialog stops the bridge until a person clicks it, so the notice is
        /// recorded with the job (fmc_job status, send_code's dialogs) and never shown. The error itself is in the tool's
        /// result.
        /// </summary>
        public static void Notice(string title, string message)
        {
            var record = new JObject
            {
                ["at"] = DateTime.UtcNow.ToString("o"), ["dialog_id"] = "add-in notice: " + (title ?? ""),
                ["message"] = Trim(message ?? "", 400), ["answer"] = "not shown (an AI call never opens a dialog; the error is in the result)",
            };
            _dialogs.Add(record);
            Log(_current, "notice", record);
            System.Diagnostics.Trace.WriteLine($"FMC notice ({title}): {message}");
        }

        /// <summary>Revit's periodic save reminder, by its id or (English Revit) its text.</summary>
        public static bool IsSaveReminder(string dialogId, string message)
        {
            string id = (dialogId ?? "").ToLowerInvariant();
            string text = (message ?? "").ToLowerInvariant();
            bool idMatch = id.Contains("save") && (id.Contains("remind") || id.Contains("recent") || id.Contains("periodic"));
            bool textMatch = text.Contains("not saved recently") || text.Contains("not been saved recently") || text.Contains("save reminder");
            return idMatch || textMatch;
        }

        /// <summary>Appends one event to %APPDATA%\Formcraft\FMC_Jobs_Revit.jsonl (what Revit itself saw), never throwing.</summary>
        public static void Log(string job, string evt, JObject detail = null)
        {
            try
            {
                // pid: which Revit wrote it, so the unattended test runner reads only its own Revit's dialogs (F75)
                var line = new JObject { ["at"] = DateTime.UtcNow.ToString("o"), ["job"] = job ?? "", ["event"] = evt, ["pid"] = Pid };
                if (detail != null) foreach (var p in detail.Properties()) if (line[p.Name] == null) line[p.Name] = p.Value;
                string dir = FormcraftDir();
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

        public static string FormcraftDir() =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft");

        private static bool SafeId(string job)
        {
            if (job.Length < 1 || job.Length > 64) return false;
            foreach (char c in job) if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) return false;
            return true;
        }

        private static string Trim(string s, int max) => s.Length <= max ? s : s.Substring(0, max) + "…";
    }
}
