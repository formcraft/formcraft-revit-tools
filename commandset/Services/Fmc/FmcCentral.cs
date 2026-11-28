using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using Directory = System.IO.Directory;
using File = System.IO.File;
using Path = System.IO.Path;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The Revit half of fmc_central (server/src/fmc/central.ts holds the 13 rules, the plan and the transaction).
    /// Three steps, each refusing anything the server's plan did not ask for:
    ///   build     new project from a template, or a detached copy of a source model, made workshared with the planned
    ///             worksets and saved as a central in the server's LOCAL temp folder (rule 12). A source held by another
    ///             Revit session throws [FMC-CENTRAL-BUSY] so the server queues the job (rule 11).
    ///   selftest  read-only checks from the file (BasicFileInfo, workset preview), then a throwaway local with all
    ///             worksets open, one sync with relinquish-all, close without saving, delete the throwaway (rule 13).
    ///             Recursive delete is only allowed inside %LOCALAPPDATA%\Formcraft\central-temp (canonical, local disk).
    ///   promote   the tested temp central, detached with its worksets, saved as a central at the share path. Never
    ///             overwrites. A central knows its own path, so a plain file move would leave it pointing at temp.
    /// </summary>
    public static class FmcCentral
    {
        public const string Busy = "FMC-CENTRAL-BUSY";

        private static InvalidOperationException Err(string code, string message) => new InvalidOperationException("[" + code + "] " + message);

        private static List<string> Names(JToken t) => (t as JArray)?.Select(x => x.ToString().Trim()).Where(x => x.Length > 0).ToList() ?? new List<string>();

        /// <summary>The only folder the add-in will build in or recursively delete: %LOCALAPPDATA%\Formcraft\central-temp.</summary>
        public static string TempRoot()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(local)) local = Path.GetTempPath();
            return Path.GetFullPath(Path.Combine(local, "Formcraft", "central-temp"));
        }

        public static string Canonical(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "";
            try { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
            catch (Exception) { return ""; }
        }

        public static bool IsUnc(string path)
        {
            string c = Canonical(path);
            string raw = (path ?? "").Trim();
            return c.StartsWith(@"\\", StringComparison.Ordinal) || raw.StartsWith(@"\\", StringComparison.Ordinal);
        }

        public static bool IsNetwork(string path)
        {
            if (IsUnc(path)) return true;
            string c = Canonical(path);
            if (c.Length < 2 || c[1] != ':') return false;
            try { return new DriveInfo(c.Substring(0, 2)).DriveType == DriveType.Network; }
            catch (Exception) { return true; } // fail closed: an unreadable drive is not a safe temp
        }

        public static bool IsUnder(string path, string root)
        {
            string c = Canonical(path), r = Canonical(root);
            if (c.Length == 0 || r.Length == 0) return false;
            return c.Equals(r, StringComparison.OrdinalIgnoreCase)
                || c.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>A build or throwaway path must canonicalise to a local (non-UNC, non-network) folder inside TempRoot().</summary>
        public static bool IsSafeTempPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || IsUnc(path) || IsNetwork(path)) return false;
            return IsUnder(path, TempRoot());
        }

        private static void RequireSafeTemp(string path, string name)
        {
            if (!IsSafeTempPath(path))
                throw Err("FMC-CENTRAL-TEMP", name + " must be a local folder inside " + TempRoot() + " (canonical path; not a UNC or a network drive). Got: " + path);
        }

        /// <summary>Recursive delete only of a folder inside the tool-owned temp root. Never the root itself, never a share.</summary>
        public static void DeleteOwnTemp(string dir)
        {
            RequireSafeTemp(dir, "throwaway_dir");
            string c = Canonical(dir);
            if (c.Equals(Canonical(TempRoot()), StringComparison.OrdinalIgnoreCase))
                throw Err("FMC-CENTRAL-TEMP", "Refusing to delete the temp root itself");
            if (Directory.Exists(c)) Directory.Delete(c, true);
        }

        private static void RequireShareTarget(string target)
        {
            string c = Canonical(target);
            if (c.Length == 0) throw Err("FMC-CENTRAL-ARGS", "target_path must be an absolute path");
            if (IsUnder(c, TempRoot())) throw Err("FMC-CENTRAL-ARGS", "target_path must be on the workshare drive, not the temp folder");
            if (!IsNetwork(c)) throw Err("FMC-CENTRAL-ARGS", "Rule 4: a central goes only on the shared network drive, never local. " + c);
            if (c.IndexOf(@"\01_WIP\", StringComparison.OrdinalIgnoreCase) < 0)
                throw Err("FMC-CENTRAL-ARGS", "target_path must be under an ISO 19650 01_WIP folder");
        }

        public static JObject Build(UIApplication app, JObject p)
        {
            string temp = p.Value<string>("temp_path") ?? "";
            string kind = p.Value<string>("source_kind") ?? "";
            string src = p.Value<string>("source_path") ?? "";
            string detach = p.Value<string>("detach") ?? "preserve";
            List<string> worksets = Names(p["worksets"]);
            if (worksets.Count == 0) throw Err("FMC-CENTRAL-ARGS", "No worksets were planned");
            RequireSafeTemp(temp, "temp_path");
            if (File.Exists(temp)) throw Err("FMC-CENTRAL-TEMP-EXISTS", $"{temp} already exists");
            if (!File.Exists(src)) throw Err("FMC-CENTRAL-ARGS", $"Source not found: {src}");
            Directory.CreateDirectory(Path.GetDirectoryName(temp)!);

            Document doc;
            if (kind == "template")
            {
                doc = app.Application.NewProjectDocument(src);
            }
            else if (kind == "model")
            {
                string holder = HeldBy(app, src);
                if (holder != null) throw Err(Busy, holder);
                ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(src);
                var options = new OpenOptions { Audit = false };
                if (BasicFileInfo.Extract(src).IsWorkshared)
                {
                    options.DetachFromCentralOption = detach == "discard"
                        ? DetachFromCentralOption.DetachAndDiscardWorksets
                        : DetachFromCentralOption.DetachAndPreserveWorksets;
                    options.SetOpenWorksetsConfiguration(new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets));
                }
                try { doc = app.Application.OpenDocumentFile(mp, options); }
                catch (Exception ex) when (LooksBusy(ex)) { throw Err(Busy, $"{src} is held by another Revit session: {ex.Message}"); }
            }
            else throw Err("FMC-CENTRAL-ARGS", $"Unknown source_kind '{kind}'");

            var made = new JArray();
            try
            {
                if (!doc.IsWorkshared) doc.EnableWorksharing("Shared Levels and Grids", worksets[0]);
                using (var t = new Transaction(doc, "FMC central worksets"))
                {
                    t.Start();
                    var have = new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).ToWorksets().Select(w => w.Name).ToList();
                    foreach (string name in worksets)
                    {
                        if (have.Any(h => string.Equals(h, name, StringComparison.OrdinalIgnoreCase))) continue;
                        if (!WorksetTable.IsWorksetNameUnique(doc, name)) throw Err("FMC-CENTRAL-WORKSET", $"Workset name {name} is not unique");
                        Workset.Create(doc, name);
                        made.Add(name);
                    }
                    t.Commit();
                }
                var save = new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 3 };
                save.SetWorksharingOptions(new WorksharingSaveAsOptions { SaveAsCentral = true });
                doc.SaveAs(temp, save);
                try { WorksharingUtils.RelinquishOwnership(doc, new RelinquishOptions(true), new TransactWithCentralOptions()); }
                catch (Exception) { /* a brand-new central has no other owners; the self-test sync relinquishes too */ }
            }
            finally
            {
                doc.Close(false);
            }
            return new JObject { ["temp_path"] = temp, ["worksets_created"] = made, ["source_kind"] = kind };
        }

        public static JObject SelfTest(UIApplication app, JObject p)
        {
            string central = p.Value<string>("central_path") ?? "";
            string throwaway = p.Value<string>("throwaway_dir") ?? "";
            List<string> expected = Names(p["worksets"]);
            if (!File.Exists(central)) throw Err("FMC-CENTRAL-ARGS", $"Central not found: {central}");
            RequireSafeTemp(throwaway, "throwaway_dir");
            string held = HeldBy(app, central);
            if (held != null) throw Err(Busy, held);

            var result = new JObject { ["ok"] = false, ["read_only_open"] = false, ["sync_verified"] = false, ["local_discarded"] = false };
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(central);

            // 1. read-only: from the file, nothing is opened for writing
            BasicFileInfo info = BasicFileInfo.Extract(central);
            if (!info.IsWorkshared || !info.IsCentral) { result["detail"] = "The file is not a workshared central"; return result; }
            var preview = WorksharingUtils.GetUserWorksetInfo(mp).Select(w => w.Name).ToList();
            result["read_only_open"] = true;
            result["worksets_in_file"] = new JArray(preview);

            // 2 + 3. a throwaway local, all worksets open, one sync, then discarded
            if (Directory.Exists(throwaway)) DeleteOwnTemp(throwaway);
            Directory.CreateDirectory(throwaway);
            string local = Path.Combine(throwaway, Path.GetFileNameWithoutExtension(central) + "_fmc_selftest.rvt");
            var loaded = new List<string>();
            try
            {
                ModelPath lp = ModelPathUtils.ConvertUserVisiblePathToModelPath(local);
                WorksharingUtils.CreateNewLocal(mp, lp);
                var options = new OpenOptions { DetachFromCentralOption = DetachFromCentralOption.DoNotDetach, Audit = false };
                options.SetOpenWorksetsConfiguration(new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets));
                Document d = app.Application.OpenDocumentFile(lp, options);
                try
                {
                    loaded = new FilteredWorksetCollector(d).OfKind(WorksetKind.UserWorkset).ToWorksets().Where(w => w.IsOpen).Select(w => w.Name).ToList();
                    var sync = new SynchronizeWithCentralOptions { Comment = "Formcraft central self-test", Compact = false, SaveLocalBefore = false, SaveLocalAfter = false };
                    sync.SetRelinquishOptions(new RelinquishOptions(true));
                    d.SynchronizeWithCentral(new TransactWithCentralOptions(), sync);
                    result["sync_verified"] = true;
                }
                finally
                {
                    d.Close(false);
                }
            }
            catch (Exception ex)
            {
                result["detail"] = "Throwaway local: " + ex.Message;
            }
            finally
            {
                try { if (Directory.Exists(throwaway)) DeleteOwnTemp(throwaway); } catch (Exception) { /* reported below */ }
                result["local_discarded"] = !Directory.Exists(throwaway);
            }
            result["worksets_loaded"] = new JArray(loaded);
            var missing = expected.Where(e => !loaded.Any(l => string.Equals(l, e, StringComparison.OrdinalIgnoreCase))).ToList();
            result["missing_worksets"] = new JArray(missing);
            result["ok"] = result.Value<bool>("read_only_open") && result.Value<bool>("sync_verified") && result.Value<bool>("local_discarded") && missing.Count == 0;
            if (result["detail"] == null) result["detail"] = result.Value<bool>("ok") ? "Read-only checks, all worksets open, sync verified, local discarded" : "Self-test failed";
            return result;
        }

        public static JObject Promote(UIApplication app, JObject p)
        {
            string temp = p.Value<string>("temp_path") ?? "";
            string target = p.Value<string>("target_path") ?? "";
            if (!File.Exists(temp)) throw Err("FMC-CENTRAL-ARGS", $"Tested temp central not found: {temp}");
            RequireSafeTemp(temp, "temp_path");
            RequireShareTarget(target);
            if (File.Exists(target)) throw Err("FMC-CENTRAL-EXISTS", $"{target} exists; promote never overwrites");
            string dir = Path.GetDirectoryName(target) ?? "";
            if (!Directory.Exists(dir)) throw Err("FMC-CENTRAL-ARGS", $"Folder not found: {dir}");
            string holder = HeldBy(app, target);
            if (holder != null) throw Err(Busy, holder);

            var options = new OpenOptions { DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets, Audit = false };
            options.SetOpenWorksetsConfiguration(new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets));
            Document doc = app.Application.OpenDocumentFile(ModelPathUtils.ConvertUserVisiblePathToModelPath(temp), options);
            try
            {
                var save = new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 3 };
                save.SetWorksharingOptions(new WorksharingSaveAsOptions { SaveAsCentral = true });
                doc.SaveAs(target, save);
                try { WorksharingUtils.RelinquishOwnership(doc, new RelinquishOptions(true), new TransactWithCentralOptions()); }
                catch (Exception) { /* nothing is borrowed in a new central */ }
            }
            finally
            {
                doc.Close(false);
            }
            return new JObject { ["target_path"] = target };
        }

        /// <summary>Who holds the file: this session, or another process with the file locked. Null when it is free or the file does not exist.</summary>
        private static string HeldBy(UIApplication app, string path)
        {
            if (!File.Exists(path)) return null;
            if (app.Application.Documents.Cast<Document>().Any(d => FmcTarget.SamePath(d.PathName, path)))
                return $"{path} is open in this Revit session";
            try
            {
                using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) { }
                using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read)) { }
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null; // read-only on disk is not "busy": the source is only read
            }
            catch (IOException ex)
            {
                return $"{path} is in use by another process (another Revit session?): {ex.Message}";
            }
        }

        private static bool LooksBusy(Exception ex)
        {
            if (ex is Autodesk.Revit.Exceptions.CentralModelContentionException) return true;
            if (ex is IOException) return true;
            string m = (ex.Message ?? "").ToLowerInvariant();
            return m.Contains("in use") || m.Contains("locked") || m.Contains("being accessed") || m.Contains("another user")
                || m.Contains("being used") || m.Contains("cannot access") || m.Contains("sharing violation");
        }
    }
}
