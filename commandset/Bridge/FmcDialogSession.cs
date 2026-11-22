using System;
using System.IO;
using System.Text;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// <see cref="UIApplication.DialogBoxShowing"/> for the whole Revit session, not only while an AI job runs.
    /// Rules with scope <c>always</c> answer outside a job (the save and sync reminders block the API even between
    /// calls). Rules with scope <c>ai_jobs</c> answer only while <see cref="FmcAiJob.Executing"/> is true.
    /// A dialog this class does not answer is left for a person and written to <c>fmc_dialog_open.json</c> so the
    /// server can say which dialog is blocking without sending another Revit command (a modal dialog would not run it).
    /// </summary>
    public static class FmcDialogSession
    {
        public const string OpenFileName = "fmc_dialog_open.json";

        static readonly object Gate = new object();
        static bool _hooked;
        static UIApplication _app;

        /// <summary>Idempotent. Call when the command set loads, and again from the first AI job if that load did not.</summary>
        public static void Hook(UIApplication app)
        {
            if (app == null) return;
            lock (Gate)
            {
                _app = app;
                if (_hooked) return;
                try
                {
                    app.DialogBoxShowing += OnDialogBoxShowing;
                    _hooked = true;
                    DialogRuleStore.Current();
                }
                catch (Exception)
                {
                    // Without the hook, dialogs wait for a person. The server still reads the job log.
                }
            }
        }

        static void OnDialogBoxShowing(object sender, DialogBoxShowingEventArgs e)
        {
            string id = "";
            string message = "";
            try
            {
                id = e?.DialogId ?? "";
                message = e is TaskDialogShowingEventArgs task ? task.Message ?? "" :
                    e is MessageBoxShowingEventArgs box ? box.Message ?? "" : "";
                bool executing = FmcAiJob.Executing;
                DialogDecision decision = DialogRuleEngine.Decide(DialogRuleStore.Current(), id, message, ActiveDocument(), executing);
                string answer = decision.Reason ?? "left for a person";
                if (decision.Act && decision.Code.HasValue && e != null)
                {
                    bool done = false;
                    try { done = e.OverrideResult(decision.Code.Value); }
                    catch (Exception) { done = false; }
                    if (!done) answer = "not answered: Revit refused " + decision.AnswerName + " (" + decision.Code.Value + ")";
                }
                else if (!decision.Matched && !decision.NeverAuto && DialogRules.Unattended && DialogRules.Never((id ?? "").ToLowerInvariant(), (message ?? "").ToLowerInvariant()))
                    answer = "left for a person (unattended test run: no rule answers it; the runner cancels the step)";
                var record = new JObject
                {
                    ["at"] = DateTime.UtcNow.ToString("o"),
                    ["dialog_id"] = id,
                    ["message"] = Trim(message, 400),
                    ["answer"] = answer,
                    ["rule"] = decision.RuleId ?? "",
                };
                if (decision.NeverAuto) record["alert"] = true;
                FmcAiJob.RecordDialog(record);
                Publish(LeftForPerson(answer), id, Trim(message, 400), answer, decision.NeverAuto);
            }
            catch (Exception)
            {
                // A failure here must not stop Revit showing the dialog.
            }
        }

        static bool LeftForPerson(string answer)
        {
            string text = answer ?? "";
            return text.StartsWith("left for a person", StringComparison.OrdinalIgnoreCase) ||
                text.StartsWith("not answered", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Revit is idle, so no modal dialog is up. Clears a stale open flag. No write when it is already clear.</summary>
        public static void ClearIfIdle()
        {
            try
            {
                string path = Path.Combine(FmcAiJob.FormcraftDir(), OpenFileName);
                if (!File.Exists(path)) return;
                var body = JObject.Parse(File.ReadAllText(path));
                if (body.Value<bool?>("open") != true) return;
                body["open"] = false;
                body["cleared"] = "idle";
                body["at"] = DateTime.UtcNow.ToString("o");
                string tmp = path + ".tmp";
                File.WriteAllText(tmp, body.ToString(Newtonsoft.Json.Formatting.None), new UTF8Encoding(false));
                try { File.Replace(tmp, path, null); }
                catch (Exception)
                {
                    File.Delete(path);
                    File.Move(tmp, path);
                }
            }
            catch (Exception)
            {
                // The server also ignores an open flag that is not fresh.
            }
        }

        static void Publish(bool open, string id, string message, string answer, bool alert)
        {
            try
            {
                string dir = FmcAiJob.FormcraftDir();
                Directory.CreateDirectory(dir);
                string path = Path.Combine(dir, OpenFileName);
                var body = new JObject
                {
                    ["open"] = open,
                    ["dialog_id"] = id ?? "",
                    ["message"] = message ?? "",
                    ["answer"] = answer ?? "",
                    ["job"] = FmcAiJob.Current ?? "",
                    ["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id,
                    ["at"] = DateTime.UtcNow.ToString("o"),
                    ["alert"] = alert,
                    ["addin"] = "fmc_dialog_rules",
                };
                string tmp = path + ".tmp";
                File.WriteAllText(tmp, body.ToString(Newtonsoft.Json.Formatting.None), new UTF8Encoding(false));
                if (File.Exists(path))
                {
                    try { File.Replace(tmp, path, null); }
                    catch (Exception)
                    {
                        File.Delete(path);
                        File.Move(tmp, path);
                    }
                }
                else File.Move(tmp, path);
            }
            catch (Exception)
            {
                // The job log is the fallback the server already reads.
            }
        }

        static string ActiveDocument()
        {
            try
            {
                UIApplication app = _app;
                Document doc = app?.ActiveUIDocument?.Document;
                if (doc == null) return "";
                return (doc.Title ?? "") + "\n" + (doc.PathName ?? "");
            }
            catch (Exception) { return ""; }
        }

        static string Trim(string s, int max)
        {
            s = s ?? "";
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }
    }
}
