using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// The pure parts of "Keep FMC data filled" (docs/LIVE_DATA.md): no Revit, so tests/shell compiles this file as is
    /// and tests it. The updater (LiveDataUpdater) asks these what to write; Revit only reads and writes the values.
    /// </summary>
    public static class LiveDataRules
    {
        // Target parameters. They're kit parameters (FMC_SharedParameters.txt): the updater writes one only when the
        // element or its type already has it, so a field the kit or the model doesn't have is simply skipped.
        public const string KeynoteCode = "FMC_Keynote_Code";
        public const string CodeDescription = "FMC_Code_Description";
        public const string CodeGroup = "FMC_Code_Group";
        public const string RoleCode = "FMC_Role_Code";
        public const string PanelId = "FMC_Panel_ID";
        public const string CircuitRef = "FMC_Circuit_Ref";
        public const string SyncStamp = "FMC_Data_Sync_Stamp";

        /// <summary>Every field the updater may write. Nothing else is ever touched (CLAUDE.md rule 5).</summary>
        public static readonly IReadOnlyList<string> Fields = new[] { KeynoteCode, CodeDescription, CodeGroup, RoleCode, PanelId, CircuitRef, SyncStamp };

        // [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt (Manual 4, kit naming rule). A local copy of a
        // central model adds _<user> after the number; a backup adds .0001 before .rvt.
        private static readonly Regex ModelName = new Regex(
            @"^(?<project>[A-Za-z0-9]+)-(?<originator>[A-Za-z0-9]+)-(?<volume>[A-Za-z0-9]+)-(?<level>[A-Za-z0-9]+)-(?<type>[A-Za-z0-9]+)-(?<role>[A-Z]{1,3})-(?<number>\d{1,6})(?:_[^.]*)?(?:\.\d{4})?$",
            RegexOptions.CultureInvariant);

        /// <summary>
        /// The role code from a model's file name or path, or "" when the name doesn't follow the naming rule (then the
        /// updater writes no role code).
        /// </summary>
        public static string RoleFromModelName(string pathOrTitle)
        {
            if (string.IsNullOrWhiteSpace(pathOrTitle)) return "";
            string name = pathOrTitle.Trim();
            int slash = Math.Max(name.LastIndexOf('\\'), name.LastIndexOf('/'));
            if (slash >= 0) name = name.Substring(slash + 1);
            if (name.EndsWith(".rvt", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            Match m = ModelName.Match(name);
            return m.Success ? m.Groups["role"].Value : "";
        }

        /// <summary>"&lt;panel&gt;/&lt;circuit number&gt;", or "" when either is missing (a device on no circuit gets nothing).</summary>
        public static string CircuitRefFor(string panel, string circuitNumber)
        {
            string p = (panel ?? "").Trim();
            string c = (circuitNumber ?? "").Trim();
            if (p.Length == 0 || c.Length == 0) return "";
            return p + "/" + c;
        }

        /// <summary>The stamp on an element the updater wrote to: kit version and date, e.g. "FMC Kit v2.2 2026-10-15".</summary>
        public static string Stamp(string kitVersion, DateTime when)
        {
            string v = (kitVersion ?? "").Trim();
            return "FMC Kit " + (v.Length == 0 ? "?" : "v" + v) + " " + when.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Whether to write <paramref name="proposed"/> over <paramref name="current"/>. Nothing is written when there is
        /// nothing to write or the value is already right. An empty field is filled. A value a person typed that differs
        /// is kept, unless the field is a pure copy of another value (a copy can't be "typed differently", only stale).
        /// </summary>
        public static bool ShouldWrite(string current, string proposed, bool pureCopy)
        {
            string p = proposed ?? "";
            if (p.Trim().Length == 0) return false;
            string c = current ?? "";
            if (c == p) return false;
            if (c.Trim().Length == 0) return true;
            return pureCopy;
        }

        /// <summary>A kit code's description and group (FMC_Master_Data.json "codes", or the keynote file's parent).</summary>
        public sealed class KitCode
        {
            public KitCode(string description, string group)
            {
                Description = description ?? "";
                Group = group ?? "";
            }

            public string Description { get; }
            public string Group { get; }
        }

        /// <summary>A Revit keynote table (the kit's FMC_Keynotes.txt): tab-separated code, description, parent.</summary>
        public static Dictionary<string, KitCode> ParseKeynotes(string text)
        {
            var codes = new Dictionary<string, KitCode>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(text)) return codes;
            foreach (string raw in text.TrimStart('﻿').Split('\n'))
            {
                string line = raw.TrimEnd('\r');
                if (line.Length == 0 || line.StartsWith("#")) continue;
                string[] f = line.Split('\t');
                if (f.Length < 2) continue;
                string code = f[0].Trim();
                if (code.Length == 0 || codes.ContainsKey(code)) continue;
                codes[code] = new KitCode(f[1].Trim(), f.Length > 2 ? f[2].Trim() : "");
            }
            return codes;
        }

        // ---------- the log ----------

        public const string LogHeader = "timestamp,model,element_id,field,old,new";

        public static string DefaultLogPath() =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "FMC_LiveData_Log.csv");

        /// <summary>One log row: what changed on which element. Tools and results only, never who (Manual 14.5).</summary>
        public static string LogLine(DateTime when, string model, string elementId, string field, string oldValue, string newValue) =>
            string.Join(",", new[]
            {
                when.ToString("yyyy-MM-ddTHH:mm:ss", System.Globalization.CultureInfo.InvariantCulture),
                Csv(model), Csv(elementId), Csv(field), Csv(oldValue), Csv(newValue),
            });

        public static string Csv(string value)
        {
            string v = value ?? "";
            if (v.IndexOfAny(new[] { ',', '"', '\r', '\n' }) < 0) return v;
            var b = new StringBuilder("\"");
            b.Append(v.Replace("\"", "\"\""));
            b.Append('"');
            return b.ToString();
        }
    }
}
