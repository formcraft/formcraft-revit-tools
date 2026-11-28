using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json.Linq;
using File = System.IO.File;
using Path = System.IO.Path;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_file open_local and close_local (F125).
    /// open_local opens a person's existing workshared LOCAL, optionally as the active document. It never detaches, never creates a
    /// new local, never synchronises, and refuses a central model. close_local closes an open project without synchronising or
    /// relinquishing; it saves only when the server sent the save through fmc_close_local_apply (a write command with the
    /// live-model lock, the AI gate and a batch lease). Runs on the Revit main thread inside FmcFileEventHandler.
    /// Error codes are written [FMC-FILE-...] so the server and the tool reply can name them.
    /// </summary>
    public static class FmcOpenLocal
    {
        private static InvalidOperationException Err(string code, string message) => new InvalidOperationException("[" + code + "] " + message);

        /// <summary>
        /// The file is the central model: workshared, not a local, and its central path is the file itself. BasicFileInfo.IsCentral
        /// alone is not trusted: it answered true for electrical_USER and architectural_USER, which are locals (fmc_docs central=false,
        /// Revit isLocal=true), so open_local refused them with FMC-FILE-CENTRAL-REFUSED. A file Revit says is a local is never central.
        /// </summary>
        internal static bool IsCentralFile(BasicFileInfo info, string path)
        {
            bool workshared = false, isLocal = false, flag = false;
            string centralPath = "";
            try { workshared = info.IsWorkshared; } catch (Exception) { workshared = false; }
            try { isLocal = info.IsLocal; } catch (Exception) { isLocal = false; }
            try { flag = info.IsCentral; } catch (Exception) { flag = false; }
            try { centralPath = info.CentralPath ?? ""; } catch (Exception) { centralPath = ""; }
            return CentralRule(workshared, isLocal, flag, centralPath, path);
        }

        /// <summary>The rule on its own (the same one the server's probe uses, FmcDocsWork.Probe): see IsCentralFile.</summary>
        internal static bool CentralRule(bool workshared, bool isLocal, bool isCentralFlag, string centralPath, string path)
        {
            if (!workshared || isLocal) return false;
            if (!string.IsNullOrEmpty(centralPath)) return FmcTarget.SamePath(centralPath, path);
            return isCentralFlag;
        }

        /// <summary>An open workshared document that is the central model itself (its central path is its own path).</summary>
        internal static bool IsCentralDoc(Document doc)
        {
            try
            {
                if (!doc.IsWorkshared || doc.IsDetached || string.IsNullOrEmpty(doc.PathName)) return false;
                ModelPath central = doc.GetWorksharingCentralModelPath();
                if (central == null) return false;
                return FmcTarget.SamePath(ModelPathUtils.ConvertModelPathToUserVisiblePath(central), doc.PathName);
            }
            catch (Exception) { return false; }
        }

        private static IEnumerable<Document> Projects(UIApplication app)
        {
            foreach (Document d in app.Application.Documents)
                if (!d.IsLinked) yield return d;
        }

        private static JObject Describe(Document doc, UIApplication app)
        {
            Document active = app.ActiveUIDocument?.Document;
            string id = "";
            try { id = doc.CreationGUID.ToString(); } catch (Exception) { id = ""; }
            return new JObject
            {
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["doc_id"] = id,
                ["is_workshared"] = doc.IsWorkshared,
                ["is_detached"] = doc.IsDetached,
                ["is_active"] = active != null && doc.Equals(active),
                ["is_modified"] = doc.IsModified,
            };
        }

        /// <summary>The periodic save and sync reminders are not an answer to anything this command asked.</summary>
        private static bool IsSessionReminder(string dialogId)
        {
            string id = dialogId ?? "";
            if (id.IndexOf("Project_Not_Saved_Recently", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return id.IndexOf("Changes_Not_Synchronized_With_Central", StringComparison.OrdinalIgnoreCase) >= 0
                && id.IndexOf("Local_Changes", StringComparison.OrdinalIgnoreCase) < 0;
        }

        /// <summary>Cancels any dialog that would synchronise, relinquish or save to central. Every dialog is recorded. Nothing is clicked otherwise.</summary>
        private sealed class Watch : IDisposable
        {
            private readonly UIApplication _app;
            public JArray Dialogs { get; } = new JArray();
            public string Blocked { get; private set; }

            public Watch(UIApplication app)
            {
                _app = app;
                _app.DialogBoxShowing += OnDialog;
            }

            private void OnDialog(object sender, DialogBoxShowingEventArgs e)
            {
                string id = e.DialogId ?? "";
                string message = e is TaskDialogShowingEventArgs task ? task.Message ?? "" : "";
                Dialogs.Add(new JObject { ["id"] = id, ["message"] = message });
                if (IsSessionReminder(id)) return;
                string text = (id + " " + message).ToLowerInvariant();
                bool dangerous = text.Contains("synchron") || text.Contains("relinquish") || text.Contains("save to central");
                if (!dangerous) return;
                Blocked = "A synchronise, relinquish or save-to-central dialog appeared (" + id + "). It was cancelled. Nothing was synchronised.";
                try { e.OverrideResult((int)TaskDialogResult.Cancel); } catch (Exception) { /* the dialog stays for a person */ }
            }

            public void Dispose() { _app.DialogBoxShowing -= OnDialog; }
        }

        private static WorksetConfiguration Worksets(ModelPath mp, JToken spec, JArray unknown, out string mode)
        {
            if (spec is JArray names)
            {
                var config = new WorksetConfiguration(WorksetConfigurationOption.CloseAllWorksets);
                var known = new Dictionary<string, WorksetId>(StringComparer.OrdinalIgnoreCase);
                foreach (WorksetPreview preview in WorksharingUtils.GetUserWorksetInfo(mp)) known[preview.Name] = preview.Id;
                var ids = new List<WorksetId>();
                foreach (JToken name in names)
                {
                    string n = name.ToString().Trim();
                    if (known.TryGetValue(n, out WorksetId id)) ids.Add(id);
                    else unknown.Add(n);
                }
                if (unknown.Count > 0)
                    throw Err("FMC-FILE-WORKSET-UNKNOWN", "No workset named " + string.Join(", ", unknown.Select(u => "\"" + u + "\"")) + ". The file has: " + string.Join(", ", known.Keys.OrderBy(k => k)) + ". Nothing was opened.");
                if (ids.Count > 0) config.Open(ids);
                mode = "named";
                return config;
            }
            string text = (spec == null || spec.Type == JTokenType.Null ? "all" : spec.ToString()).Trim().ToLowerInvariant();
            if (text == "none") { mode = "none"; return new WorksetConfiguration(WorksetConfigurationOption.CloseAllWorksets); }
            if (text == "last" || text == "last_viewed") { mode = "last_viewed"; return new WorksetConfiguration(WorksetConfigurationOption.OpenLastViewed); }
            mode = "all";
            return new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets);
        }

        public static JObject Open(UIApplication app, JObject p)
        {
            string path = (p.Value<string>("path") ?? "").Trim();
            bool activate = p.Value<bool?>("activate") ?? true;
            JToken worksetSpec = p["worksets"];
            bool worksetsAsked = worksetSpec != null && worksetSpec.Type != JTokenType.Null;
            if (path.Length == 0) throw Err("FMC-FILE-PATH-REQUIRED", "path is required: the full path of the workshared local (.rvt).");
            if (FmcTarget.IsCloud(path)) throw Err("FMC-FILE-CLOUD-REFUSED", "Cloud and Revit Server models are not opened by open_local. Use a local file on disk.");
            if (!string.Equals(Path.GetExtension(path), ".rvt", StringComparison.OrdinalIgnoreCase))
                throw Err("FMC-FILE-NOT-PROJECT", "path must be a project .rvt. A family, template or backup is not opened as a local.");
            if (!File.Exists(path)) throw Err("FMC-FILE-NOT-FOUND", "File not found: " + path);
            if (FmcTarget.IsProtected(path, FmcTarget.Roots(p)))
                throw Err("FMC-FILE-PROTECTED-REFUSED", path + " is under a protected original. Open your local, not the original.");
            if (p["live_paths"] is JArray live && live.Any(x => x.Type == JTokenType.String && FmcTarget.SamePath(x.ToString(), path)))
                throw Err("FMC-FILE-PROTECTED-REFUSED", path + " is a live path. Open your local, not the original.");

            BasicFileInfo info;
            try { info = BasicFileInfo.Extract(path); }
            catch (Exception ex) { throw Err("FMC-FILE-NOT-PROJECT", "Not a Revit project file: " + ex.Message); }
            if (IsCentralFile(info, path))
                throw Err("FMC-FILE-CENTRAL-REFUSED", path + " is a central model. open_local opens a local only; it never opens, detaches or creates a local from a central.");
            bool workshared = info.IsWorkshared;
            if (!workshared && worksetsAsked)
                throw Err("FMC-FILE-NOT-WORKSHARED", path + " is not workshared, so worksets cannot be set. Leave worksets out.");

            // already open: only activate it. Nothing is reopened, nothing is reloaded.
            foreach (Document open in Projects(app))
            {
                if (string.IsNullOrEmpty(open.PathName) || !FmcTarget.SamePath(open.PathName, path)) continue;
                Document active = app.ActiveUIDocument?.Document;
                bool wasActive = active != null && open.Equals(active);
                if (activate && !wasActive) app.OpenAndActivateDocument(open.PathName);
                JObject already = Describe(open, app);
                already["already_open"] = true;
                already["activated"] = activate && !wasActive;
                already["note"] = "The local was already open. It was " + (activate ? (wasActive ? "already the active document." : "activated.") : "left as it was.") + " Nothing was reopened, saved or synchronised.";
                already["detached"] = false;
                already["created_local"] = false;
                already["saved"] = false;
                already["synced"] = false;
                already["relinquished"] = false;
                return already;
            }

            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(path);
            var options = new OpenOptions { DetachFromCentralOption = DetachFromCentralOption.DoNotDetach, Audit = false };
            string mode = "not_workshared";
            var unknown = new JArray();
            if (workshared) options.SetOpenWorksetsConfiguration(Worksets(mp, worksetSpec, unknown, out mode));

            using (var watch = new Watch(app))
            {
                Document doc;
                try
                {
                    if (activate) doc = app.OpenAndActivateDocument(mp, options, false).Document;
                    else doc = app.Application.OpenDocumentFile(mp, options);
                }
                catch (Exception ex)
                {
                    string seen = watch.Dialogs.Count == 0 ? "" : " Dialogs: " + watch.Dialogs.ToString(Newtonsoft.Json.Formatting.None);
                    throw new InvalidOperationException((watch.Blocked ?? ex.Message) + seen);
                }
                if (doc == null) throw new InvalidOperationException("Revit did not open " + path + ".");
                JObject result = Describe(doc, app);
                result["already_open"] = false;
                result["activated"] = activate;
                result["worksets"] = mode;
                result["unknown_worksets"] = unknown;
                result["file_was_workshared"] = workshared;
                result["detached"] = false;
                result["created_local"] = false;
                result["saved"] = false;
                result["synced"] = false;
                result["relinquished"] = false;
                result["dialogs"] = watch.Dialogs;
                return result;
            }
        }

        public static JObject Close(UIApplication app, JObject p, bool allowSave)
        {
            string key = (p.Value<string>("document") ?? "").Trim();
            bool save = p.Value<bool?>("save") ?? false;
            bool confirm = p.Value<bool?>("confirm") ?? false;
            if (key.Length == 0) throw Err("FMC-DOC-REQUIRED", "document is required: the title or full path of the local to close. Refusing to use the active document.");
            if (save && !allowSave)
                throw Err("FMC-FILE-SAVE-REFUSED", "close_local saves only through fmc_close_local_apply (a write: batch lease, live-model lock, AI gate). Nothing was closed or saved.");

            var open = Projects(app).ToList();
            var hits = open.Where(d => FmcTarget.Same(d, key)).ToList();
            if (hits.Count == 0) throw Err("FMC-DOC-NOT-FOUND", "No open document has title or path \"" + key + "\". Refusing to use the active document.");
            if (hits.Count > 1) throw Err("FMC-DOC-AMBIGUOUS", "\"" + key + "\" matches " + hits.Count + " open documents. Pass the full path. Refusing to use the active document.");
            Document doc = hits[0];
            string title = doc.Title ?? "";
            string path = doc.PathName ?? "";

            if (doc.IsFamilyDocument) throw Err("FMC-FILE-FAMILY-REFUSED", title + " is a family document. close_local closes project locals; use close for a family.");
            if (doc.IsDetached || FmcVerifySession.Contains(doc))
                throw Err("FMC-FILE-VERIFY-COPY", title + " is a detached or verification copy. Close it with close_copy.");
            if (IsCentralDoc(doc)) throw Err("FMC-FILE-CENTRAL-REFUSED", title + " is the central model, not a local. close_local does not close it.");
            if (open.Count <= 1)
                throw Err("FMC-FILE-ONLY-DOC", title + " is the only open document. Revit cannot close the active document and there is nothing to switch to, so it was not closed.");
            if (!save && doc.IsModified && !confirm)
                throw Err("FMC-FILE-UNSAVED-CHANGES", title + " has unsaved changes and save is false, so closing would discard them. Save it in Revit, or run again with confirm=true to discard them.");
            if (save)
            {
                var why = new List<string>();
                if (string.IsNullOrEmpty(path)) why.Add("it has never been saved (no path)");
                if ((title + " " + path).IndexOf("hebert hostels", StringComparison.OrdinalIgnoreCase) >= 0) why.Add("HEBERT HOSTELS is never saved");
                if (FmcTarget.IsProtected(path, FmcTarget.Roots(p))) why.Add("it is under a protected original");
                if (why.Count > 0) throw Err("FMC-FILE-SAVE-REFUSED", "save=true refused: " + string.Join("; ", why) + ". Nothing was closed or saved.");
            }

            // Revit cannot close the active document: activate another open project first, and say which.
            string switchedTo = "";
            Document active = app.ActiveUIDocument?.Document;
            if (active != null && doc.Equals(active))
            {
                string wanted = (p.Value<string>("activate_first") ?? "").Trim();
                var others = open.Where(d => !d.Equals(doc) && !d.IsFamilyDocument && !string.IsNullOrEmpty(d.PathName)).ToList();
                Document pick = others.FirstOrDefault(d => wanted.Length > 0 && FmcTarget.SamePath(d.PathName, wanted))
                    ?? others.FirstOrDefault(d => !d.IsDetached && !FmcVerifySession.Contains(d))
                    ?? others.FirstOrDefault();
                if (pick == null)
                    throw Err("FMC-FILE-ACTIVE-CLOSE", title + " is the active document and no other open project has a saved path to switch to. Revit cannot close the active document.");
                try { app.OpenAndActivateDocument(pick.PathName); }
                catch (Exception ex) { throw Err("FMC-FILE-ACTIVE-CLOSE", "Could not activate " + pick.Title + " before closing " + title + ": " + ex.Message); }
                Document now = app.ActiveUIDocument?.Document;
                if (now != null && doc.Equals(now))
                    throw Err("FMC-FILE-ACTIVE-CLOSE", title + " is still the active document after switching to " + pick.Title + ". It was not closed.");
                switchedTo = pick.Title ?? "";
            }

            using (var watch = new Watch(app))
            {
                if (save)
                {
                    // the local file only: Save never synchronises and never relinquishes
                    doc.Save(new SaveOptions());
                }
                bool closed;
                try { closed = doc.Close(false); }
                catch (Exception ex)
                {
                    string seen = watch.Dialogs.Count == 0 ? "" : " Dialogs: " + watch.Dialogs.ToString(Newtonsoft.Json.Formatting.None);
                    throw new InvalidOperationException((watch.Blocked ?? ex.Message) + seen);
                }
                if (closed) FmcVerifySession.ForgetPath(path);
                return new JObject
                {
                    ["closed"] = closed,
                    ["title"] = title,
                    ["path"] = path,
                    ["saved"] = save && closed,
                    ["synced"] = false,
                    ["relinquished"] = false,
                    ["activated_first"] = switchedTo,
                    ["blocked"] = watch.Blocked,
                    ["dialogs"] = watch.Dialogs,
                };
            }
        }
    }
}