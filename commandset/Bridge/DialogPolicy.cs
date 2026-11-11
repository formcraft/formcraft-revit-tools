using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// Which dialogs and failure warnings an AI job may answer by itself (tier 1).
    /// The list is <c>dialogs.allow</c> and <c>dialogs.deny</c> in fmc_guard.json. When <c>allow</c> is absent, a short
    /// built-in list is used. <see cref="HardDeny"/> always wins, including over <c>allow</c>.
    /// A match only picks a known safe answer: Cancel on the save reminder, OK on duplicate types, and deleting a
    /// duplicate-mark warning. Anything else on the allow list is left for a person.
    /// </summary>
    public static class DialogPolicy
    {
        /// <summary>Never answered, even when a guard allow entry contains the words.</summary>
        public static readonly string[] HardDeny =
        {
            "delete", "unjoin", "overwrite", "relinquish",
            "save as", "save-as", "saveas",
            "upgrade", "license", "sign-in", "sign in", "signin",
            "corrupt",
        };

        /// <summary>Used when fmc_guard.json has no dialogs.allow. Kept short on purpose.</summary>
        public static readonly string[] DefaultAllow =
        {
            "not saved recently",
            "duplicate types",
            "following types already exist",
            "dialog_revit_pastesimilarsymbolspaste",
            "duplicate mark",
        };

        const int Ok = 1;
        const int Cancel = 2;

        static long _at;
        static string[] _allow = DefaultAllow;
        static string[] _deny = Array.Empty<string>();

        /// <summary>True when the dialog or warning must stay for a person.</summary>
        public static bool Blocked(string id, string text)
        {
            Refresh();
            string blob = Blob(id, text);
            if (Hits(blob, HardDeny)) return true;
            return Hits(blob, _deny);
        }

        /// <summary>True when the guard allow list (or the built-in default) names this dialog or warning, and nothing denies it.</summary>
        public static bool Allowed(string id, string text)
        {
            if (Blocked(id, text)) return false;
            Refresh();
            return Hits(Blob(id, text), _allow);
        }

        /// <summary>
        /// The button for an allowlisted dialog, or null when it is denied, not listed, or listed without a known safe button.
        /// Cancel (2) is the save reminder. OK (1) keeps the destination's types.
        /// </summary>
        public static int? DialogResult(string id, string message, out string rule)
        {
            rule = "";
            if (!Allowed(id, message)) return null;
            string blob = Blob(id, message);
            if (blob.Contains("not saved recently") || (blob.Contains("save") && (blob.Contains("remind") || blob.Contains("recent") || blob.Contains("periodic"))))
            {
                rule = "save reminder: Cancel, the model is not saved";
                return Cancel;
            }
            if (blob.Contains("dialog_revit_pastesimilarsymbolspaste") || blob.Contains("duplicate types") ||
                (blob.Contains("following types already exist") && blob.Contains("destination")))
            {
                rule = "duplicate types: OK, the destination's types are used";
                return Ok;
            }
            return null;
        }

        /// <summary>A warning may be deleted only when it is allowlisted and not denied. Errors are never resolved here.</summary>
        public static bool AllowWarning(string text) => Allowed("", text);

        static void Refresh()
        {
            long now = DateTime.UtcNow.Ticks;
            if (_at != 0 && now - _at < TimeSpan.TicksPerSecond) return;
            _at = now;
            _allow = DefaultAllow;
            _deny = Array.Empty<string>();
            try
            {
                string path = Environment.GetEnvironmentVariable("FMC_GUARD_CONFIG");
                if (string.IsNullOrWhiteSpace(path))
                    path = Path.Combine(FmcAiJob.FormcraftDir(), "fmc_guard.json");
                if (!File.Exists(path)) return;
                var root = JObject.Parse(File.ReadAllText(path));
                if (!(root["dialogs"] is JObject dialogs)) return;
                if (dialogs["allow"] is JArray allow) _allow = Strings(allow);
                if (dialogs["deny"] is JArray deny) _deny = Strings(deny);
            }
            catch (Exception)
            {
                _allow = DefaultAllow;
                _deny = Array.Empty<string>();
            }
        }

        static string[] Strings(JArray array)
        {
            var list = new List<string>();
            foreach (JToken token in array)
            {
                string text = token?.ToString()?.Trim() ?? "";
                if (text.Length > 0) list.Add(text);
            }
            return list.ToArray();
        }

        static string Blob(string id, string text) => ((id ?? "") + " " + (text ?? "")).ToLowerInvariant();

        static bool Hits(string blob, string[] list)
        {
            if (list == null) return false;
            foreach (string item in list)
            {
                string token = (item ?? "").Trim().ToLowerInvariant();
                if (token.Length > 0 && blob.Contains(token)) return true;
            }
            return false;
        }
    }
}
