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
    ///   promote   the tested temp central, detached with its worksets, saved as a central at the share path. Never
    ///             overwrites. A central knows its own path, so a plain file move would leave it pointing at temp.
    /// </summary>
    public static class FmcCentral
    {
        public const string Busy = "FMC-CENTRAL-BUSY";

        private static InvalidOperationException Err(string code, string message) => new InvalidOperationException("[" + code + "] " + message);

        private static List<string> Names(JToken t) => (t as JArray)?.Select(x => x.ToString().Trim()).Where(x => x.Length > 0).ToList() ?? new List<string>();

        public static JObject Build(UIApplication app, JObject p)
        {
            string temp = p.Value<string>("temp_path") ?? "";
            string kind = p.Value<string>("source_kind") ?? "";
            string src = p.Value<string>("source_path") ?? "";
            string detach = p.Value<string>("detach") ?? "preserve";
            List<string> worksets = Names(p["worksets"]);
            if (worksets.Count == 0) throw Err("FMC-CENTRAL-ARGS", "No worksets were planned");
            if (string.IsNullOrWhiteSpace(temp) || !Path.IsPathRooted(temp)) throw Err("FMC-CENTRAL-ARGS", "temp_path must be absolute");
            if (temp.StartsWith(@"\\")) throw Err("FMC-CENTRAL-ARGS", "The build goes in a local temp folder, never on a share (rule 12)");
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
            if (string.IsNullOrWhiteSpace(throwaway) || throwaway.StartsWith(@"\\")) throw Err("FMC-CENTRAL-ARGS", "throwaway_dir must be a local folder");
            if (app.Application.Documents.Cast<Document>().Any(d => FmcTarget.SamePath(d.PathName, central)))
                throw Err(Busy, $"{central} is open in this Revit session");

            var result = new JObject { ["ok"] = false, ["read_only_open"] = false, ["sync_verified"] = false, ["local_discarded"] = false };
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(central);

            // 1. read-only: from the file, nothing is opened for writing
            BasicFileInfo info = BasicFileInfo.Extract(central);
            if (!info.IsWorkshared || !info.IsCentral) { result["detail"] = "The file is not a workshared central"; return result; }
            var preview = WorksharingUtils.GetUserWorksetInfo(mp).Select(w => w.Name).ToList();
            result["read_only_open"] = true;
            result["worksets_in_file"] = new JArray(preview);

            // 2 + 3. a throwaway local, all worksets open, one sync, then discarded
            if (Directory.Exists(throwaway)) Directory.Delete(throwaway, true);
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
                try { if (Directory.Exists(throwaway)) Directory.Delete(throwaway, true); } catch (Exception) { /* reported below */ }
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
            if (File.Exists(target)) throw Err("FMC-CENTRAL-EXISTS", $"{target} exists; promote never overwrites");
            string dir = Path.GetDirectoryName(target) ?? "";
            if (!Directory.Exists(dir)) throw Err("FMC-CENTRAL-ARGS", $"Folder not found: {dir}");

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

        /// <summary>Who holds the source: this session, or another process with the file locked. Null when it is free.</summary>
        private static string HeldBy(UIApplication app, string path)
        {
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
            string m = (ex.Message ?? "").ToLowerInvariant();
            return m.Contains("in use") || m.Contains("locked") || m.Contains("being accessed") || m.Contains("another user") || ex is Autodesk.Revit.Exceptions.CentralModelContentionException;
        }
    }
}
