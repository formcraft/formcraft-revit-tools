using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// BSF-3 safe family load / reload / overwrite, add-in side (Emlyn 28 Nov 2026 13:24 EAT; the server side is
    /// server/src/fmc/familyload.ts). The add-in enforces the parts that must hold even if a caller skips the server:
    ///  - never overwrite by default: a family already in the project, or an existing .rfa, without overwrite: true is
    ///    refused with FMC-FAM-EXISTS and the preview;
    ///  - an overwrite of a project family exports the old family to archive_path first (EditFamily + SaveAs, inside the
    ///    project's jail, inside an _Archive folder, never over an existing file); a failed export loads nothing;
    ///  - an overwrite of an existing .rfa needs archive_path naming the archived copy (made by the server) that exists
    ///    inside the project's jail;
    ///  - every path is a FmcPathJail path.
    /// The approval (one per overwrite, carrying archive_path) is the server's; the add-in checks the archive it names.
    /// </summary>
    public static class FmcFamilySafe
    {
        public const string Exists = "FMC-FAM-EXISTS", Archive = "FMC-FAM-ARCHIVE", PathCode = "FMC-FAM-PATH";

        static readonly StringComparer Ci = StringComparer.OrdinalIgnoreCase;

        public static Family Find(Document project, string name) =>
            string.IsNullOrEmpty(name) ? null :
            new FilteredElementCollector(project).OfClass(typeof(Family)).Cast<Family>().FirstOrDefault(f => Ci.Equals(f.Name, name));

        /// <summary>
        /// The preview before an overwrite: the family's types in the project with their instance counts, and, when the
        /// incoming type names are known (a family document, or a caller's list), the type changes. Revit keeps project
        /// types the new family doesn't have, so those are listed as kept_in_project_only.
        /// </summary>
        public static JObject Preview(Document project, string familyName, IEnumerable<string> incomingTypes = null, IEnumerable<string> incomingParams = null)
        {
            Family fam = Find(project, familyName);
            var r = new JObject { ["project"] = string.IsNullOrEmpty(project.PathName) ? project.Title : project.PathName, ["family"] = familyName, ["exists"] = fam != null };
            if (fam == null) return r;
            r["category"] = fam.FamilyCategory?.Name ?? "";
            r["in_place"] = fam.IsInPlace;
            r["editable"] = fam.IsEditable;
            var types = new JArray();
            var names = new List<string>();
            int total = 0;
            foreach (ElementId id in fam.GetFamilySymbolIds())
            {
                if (!(project.GetElement(id) is FamilySymbol s)) continue;
                int n = new FilteredElementCollector(project).WherePasses(new FamilyInstanceFilter(project, id)).GetElementCount();
                total += n;
                names.Add(s.Name);
                types.Add(new JObject { ["name"] = s.Name, ["id"] = id.Value, ["instances"] = n });
            }
            r["types"] = types;
            r["instances_total"] = total;
            if (incomingTypes != null)
            {
                var inc = incomingTypes.Where(x => !string.IsNullOrEmpty(x)).Distinct(Ci).ToList();
                r["type_changes"] = new JObject
                {
                    ["added"] = new JArray(inc.Where(x => !names.Contains(x, Ci))),
                    ["reloaded"] = new JArray(inc.Where(x => names.Contains(x, Ci))),
                    ["kept_in_project_only"] = new JArray(names.Where(x => !inc.Contains(x, Ci))),
                };
            }
            if (incomingParams != null) r["incoming_parameters"] = new JArray(incomingParams.Distinct(Ci).OrderBy(x => x));
            return r;
        }

        static bool InArchiveFolder(string canonicalPath) =>
            canonicalPath.Split('\\').Any(s => Ci.Equals(s, "_Archive"));

        /// <summary>Archive before replace: export the project's family to archive_path. Must run outside a transaction.</summary>
        public static string ArchiveProjectFamily(Document project, Family fam, string archivePath)
        {
            if (string.IsNullOrWhiteSpace(archivePath))
                throw new InvalidOperationException($"[{Archive}] overwriting {fam.Name} needs archive_path (the server's family overwrite approval carries it): nothing was loaded.");
            if (!archivePath.Trim().EndsWith(".rfa", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"[{Archive}] archive_path must be an .rfa: {archivePath}");
            string c = FmcPathJail.Require("write", archivePath.Trim(), FmcPathJail.For(project), "archive_path");
            if (!InArchiveFolder(c)) throw new InvalidOperationException($"[{Archive}] archive_path must be inside an _Archive folder: {c}");
            if (File.Exists(c)) throw new InvalidOperationException($"[{Archive}] {c} already exists: an archive is never overwritten.");
            if (fam.IsInPlace || !fam.IsEditable)
                throw new InvalidOperationException($"[{Archive}] {fam.Name} can't be exported (in-place or not editable): with no archive there is no overwrite. Nothing was loaded.");
            if (project.IsModifiable)
                throw new InvalidOperationException($"[{Archive}] the archive export can't run inside a transaction: nothing was loaded.");
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(c));
            Document fd = project.EditFamily(fam);
            try { fd.SaveAs(c, new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 1 }); }
            finally { fd.Close(false); }
            if (!File.Exists(c) || new FileInfo(c).Length == 0)
                throw new InvalidOperationException($"[{Archive}] the archive export of {fam.Name} to {c} produced no file: nothing was loaded.");
            return c;
        }

        /// <summary>
        /// The load gate for a project: nothing to replace → null (load as new). Already there without overwrite → FMC-FAM-EXISTS
        /// with the preview. Already there with overwrite → the old family is archived first; returns the archive and the preview.
        /// </summary>
        public static JObject BeforeLoad(Document project, string familyName, bool overwrite, string archivePath, IEnumerable<string> incomingTypes = null)
        {
            Family fam = Find(project, familyName);
            if (fam == null) return null;
            JObject preview = Preview(project, familyName, incomingTypes);
            if (!overwrite)
                throw new InvalidOperationException($"[{Exists}] {familyName} is already in {project.Title} ({preview["types"]?.Count() ?? 0} types, {preview.Value<int?>("instances_total") ?? 0} instances): " +
                    "nothing was loaded. Replacing it is an overwrite: overwrite: true with a family overwrite approval (the old family is archived first). Preview: " +
                    preview.ToString(Newtonsoft.Json.Formatting.None));
            string archived = ArchiveProjectFamily(project, fam, archivePath);
            return new JObject { ["archived"] = archived, ["preview"] = preview };
        }

        /// <summary>
        /// An existing .rfa replaced by a save: overwrite: true and archive_path naming the server's verified archive copy,
        /// inside the project's jail and an _Archive folder. Throws the refusal.
        /// </summary>
        public static string RequireFileArchived(string target, bool overwrite, string archivePath, FmcPathJail.Roots roots)
        {
            if (!overwrite)
                throw new InvalidOperationException($"[{Exists}] {target} already exists: nothing was saved. Replacing it is an overwrite: overwrite: true with a family overwrite approval (the old file is archived first).");
            if (string.IsNullOrWhiteSpace(archivePath))
                throw new InvalidOperationException($"[{Archive}] {target} exists: an overwrite needs archive_path (the old file archived inside the project first, by the server's family overwrite gate). Nothing was saved.");
            FmcPathJail.Verdict w = FmcPathJail.Check("write", archivePath.Trim(), roots, "archive_path");
            if (!w.Ok) throw new InvalidOperationException(w.Message);
            if (!InArchiveFolder(w.Resolved)) throw new InvalidOperationException($"[{Archive}] archive_path must be inside an _Archive folder: {w.Resolved}");
            if (!File.Exists(w.Resolved)) throw new InvalidOperationException($"[{Archive}] the archive {w.Resolved} doesn't exist: nothing was saved.");
            return w.Resolved;
        }
    }
}
