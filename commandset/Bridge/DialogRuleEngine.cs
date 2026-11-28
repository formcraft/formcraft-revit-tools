using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// Which Revit dialog an unattended session may answer. Rules live in
    /// <c>%APPDATA%\Formcraft\fmc_dialog_rules.json</c> (or <c>FMC_DIALOG_RULES</c>). This type does not read or
    /// write the guard file. <see cref="NeverAuto"/> is fixed in code: a JSON rule cannot answer those dialogs,
    /// and it cannot pick a save or sync button on the two reminders the defaults dismiss.
    /// </summary>
    public static class DialogRuleEngine
    {
        /// <summary>The periodic save reminder. Command link 3 is "Do not save the project" (1003). 1001 and 1002 save.</summary>
        public const string SaveReminderId = "TaskDialog_Project_Not_Saved_Recently";

        /// <summary>
        /// The periodic sync reminder, not the close dialog. Command link 3 is "Do not synchronize" (1003).
        /// Close (8) and Cancel (2) also leave the model unsynchronised. 1001 and 1002 synchronize.
        /// </summary>
        public const string SyncReminderId = "TaskDialog_Changes_Not_Synchronized_With_Central";

        /// <summary>
        /// Dialog ids that stay for a person. Matched as case-insensitive substrings of the dialog id.
        /// The two reminders are exempt by exact id: they are dismissed with the button that does not save or sync.
        /// </summary>
        public static readonly string[] NeverAutoFragments =
        {
            "save_file", "revitsaveoptions", "saveoptions", "partitionssavetocentral",
            "worksets_errors", "changes_not_saved", "fatal_error", "serious_error",
            "relinquish", "upgrade", "recover", "corrupt",
            "save as", "save-as", "saveas", "synchron", "sync", "save",
        };

        static readonly string[] ExemptIds =
        {
            SaveReminderId.ToLowerInvariant(),
            SyncReminderId.ToLowerInvariant(),
        };

        public static bool NeverAuto(string dialogId)
        {
            string id = Norm(dialogId);
            if (id.Length == 0) return false;
            for (int i = 0; i < ExemptIds.Length; i++) if (id == ExemptIds[i]) return false;
            for (int i = 0; i < NeverAutoFragments.Length; i++)
                if (id.Contains(NeverAutoFragments[i])) return true;
            return false;
        }

        public static string NeverAutoReason(string dialogId)
        {
            if (!NeverAuto(dialogId)) return "";
            return "never auto: a save, sync, relinquish, upgrade, recover, fatal or serious-error dialog stays for a person";
        }

        /// <summary>
        /// True when this button would save or synchronize one of the two reminders. Log-only (null) is safe.
        /// Cancel (2), Close (8) and CommandLink3 (1003) are the buttons that do not save or sync.
        /// </summary>
        public static bool UnsafeReminderAnswer(string dialogId, int? code)
        {
            if (!code.HasValue) return false;
            string id = Norm(dialogId);
            int n = code.Value;
            if (id == ExemptIds[0] || id == ExemptIds[1])
                return n != 1003 && n != 2 && n != 8;
            return false;
        }

        /// <summary>A named OverrideResult, a positive integer, or null for log-only. Unknown text returns false.</summary>
        public static bool TryAnswer(string answer, out int? code, out string name)
        {
            code = null;
            name = "";
            string text = (answer ?? "").Trim();
            if (text.Length == 0) return false;
            string key = text.ToLowerInvariant().Replace(" ", "").Replace("_", "");
            if (key == "log" || key == "pass" || key == "none") { name = "log"; return true; }
            if (int.TryParse(text, out int n))
            {
                if (n <= 0 || n > 2000) return false;
                code = n;
                name = AnswerName(n);
                return true;
            }
            switch (key)
            {
                case "ok": code = 1; name = "Ok"; return true;
                case "cancel": code = 2; name = "Cancel"; return true;
                case "close": code = 8; name = "Close"; return true;
                case "no": code = 7; name = "No"; return true;
                case "commandlink1": code = 1001; name = "CommandLink1"; return true;
                case "commandlink2": code = 1002; name = "CommandLink2"; return true;
                case "commandlink3": code = 1003; name = "CommandLink3"; return true;
                case "commandlink4": code = 1004; name = "CommandLink4"; return true;
                default: return false;
            }
        }

        public static string AnswerName(int code)
        {
            switch (code)
            {
                case 1: return "Ok";
                case 2: return "Cancel";
                case 7: return "No";
                case 8: return "Close";
                case 1001: return "CommandLink1";
                case 1002: return "CommandLink2";
                case 1003: return "CommandLink3";
                case 1004: return "CommandLink4";
                default: return code.ToString();
            }
        }

        public static DialogRule[] DefaultRules()
        {
            return new[]
            {
                Rule("accessing-file", "Dialog_Revit_AccessingFile", "", "", "log", "always",
                    "Informational file access. Logged only; no button is pressed."),
                Rule("save-reminder", SaveReminderId, "", "", "CommandLink3", "always",
                    "Do not save the project (CommandLink3, 1003). 1001 saves. 1002 saves and opens the reminder interval. Cancel (2) and Close (8) also do not save."),
                Rule("sync-reminder", SyncReminderId, "", "", "CommandLink3", "always",
                    "Do not synchronize (CommandLink3, 1003). 1001 and 1002 synchronize with central. Close (8) and Cancel (2) also do not synchronize. This is the periodic reminder, not Changes_Not_Saved on close."),
                Rule("doc-warn", "Dialog_Revit_DocWarnDialog", "", "", "Ok", "ai_jobs",
                    "OK dismisses the warning during an AI job. Close is the alternative on a Close-only box."),
                Rule("paste-similar", "Dialog_Revit_PasteSimilarSymbolsPaste", "", "", "Ok", "ai_jobs",
                    "OK keeps the destination's types. Nothing is deleted."),
                Rule("extended-error", "Dialog_Revit_ExtendedErrorDialog", "", "", "Cancel", "ai_jobs",
                    "Cancel during an AI job. The error is not accepted."),
                Rule("select-element", "Dialog_Revit_SelectElement", "", "", "Cancel", "ai_jobs",
                    "Cancel during an AI job. No element is picked for the tool."),
            };
        }

        public static string DefaultJson()
        {
            var rules = new JArray();
            foreach (DialogRule rule in DefaultRules()) rules.Add(rule.ToJson());
            return new JObject { ["version"] = 1, ["rules"] = rules }.ToString(Formatting.Indented);
        }

        /// <summary>Parses a rules file. Invalid JSON returns false and leaves <paramref name="rules"/> empty.</summary>
        public static bool TryParse(string json, out DialogRule[] rules, out string error, out string[] ignored)
        {
            rules = Array.Empty<DialogRule>();
            ignored = Array.Empty<string>();
            error = "";
            if (string.IsNullOrWhiteSpace(json)) { error = "empty rules file"; return false; }
            JObject root;
            try { root = JObject.Parse(json); }
            catch (Exception ex) { error = ex.Message; return false; }
            if (!(root["rules"] is JArray array)) { error = "rules must be an array"; return false; }
            var list = new List<DialogRule>();
            var skip = new List<string>();
            foreach (JToken token in array)
            {
                if (!(token is JObject item)) continue;
                DialogRule rule = DialogRule.FromJson(item, out string why);
                if (rule == null)
                {
                    if (why.Length > 0) skip.Add(why);
                    continue;
                }
                if (NeverAuto(rule.DialogId) || UnsafeReminderAnswer(rule.DialogId, AnswerOrNull(rule.Answer)))
                {
                    skip.Add(rule.DialogId + ": " + (NeverAuto(rule.DialogId) ? NeverAutoReason(rule.DialogId) : "that button saves or synchronises"));
                    continue;
                }
                list.Add(rule);
            }
            rules = list.ToArray();
            ignored = skip.ToArray();
            return true;
        }

        public static DialogDecision Decide(DialogRule[] rules, string dialogId, string message, string document, bool executing)
        {
            var decision = new DialogDecision();
            if (NeverAuto(dialogId))
            {
                decision.NeverAuto = true;
                decision.Reason = "left for a person (" + NeverAutoReason(dialogId) + ")";
                return decision;
            }
            if (rules == null) return decision;
            for (int i = 0; i < rules.Length; i++)
            {
                DialogRule rule = rules[i];
                if (rule == null || !rule.Enabled) continue;
                if (!IdEquals(rule.DialogId, dialogId)) continue;
                if (!RegexOk(rule.Message, message ?? "")) continue;
                if (!RegexOk(rule.Document, document ?? "")) continue;
                if (!TryAnswer(rule.Answer, out int? code, out string name)) continue;
                if (UnsafeReminderAnswer(dialogId, code)) continue;
                string scope = (rule.Scope ?? "").Trim().ToLowerInvariant();
                if (scope != "always" && scope != "ai_jobs") continue;
                if (scope == "ai_jobs" && !executing) continue;
                decision.Matched = true;
                decision.RuleId = rule.Id ?? "";
                decision.AnswerName = name;
                decision.Code = code;
                decision.Note = rule.Note ?? "";
                if (!code.HasValue)
                {
                    decision.Reason = "logged only: " + decision.RuleId;
                    return decision;
                }
                decision.Act = true;
                decision.Reason = "answered: " + decision.RuleId + " " + name + " (" + code.Value + ")" +
                    (decision.Note.Length == 0 ? "" : " — " + Trim(decision.Note, 160));
                return decision;
            }
            decision.Reason = "left for a person";
            return decision;
        }

        static int? AnswerOrNull(string answer)
        {
            if (!TryAnswer(answer, out int? code, out _)) return null;
            return code;
        }

        static bool IdEquals(string ruleId, string shown)
        {
            return Norm(ruleId).Length > 0 && Norm(ruleId) == Norm(shown);
        }

        static bool RegexOk(string pattern, string text)
        {
            string p = (pattern ?? "").Trim();
            if (p.Length == 0) return true;
            try
            {
                return Regex.IsMatch(text ?? "", p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
            }
            catch (ArgumentException) { return false; }
            catch (RegexMatchTimeoutException) { return false; }
        }

        static string Norm(string id) => (id ?? "").Trim().ToLowerInvariant();

        static string Trim(string s, int max) => s.Length <= max ? s : s.Substring(0, max);

        static DialogRule Rule(string id, string dialogId, string message, string document, string answer, string scope, string note)
        {
            return new DialogRule
            {
                Id = id, Enabled = true, DialogId = dialogId, Message = message, Document = document,
                Answer = answer, Scope = scope, Note = note,
            };
        }
    }

    public sealed class DialogRule
    {
        public string Id { get; set; }
        public bool Enabled { get; set; }
        public string DialogId { get; set; }
        public string Message { get; set; }
        public string Document { get; set; }
        public string Answer { get; set; }
        public string Scope { get; set; }
        public string Note { get; set; }

        public JObject ToJson()
        {
            return new JObject
            {
                ["id"] = Id ?? "",
                ["enabled"] = Enabled,
                ["dialog_id"] = DialogId ?? "",
                ["message"] = Message ?? "",
                ["document"] = Document ?? "",
                ["answer"] = Answer ?? "",
                ["scope"] = Scope ?? "ai_jobs",
                ["note"] = Note ?? "",
            };
        }

        public static DialogRule FromJson(JObject item, out string error)
        {
            error = "";
            string dialogId = item.Value<string>("dialog_id") ?? "";
            string answer = item.Value<string>("answer") ?? "";
            string scope = (item.Value<string>("scope") ?? "ai_jobs").Trim().ToLowerInvariant();
            if (dialogId.Trim().Length == 0) { error = "a rule needs dialog_id"; return null; }
            if (!DialogRuleEngine.TryAnswer(answer, out _, out _)) { error = dialogId + ": unknown answer"; return null; }
            if (scope != "always" && scope != "ai_jobs") { error = dialogId + ": scope must be ai_jobs or always"; return null; }
            string message = item.Value<string>("message") ?? "";
            string document = item.Value<string>("document") ?? "";
            if (!PatternOk(message) || !PatternOk(document)) { error = dialogId + ": message or document regex is invalid"; return null; }
            return new DialogRule
            {
                Id = item.Value<string>("id") ?? "",
                Enabled = item.Value<bool?>("enabled") ?? true,
                DialogId = dialogId.Trim(),
                Message = message,
                Document = document,
                Answer = answer.Trim(),
                Scope = scope,
                Note = item.Value<string>("note") ?? "",
            };
        }

        static bool PatternOk(string pattern)
        {
            string p = (pattern ?? "").Trim();
            if (p.Length == 0) return true;
            try
            {
                _ = new Regex(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
                return true;
            }
            catch (ArgumentException) { return false; }
        }
    }

    public sealed class DialogDecision
    {
        public bool Matched { get; set; }
        public bool NeverAuto { get; set; }
        public bool Act { get; set; }
        public int? Code { get; set; }
        public string AnswerName { get; set; } = "";
        public string RuleId { get; set; } = "";
        public string Note { get; set; } = "";
        public string Reason { get; set; } = "left for a person";
    }

    /// <summary>
    /// Loads <c>fmc_dialog_rules.json</c>, writes the default the first time the file is missing, and reloads when the
    /// file's write time changes. Does not read the guard file.
    /// </summary>
    public static class DialogRuleStore
    {
        static readonly object Gate = new object();
        static DialogRule[] _rules = DialogRuleEngine.DefaultRules();
        static string _error = "";
        static string[] _ignored = Array.Empty<string>();
        static DateTime _stamp = DateTime.MinValue;
        static string _watched = "";
        static FileSystemWatcher _watch;

        public static string LastError { get { lock (Gate) return _error; } }
        public static string[] Ignored { get { lock (Gate) return _ignored; } }

        public static string ResolvePath()
        {
            string env = "";
            try { env = Environment.GetEnvironmentVariable("FMC_DIALOG_RULES") ?? ""; }
            catch (Exception) { env = ""; }
            if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "fmc_dialog_rules.json");
        }

        /// <summary>The rules to apply now. A missing file is created from the defaults. A bad file keeps the last good set.</summary>
        public static DialogRule[] Current()
        {
            string path = ResolvePath();
            lock (Gate)
            {
                Watch(path);
                try
                {
                    if (!File.Exists(path))
                    {
                        WriteDefault(path);
                        _rules = DialogRuleEngine.DefaultRules();
                        _ignored = Array.Empty<string>();
                        _error = "";
                        _stamp = File.Exists(path) ? File.GetLastWriteTimeUtc(path) : DateTime.MinValue;
                        return _rules;
                    }
                    DateTime stamp = File.GetLastWriteTimeUtc(path);
                    if (stamp == _stamp && _rules != null) return _rules;
                    if (!DialogRuleEngine.TryParse(File.ReadAllText(path), out DialogRule[] parsed, out string error, out string[] ignored))
                    {
                        _error = error;
                        return _rules ?? DialogRuleEngine.DefaultRules();
                    }
                    _rules = parsed;
                    _ignored = ignored;
                    _error = ignored.Length == 0 ? "" : string.Join("; ", ignored);
                    _stamp = stamp;
                }
                catch (Exception ex)
                {
                    _error = ex.Message;
                }
                return _rules ?? DialogRuleEngine.DefaultRules();
            }
        }

        /// <summary>Drops the cached stamp so the next <see cref="Current"/> reads the file. Tests and the file watcher use it.</summary>
        public static void Invalidate()
        {
            lock (Gate) _stamp = DateTime.MinValue;
        }

        static void WriteDefault(string path)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, DialogRuleEngine.DefaultJson(), new UTF8Encoding(false));
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        static void Watch(string path)
        {
            if (string.Equals(_watched, path, StringComparison.OrdinalIgnoreCase)) return;
            _watched = path;
            try { _watch?.Dispose(); } catch (Exception) { /* a replaced watcher */ }
            _watch = null;
            try
            {
                string dir = Path.GetDirectoryName(path);
                string name = Path.GetFileName(path);
                if (string.IsNullOrEmpty(dir) || string.IsNullOrEmpty(name)) return;
                Directory.CreateDirectory(dir);
                var watch = new FileSystemWatcher(dir, name)
                {
                    NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                    EnableRaisingEvents = true,
                };
                FileSystemEventHandler changed = (s, e) => Invalidate();
                watch.Changed += changed;
                watch.Created += changed;
                watch.Renamed += (s, e) => Invalidate();
                _watch = watch;
            }
            catch (Exception)
            {
                // The write-time check in Current still reloads.
            }
        }
    }
}
