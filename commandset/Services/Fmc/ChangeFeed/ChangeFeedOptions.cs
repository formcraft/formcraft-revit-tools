using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>
    /// Kill switch and retention for the lasting change log (F133). Defaults: logging on, 12 months of monthly
    /// JSONL files kept. Set from the kit (FMC_Config.json or 03_Master_Data\FMC_Change_Feed.json) and/or
    /// %APPDATA%\Formcraft\config.json — never fmc_guard.json. A broken file is ignored. Environment variables
    /// FMC_CHANGE_FEED_CONFIG, FMC_CHANGE_FEED_LOGGING and FMC_CHANGE_FEED_RETENTION_MONTHS override, for tests.
    /// </summary>
    public sealed class ChangeFeedOptions
    {
        public const string LoggingKey = "change_feed_logging";
        public const string RetentionKey = "change_feed_retention_months";
        public const int DefaultRetentionMonths = 12;
        public const string EnvConfig = "FMC_CHANGE_FEED_CONFIG";
        public const string EnvLogging = "FMC_CHANGE_FEED_LOGGING";
        public const string EnvRetention = "FMC_CHANGE_FEED_RETENTION_MONTHS";
        public const string EnvKit = "FMC_KIT";
        public const string AppConfigName = "config.json";
        public const string KitConfigName = "FMC_Config.json";
        public const string KitFeedName = "FMC_Change_Feed.json";

        public bool Logging { get; set; } = true;
        public int RetentionMonths { get; set; } = DefaultRetentionMonths;

        public static ChangeFeedOptions Defaults()
        {
            return new ChangeFeedOptions();
        }

        /// <summary>Kit files first, then %APPDATA%\Formcraft\config.json, then FMC_CHANGE_FEED_CONFIG, then env vars.</summary>
        public static ChangeFeedOptions Load(string kitFolder = null, IDictionary<string, string> env = null)
        {
            var o = Defaults();
            string kit = FirstNonEmpty(kitFolder, ReadEnv(env, EnvKit));
            if (!string.IsNullOrWhiteSpace(kit))
            {
                o.ApplyFile(Path.Combine(kit.Trim(), KitConfigName));
                o.ApplyFile(Path.Combine(kit.Trim(), "03_Master_Data", KitFeedName));
            }
            string app = AppConfigPath(env);
            if (!string.IsNullOrWhiteSpace(app)) o.ApplyFile(app);
            string named = ReadEnv(env, EnvConfig);
            if (!string.IsNullOrWhiteSpace(named)) o.ApplyFile(named);
            o.ApplyEnv(env);
            if (o.RetentionMonths < 0) o.RetentionMonths = DefaultRetentionMonths;
            return o;
        }

        public static string AppConfigPath(IDictionary<string, string> env = null)
        {
            string app = ReadEnv(env, "APPDATA");
            if (string.IsNullOrWhiteSpace(app))
            {
                try { app = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); }
                catch { app = ""; }
            }
            if (string.IsNullOrWhiteSpace(app)) return "";
            return Path.Combine(app, "Formcraft", AppConfigName);
        }

        public void ApplyFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return;
            try
            {
                string text = File.ReadAllText(path);
                if (string.IsNullOrWhiteSpace(text)) return;
                ApplyJson(JObject.Parse(text.TrimStart('\uFEFF')));
            }
            catch (Exception) { /* a broken file is ignored; the defaults (or earlier files) stand */ }
        }

        public void ApplyJson(JObject json)
        {
            if (json == null) return;
            ApplyToken(json);
            if (json["change_feed"] is JObject nested) ApplyToken(nested);
        }

        private void ApplyToken(JObject json)
        {
            JToken log = json[LoggingKey] ?? json["logging"];
            if (log != null && log.Type != JTokenType.Null)
            {
                bool? b = AsBool(log);
                if (b.HasValue) Logging = b.Value;
            }
            JToken months = json[RetentionKey] ?? json["retention_months"];
            if (months != null && months.Type != JTokenType.Null)
            {
                int? n = AsInt(months);
                if (n.HasValue) RetentionMonths = n.Value;
            }
        }

        private void ApplyEnv(IDictionary<string, string> env)
        {
            string log = ReadEnv(env, EnvLogging);
            if (log.Length > 0)
            {
                bool? b = AsBool(log);
                if (b.HasValue) Logging = b.Value;
            }
            string months = ReadEnv(env, EnvRetention);
            if (months.Length > 0)
            {
                int? n = AsInt(months);
                if (n.HasValue) RetentionMonths = n.Value;
            }
        }

        public static bool? AsBool(object v)
        {
            if (v == null) return null;
            if (v is bool bb) return bb;
            if (v is JToken tok)
            {
                if (tok.Type == JTokenType.Boolean) return tok.Value<bool>();
                if (tok.Type == JTokenType.Integer) return tok.Value<long>() != 0;
                if (tok.Type == JTokenType.String) return AsBool((string)tok);
                return null;
            }
            return AsBool(Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        public static bool? AsBool(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            s = s.Trim();
            if (s.Equals("true", StringComparison.OrdinalIgnoreCase) || s.Equals("yes", StringComparison.OrdinalIgnoreCase) || s.Equals("on", StringComparison.OrdinalIgnoreCase) || s == "1") return true;
            if (s.Equals("false", StringComparison.OrdinalIgnoreCase) || s.Equals("no", StringComparison.OrdinalIgnoreCase) || s.Equals("off", StringComparison.OrdinalIgnoreCase) || s == "0") return false;
            return null;
        }

        public static int? AsInt(object v)
        {
            if (v == null) return null;
            if (v is int i) return i;
            if (v is long l) return (int)l;
            if (v is JToken tok)
            {
                if (tok.Type == JTokenType.Integer) return tok.Value<int>();
                if (tok.Type == JTokenType.String) return AsInt((string)tok);
                return null;
            }
            return AsInt(Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        public static int? AsInt(string s)
        {
            if (int.TryParse((s ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)) return n;
            return null;
        }

        /// <summary>
        /// A-0001 (the file or title is exactly A-0001, optional _USER and .rvt) or HEBERT HOSTELS, matched on
        /// the document title or path, following the existing never-save title check (hebert hostels in title+path).
        /// A project model whose ISO name only ends in -A-0001 (for example F26901-…-M3-A-0001) is not a match.
        /// </summary>
        public static bool IsProtectedDocument(string titleOrPath, out string reason)
        {
            string blob = titleOrPath ?? "";
            if (blob.IndexOf("hebert hostels", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                reason = "Before and after parameter values are not recorded for HEBERT HOSTELS (a protected model).";
                return true;
            }
            if (IsA0001(blob))
            {
                reason = "Before and after parameter values are not recorded for A-0001 (a protected model).";
                return true;
            }
            reason = "";
            return false;
        }

        /// <summary>The file name or a path segment, after stripping .rvt/.rfa/.rte/.rft and a trailing _USER, is exactly A-0001.</summary>
        public static bool IsA0001(string titleOrPath)
        {
            foreach (string raw in PathCandidates(titleOrPath))
            {
                string s = StripSuffix(raw);
                if (s.Equals("A-0001", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static IEnumerable<string> PathCandidates(string titleOrPath)
        {
            string blob = (titleOrPath ?? "").Replace('/', '\\').Trim();
            if (blob.Length == 0) yield break;
            yield return blob;
            int slash = blob.LastIndexOf('\\');
            yield return slash >= 0 ? blob.Substring(slash + 1) : blob;
        }

        private static string StripSuffix(string raw)
        {
            string s = (raw ?? "").Trim();
            foreach (string ext in new[] { ".rvt", ".rfa", ".rte", ".rft" })
                if (s.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
                    s = s.Substring(0, s.Length - ext.Length);
            if (s.EndsWith("_USER", StringComparison.OrdinalIgnoreCase))
                s = s.Substring(0, s.Length - 5);
            return s.Trim();
        }

        public static string DisabledNote()
        {
            return "Change-feed logging is disabled (" + LoggingKey + " in the kit or %APPDATA%\\Formcraft\\config.json). No log files are being written. The in-memory journal is still available.";
        }

        private static string FirstNonEmpty(params string[] values)
        {
            foreach (string v in values)
                if (!string.IsNullOrWhiteSpace(v)) return v;
            return "";
        }

        private static string ReadEnv(IDictionary<string, string> env, string name)
        {
            if (env != null && env.TryGetValue(name, out string v) && v != null) return v.Trim();
            try { return (Environment.GetEnvironmentVariable(name) ?? "").Trim(); }
            catch { return ""; }
        }
    }
}
