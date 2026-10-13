using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace Formcraft.Shell.Services
{
    /// <summary>One row of the Log file window (board core/UI_Log): Time, From, Tool, Document, Kind, Result.</summary>
    public sealed class LogEntry
    {
        public LogEntry(DateTime time, string from, string tool, string document, string kind, string result, string detail)
        {
            Time = time;
            From = from;
            Tool = tool;
            Document = document;
            Kind = kind;
            Result = result;
            Detail = detail;
        }

        public DateTime Time { get; }
        public string TimeText => Time == default ? "" : Time.ToString("HH:mm", CultureInfo.InvariantCulture);
        /// <summary>Pane, Claude, Ask or Script; "—" when the row doesn't say (older logs).</summary>
        public string From { get; }
        public string Tool { get; }
        public string Document { get; }
        /// <summary>Dry run, Run, Check, Read or Refused.</summary>
        public string Kind { get; }
        public string Result { get; }
        public string Detail { get; }
        public bool Refused => Kind == "Refused";

        /// <summary>One line to paste into a support message: tools and results only, never model content.</summary>
        public string SupportLine => string.Join(" | ", Time.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture), From, Tool, Document, Kind, Result);
    }

    /// <summary>
    /// Reads FMC_MCP_FileLog.csv, the log the fmc_file and fmc_family tools write (server/src/tools/fmc_file.ts:
    /// timestamp, action, dry_run, target, result, detail; quoting as policy.ts csvLine()). An optional "source" column
    /// (Pane, Claude, Ask, Script) fills From; without it From shows "—". Read-only and shared, so the tools keep appending.
    /// The log records tools and results for support and audit; it is never used to rank people (Manual 14.5).
    /// </summary>
    public interface ILogReader
    {
        string Path { get; }
        IReadOnlyList<LogEntry> Read();
    }

    public sealed class CsvLogReader : ILogReader
    {
        public CsvLogReader(string path) => Path = path;

        public string Path { get; }

        /// <summary>The default log: FMC_MCP_FileLog.csv in the reports folder (fmc_guard reports_dir, %USERPROFILE%\FMC_Reports).</summary>
        public static string DefaultPath =>
            System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "FMC_Reports", "FMC_MCP_FileLog.csv");

        /// <summary>All rows, newest first. A missing file is an empty log.</summary>
        public IReadOnlyList<LogEntry> Read()
        {
            if (!File.Exists(Path)) return new LogEntry[0];
            string text;
            using (var fs = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var sr = new StreamReader(fs, Encoding.UTF8))
                text = sr.ReadToEnd();

            var records = Parse(text).ToList();
            if (records.Count == 0) return new LogEntry[0];
            var header = records[0].Select(h => h.Trim().ToLowerInvariant()).ToList();
            int Col(string name) => header.IndexOf(name);
            int time = Col("timestamp"), action = Col("action"), dry = Col("dry_run"), target = Col("target"), result = Col("result"), detail = Col("detail"), source = Col("source");
            string Get(List<string> r, int i) => i >= 0 && i < r.Count ? r[i] : "";

            var rows = new List<LogEntry>();
            foreach (var r in records.Skip(1))
            {
                if (r.Count < 2) continue;
                DateTime.TryParse(Get(r, time), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var t);
                var res = Get(r, result);
                var tool = Get(r, action);
                var from = Get(r, source);
                rows.Add(new LogEntry(t == default ? t : t.ToLocalTime(), from.Length > 0 ? from : "—", tool, Get(r, target),
                                      KindOf(tool, Get(r, dry) == "true", res), res, Get(r, detail)));
            }
            rows.Reverse();
            return rows;
        }

        /// <summary>The board's Kind column, from what the row says.</summary>
        public static string KindOf(string tool, bool dryRun, string result)
        {
            if (result.StartsWith("refused", StringComparison.OrdinalIgnoreCase)) return "Refused";
            if (dryRun) return "Dry run";
            var t = tool.ToLowerInvariant();
            if (t.Contains("plan") || t.Contains("check") || t.Contains("validate")) return "Check";
            if (t.Contains("list") || t.Contains("read") || t.Contains("info") || t.Contains("statistics") || t.Contains("get")) return "Read";
            return "Run";
        }

        /// <summary>RFC 4180 records: quoted fields may hold commas, quotes ("") and line breaks.</summary>
        private static IEnumerable<List<string>> Parse(string text)
        {
            var field = new StringBuilder();
            var record = new List<string>();
            var quoted = false;
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                if (quoted)
                {
                    if (c == '"' && i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                    else if (c == '"') quoted = false;
                    else field.Append(c);
                }
                else if (c == '"') quoted = true;
                else if (c == ',') { record.Add(field.ToString()); field.Clear(); }
                else if (c == '\r') { }
                else if (c == '\n')
                {
                    record.Add(field.ToString());
                    field.Clear();
                    if (record.Count > 1 || record[0].Length > 0) yield return record;
                    record = new List<string>();
                }
                else field.Append(c);
            }
            if (field.Length > 0 || record.Count > 0)
            {
                record.Add(field.ToString());
                yield return record;
            }
        }
    }
}
