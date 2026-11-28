using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>
    /// The lasting change log (F19 / F133): append-only JSONL beside the hub ledger, never inside a .rvt and never under
    /// a project's original folders (D:\Fomcraft is refused). One file per document per month, with size rotation.
    /// Everything is kept on disk; the 2,000-entry in-memory journal is only a live window.
    /// </summary>
    public static class ChangeFeedLog
    {
        public const string FolderName = "model-changes";
        public const long RotateBytes = 8L * 1024 * 1024;
        public const int MemoryCap = FeedJournal.DefaultCap;
        public static readonly string EnvDir = "FMC_CHANGE_FEED_DIR";

        /// <summary>%APPDATA%\Formcraft\ledger\model-changes, or FMC_CHANGE_FEED_DIR when set (tests).</summary>
        public static string DefaultDir(IDictionary<string, string> env = null)
        {
            string own = ReadEnv(env, EnvDir);
            if (!string.IsNullOrWhiteSpace(own)) return own.Trim();
            string app = ReadEnv(env, "APPDATA");
            if (string.IsNullOrWhiteSpace(app))
                app = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
            return Path.Combine(app, "Formcraft", "ledger", FolderName);
        }

        /// <summary>Refuses a path under D:\Fomcraft (originals are read-only) or a path that looks like a model file.</summary>
        public static string RefuseDir(string dir)
        {
            if (string.IsNullOrWhiteSpace(dir)) return "The change log folder is empty.";
            string full;
            try { full = Path.GetFullPath(dir.Trim()); }
            catch (Exception ex) { return ex.Message; }
            string n = full.Replace('/', '\\').TrimEnd('\\');
            if (Regex.IsMatch(n, @"^D:\\Fomcraft($|\\)", RegexOptions.IgnoreCase))
                return "Refusing to write the change log under D:\\Fomcraft (project originals are read-only).";
            if (Regex.IsMatch(n, @"\.(rvt|rfa|rte|rft)$", RegexOptions.IgnoreCase))
                return "Refusing to write the change log inside a model file.";
            return "";
        }

        /// <summary>A file-name-safe key from a document path or title (the file name without .rvt, at most 80 characters).</summary>
        public static string SafeKey(string document)
        {
            string s = FeedJournal.BaseName(document ?? "");
            if (s.Length == 0) s = "untitled";
            var b = new StringBuilder(s.Length);
            foreach (char c in s)
                b.Append("<>:\"/\\|?*".IndexOf(c) >= 0 || c < 32 ? '_' : c);
            s = b.ToString().Trim(' ', '.');
            if (s.Length == 0) s = "untitled";
            return s.Length > 80 ? s.Substring(0, 80) : s;
        }

        /// <summary>docKey-2026-11.jsonl, or docKey-2026-11-part2.jsonl when the month's file is past the size cap.</summary>
        public static string FileName(string document, DateTime atUtc, int part = 1)
        {
            string month = atUtc.ToUniversalTime().ToString("yyyy-MM", CultureInfo.InvariantCulture);
            string key = SafeKey(document);
            return part <= 1 ? key + "-" + month + ".jsonl" : key + "-" + month + "-part" + part + ".jsonl";
        }

        public static string PathFor(string dir, string document, DateTime atUtc, int part = 1)
        {
            return Path.Combine(dir, FileName(document, atUtc, part));
        }

        /// <summary>Picks the current part for append: the last existing part under the size cap, or the next part.</summary>
        public static string PathToAppend(string dir, string document, DateTime atUtc, long rotateBytes = RotateBytes)
        {
            int part = 1;
            string path = PathFor(dir, document, atUtc, part);
            while (File.Exists(path))
            {
                long len = 0;
                try { len = new FileInfo(path).Length; } catch { len = 0; }
                if (len < rotateBytes) return path;
                part++;
                path = PathFor(dir, document, atUtc, part);
            }
            return path;
        }

        /// <summary>A time labeled with its zone, e.g. "2026-11-28 11:28:33 EAT (UTC+3)" (Tool Research P-02).</summary>
        public static string LabelTime(DateTime utc, TimeZoneInfo zone = null)
        {
            zone = zone ?? TimeZoneInfo.Local;
            DateTime u = utc.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(utc, DateTimeKind.Utc) : utc.ToUniversalTime();
            DateTime local = TimeZoneInfo.ConvertTimeFromUtc(u, zone);
            TimeSpan off = zone.GetUtcOffset(local);
            string sign = off < TimeSpan.Zero ? "-" : "+";
            TimeSpan abs = off.Duration();
            string utcOff = abs.Minutes == 0 ? "UTC" + sign + ((int)abs.TotalHours).ToString(CultureInfo.InvariantCulture)
                : "UTC" + sign + abs.Hours.ToString("00", CultureInfo.InvariantCulture) + ":" + abs.Minutes.ToString("00", CultureInfo.InvariantCulture);
            return local.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + ZoneAbbr(zone, local) + " (" + utcOff + ")";
        }

        /// <summary>A short zone name (EAT, GMT, PST…) when we know one; otherwise the zone's id, still with the offset in LabelTime.</summary>
        public static string ZoneAbbr(TimeZoneInfo zone, DateTime local)
        {
            if (zone == null) return "UTC";
            string id = zone.Id ?? "";
            bool dst = zone.IsDaylightSavingTime(local);
            if (id == "E. Africa Standard Time" || id.IndexOf("E. Africa", StringComparison.OrdinalIgnoreCase) >= 0) return "EAT";
            if (id == "UTC" || id == "Coordinated Universal Time" || id == "Greenwich Standard Time") return "UTC";
            if (id == "GMT Standard Time") return dst ? "BST" : "GMT";
            if (id == "Eastern Standard Time") return dst ? "EDT" : "EST";
            if (id == "Pacific Standard Time") return dst ? "PDT" : "PST";
            if (id == "Central Standard Time") return dst ? "CDT" : "CST";
            if (id == "Mountain Standard Time") return dst ? "MDT" : "MST";
            if (id == "South Africa Standard Time") return "SAST";
            if (id == "Israel Standard Time") return dst ? "IDT" : "IST";
            if (id == "Arabian Standard Time") return "GST";
            string name = (dst ? zone.DaylightName : zone.StandardName) ?? "";
            if (name.Length > 0 && name.Length <= 5 && name.IndexOf(' ') < 0) return name;
            return id.Length > 0 && id.Length <= 12 ? id : "local";
        }

        public static JObject EntryJson(FeedEntry e, TimeZoneInfo zone = null)
        {
            JObject o = e.ToJson();
            DateTime at;
            if (!DateTime.TryParse(e.AtUtc == default ? (string)o["at"] : e.AtUtc.ToUniversalTime().ToString("o"),
                    CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out at))
                at = e.AtUtc == default ? DateTime.UtcNow : e.AtUtc.ToUniversalTime();
            o["at_local"] = LabelTime(at, zone);
            o["tz"] = ZoneAbbr(zone ?? TimeZoneInfo.Local, TimeZoneInfo.ConvertTimeFromUtc(at.Kind == DateTimeKind.Utc ? at : at.ToUniversalTime(), zone ?? TimeZoneInfo.Local));
            return o;
        }

        /// <summary>Appends one entry. Never throws (logging must never break Revit). Returns the path, or "" when refused.</summary>
        public static string Append(string dir, FeedEntry entry, TimeZoneInfo zone = null)
        {
            try
            {
                string why = RefuseDir(dir);
                if (why.Length > 0) return "";
                Directory.CreateDirectory(dir);
                if (entry.Seq <= 0) entry.Seq = NextSeq(dir);
                string path = PathToAppend(dir, entry.Document, entry.AtUtc == default ? DateTime.UtcNow : entry.AtUtc);
                string line = EntryJson(entry, zone).ToString(Formatting.None) + "\n";
                using (var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                using (var sw = new StreamWriter(fs, new UTF8Encoding(false)))
                    sw.Write(line);
                return path;
            }
            catch
            {
                return "";
            }
        }

        public static long NextSeq(string dir)
        {
            string file = Path.Combine(dir, "_seq.json");
            long n = 0;
            try
            {
                if (File.Exists(file))
                {
                    var o = JObject.Parse(File.ReadAllText(file));
                    n = o["seq"] != null ? (long)o["seq"] : 0;
                }
            }
            catch { n = 0; }
            n++;
            try
            {
                Directory.CreateDirectory(dir);
                string tmp = file + ".tmp";
                File.WriteAllText(tmp, "{\"seq\":" + n.ToString(CultureInfo.InvariantCulture) + "}");
                if (File.Exists(file)) File.Delete(file);
                File.Move(tmp, file);
            }
            catch { /* the next line just uses n */ }
            return n;
        }

        /// <summary>Writes a session marker so the add-in command can say the feed is listening from plugin startup.</summary>
        public static void MarkListening(string dir, DateTime atUtc)
        {
            try
            {
                if (RefuseDir(dir).Length > 0) return;
                Directory.CreateDirectory(dir);
                var o = new JObject
                {
                    ["at"] = atUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                    ["at_local"] = LabelTime(atUtc.ToUniversalTime()),
                    ["listening"] = true,
                };
                File.WriteAllText(Path.Combine(dir, "_listening.json"), o.ToString(Formatting.None));
            }
            catch { /* the command then says listening from the files it finds */ }
        }

        public static bool IsListening(string dir)
        {
            try { return File.Exists(Path.Combine(dir, "_listening.json")); }
            catch { return false; }
        }

        public static DateTime? ListeningSince(string dir)
        {
            try
            {
                var o = JObject.Parse(File.ReadAllText(Path.Combine(dir, "_listening.json")));
                if (DateTime.TryParse((string)o["at"], CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out DateTime at))
                    return at;
            }
            catch { }
            return null;
        }

        /// <summary>Entries for one document (empty: every document) after afterSeq, oldest first, at most limit.</summary>
        public static FeedPage Query(string dir, string document, long afterSeq, int limit)
        {
            var page = new FeedPage();
            if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir)) return page;
            int take = Math.Max(1, Math.Min(FeedJournal.MaxPage, limit));
            var files = new List<string>();
            try
            {
                string prefix = string.IsNullOrWhiteSpace(document) ? "" : SafeKey(document) + "-";
                foreach (string f in Directory.GetFiles(dir, "*.jsonl"))
                {
                    string name = Path.GetFileName(f);
                    if (prefix.Length > 0 && !name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                    files.Add(f);
                }
            }
            catch { return page; }
            files.Sort(StringComparer.OrdinalIgnoreCase);
            long last = 0;
            foreach (string f in files)
            {
                string text;
                try
                {
                    using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var sr = new StreamReader(fs, Encoding.UTF8))
                        text = sr.ReadToEnd();
                }
                catch { continue; }
                foreach (string raw in text.Split('\n'))
                {
                    string line = raw.Trim();
                    if (line.Length == 0) continue;
                    FeedEntry e;
                    try { e = FeedEntry.FromJson(JObject.Parse(line)); }
                    catch { continue; }
                    if (e == null) continue;
                    if (e.Seq > last) last = e.Seq;
                    if (e.Seq <= afterSeq) continue;
                    if (!FeedJournal.SameDocument(e.Document, document) && prefixNeeded(document, e.Document)) continue;
                    if (page.Entries.Count == take) { page.More = true; /* keep scanning for last_seq */ continue; }
                    if (!page.More) page.Entries.Add(e);
                }
            }
            page.LastSeq = last;
            page.NextAfterSeq = page.Entries.Count > 0 ? page.Entries[page.Entries.Count - 1].Seq : Math.Max(afterSeq, 0);
            return page;
        }

        private static bool prefixNeeded(string wanted, string key)
        {
            if (string.IsNullOrWhiteSpace(wanted)) return false;
            return !FeedJournal.SameDocument(key, wanted);
        }

        /// <summary>All entries in a time window, newest first, capped. For the pane.</summary>
        public static List<FeedEntry> ReadWindow(string dir, string document, DateTime? sinceUtc, DateTime? untilUtc, int cap)
        {
            var all = new List<FeedEntry>();
            var page = Query(dir, document, 0, FeedJournal.MaxPage);
            // Query pages at 1000; keep walking
            all.AddRange(page.Entries);
            while (page.More && all.Count < 20000)
            {
                page = Query(dir, document, page.NextAfterSeq, FeedJournal.MaxPage);
                if (page.Entries.Count == 0) break;
                all.AddRange(page.Entries);
            }
            var kept = new List<FeedEntry>();
            foreach (var e in all)
            {
                DateTime at = e.AtUtc.Kind == DateTimeKind.Utc ? e.AtUtc : e.AtUtc.ToUniversalTime();
                if (sinceUtc != null && at < sinceUtc.Value) continue;
                if (untilUtc != null && at > untilUtc.Value) continue;
                kept.Add(e);
            }
            kept.Sort((a, b) => b.AtUtc.CompareTo(a.AtUtc) != 0 ? b.AtUtc.CompareTo(a.AtUtc) : b.Seq.CompareTo(a.Seq));
            if (kept.Count > cap) kept.RemoveRange(cap, kept.Count - cap);
            return kept;
        }

        /// <summary>The first day of the oldest month still kept (current month counts as one of the N months). Retention 0 or less means do not prune.</summary>
        public static DateTime OldestKeptMonth(DateTime utcNow, int keepMonths)
        {
            if (keepMonths <= 0) return DateTime.MinValue;
            DateTime u = utcNow.Kind == DateTimeKind.Utc ? utcNow : utcNow.ToUniversalTime();
            var first = new DateTime(u.Year, u.Month, 1, 0, 0, 0, DateTimeKind.Utc);
            return first.AddMonths(-(keepMonths - 1));
        }

        /// <summary>YYYY-MM from a monthly log file name (doc-YYYY-MM.jsonl or doc-YYYY-MM-partN.jsonl), or null.</summary>
        public static DateTime? MonthOfFileName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return null;
            var m = Regex.Match(Path.GetFileName(name), @"-(\d{4})-(\d{2})(?:-part\d+)?\.jsonl$", RegexOptions.IgnoreCase);
            if (!m.Success) return null;
            int y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            int mo = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            if (mo < 1 || mo > 12) return null;
            return new DateTime(y, mo, 1, 0, 0, 0, DateTimeKind.Utc);
        }

        /// <summary>
        /// Deletes monthly JSONL files in this log directory that are older than the retention window. Never deletes
        /// a file outside the directory, a file whose name is not a monthly log, or anything when the directory is
        /// refused (D:\Fomcraft, a model file). Returns how many files were removed. Call only from the startup or
        /// logging path — never from fmc_change_feed_read or Query/ReadWindow.
        /// </summary>
        public static int PruneOlder(string dir, DateTime utcNow, int keepMonths)
        {
            if (keepMonths <= 0) return 0;
            if (RefuseDir(dir).Length > 0) return 0;
            string root;
            try { root = Path.GetFullPath(dir.Trim()); }
            catch { return 0; }
            if (!Directory.Exists(root)) return 0;
            DateTime oldest = OldestKeptMonth(utcNow, keepMonths);
            int removed = 0;
            string[] files;
            try { files = Directory.GetFiles(root, "*.jsonl"); }
            catch { return 0; }
            foreach (string f in files)
            {
                DateTime? month = MonthOfFileName(f);
                if (month == null || month.Value >= oldest) continue;
                if (!IsInsideLogDir(root, f)) continue;
                try
                {
                    File.Delete(f);
                    removed++;
                }
                catch { /* a locked file is left; the next prune will try again */ }
            }
            return removed;
        }

        /// <summary>True only when file resolves to a path directly under dir (no escape through .. or a junction to the outside).</summary>
        public static bool IsInsideLogDir(string dir, string file)
        {
            try
            {
                string root = Path.GetFullPath(dir.Trim());
                string full = Path.GetFullPath(file);
                string rootDir = Path.GetFullPath(Path.GetDirectoryName(full) ?? "");
                if (!string.Equals(rootDir, root, StringComparison.OrdinalIgnoreCase)) return false;
                string prefix = root.TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
                return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private static string ReadEnv(IDictionary<string, string> env, string name)
        {
            if (env != null && env.TryGetValue(name, out string v) && v != null) return v;
            try { return Environment.GetEnvironmentVariable(name) ?? ""; }
            catch { return ""; }
        }
    }
}
