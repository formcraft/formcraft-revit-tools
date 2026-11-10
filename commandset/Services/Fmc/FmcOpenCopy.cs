using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Documents this session opened with fmc_open_copy. They are read-only: a modify_model dry run may roll back;
    /// every other write, and every save, sync, reload and relinquish, is refused.
    /// </summary>
    public static class FmcVerifySession
    {
        private static readonly HashSet<string> _paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static void Remember(Document doc)
        {
            string key = Key(doc);
            if (key.Length > 0) lock (_paths) _paths.Add(key);
        }

        public static void Forget(Document doc) => ForgetPath(Key(doc));

        public static void ForgetPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            string key = path;
            try { key = Path.GetFullPath(path); } catch (Exception) { /* keep the given path */ }
            lock (_paths) _paths.Remove(key);
        }

        public static bool Contains(Document doc)
        {
            string key = Key(doc);
            if (key.Length == 0) return false;
            lock (_paths) return _paths.Contains(key);
        }

        private static string Key(Document doc)
        {
            try
            {
                if (doc == null || string.IsNullOrEmpty(doc.PathName)) return "";
                return Path.GetFullPath(doc.PathName);
            }
            catch (Exception) { return doc?.PathName ?? ""; }
        }
    }

    /// <summary>
    /// Opens a copy of a closed model in the background. Transmission data is read and written only for the copy path
    /// the caller passes. The source path is never opened and never written. The copy is not activated, not saved,
    /// not synced and not relinquished. A failure closes the copy without saving.
    /// </summary>
    public static class FmcOpenCopy
    {
        public static JObject Open(UIApplication app, JObject parameters)
        {
            string source = parameters.Value<string>("source") ?? "";
            string copy = parameters.Value<string>("copy_to") ?? throw new InvalidOperationException("copy_to is required");
            if (string.IsNullOrWhiteSpace(source)) throw new InvalidOperationException("source is required");
            var roots = FmcTarget.Roots(parameters);
            if (FmcTarget.SamePath(source, copy))
                throw new InvalidOperationException("copy_to is the source. Refusing to modify the original.");
            if (FmcTarget.IsProtected(copy, roots))
                throw new InvalidOperationException($"Refusing to open {copy}: it is under a protected original.");
            if (FmcTarget.IsCloud(copy) || FmcTarget.IsCloud(source))
                throw new InvalidOperationException("Cloud and Revit Server models are not opened by open_copy.");
            if (!File.Exists(copy)) throw new InvalidOperationException($"Copy not found: {copy}. The server copies the source before Revit opens it.");

            foreach (Document open in app.Application.Documents)
            {
                if (open.IsLinked) continue;
                if (!FmcTarget.Same(open, copy)) continue;
                FmcVerifySession.Remember(open);
                JObject existing = Audit(open, source, copy, false, new JArray());
                existing["already_open"] = true;
                existing["transmission_rewritten"] = false;
                existing["note"] = "The copy was already open. Links were not rewritten. Close it without saving and open again to apply link options.";
                return existing;
            }

            bool rewritten = ApplyLinks(copy, parameters["links"] as JObject);
            var dialogs = new JArray();
            string blocked = null;
            void OnDialog(object sender, DialogBoxShowingEventArgs e)
            {
                string id = e.DialogId ?? "";
                string message = e is TaskDialogShowingEventArgs task ? task.Message ?? "" : "";
                dialogs.Add(new JObject { ["id"] = id, ["message"] = message });
                string text = (id + " " + message).ToLowerInvariant();
                bool upgrade = text.Contains("upgrade") || text.Contains("previous version") || text.Contains("earlier version");
                bool dangerous = text.Contains("synchron") || text.Contains("relinquish") || text.Contains("save to central")
                    || (text.Contains("save") && !upgrade);
                if (dangerous)
                {
                    blocked = $"A save, sync or relinquish dialog appeared during open ({id}). It was cancelled. Nothing was saved.";
                    try { e.OverrideResult((int)TaskDialogResult.Cancel); } catch (Exception) { /* the dialog stays for a person */ }
                    return;
                }
                if (!upgrade) return;
                // In memory only: the copy is never saved, so the file on disk is not upgraded.
                try { e.OverrideResult(e is TaskDialogShowingEventArgs ? (int)TaskDialogResult.CommandLink1 : (int)TaskDialogResult.Ok); }
                catch (Exception) { /* open fails closed below */ }
            }

            Document doc = null;
            app.DialogBoxShowing += OnDialog;
            try
            {
                doc = OpenDetached(app, copy, parameters);
                if (blocked != null) throw new InvalidOperationException(blocked);
                FmcVerifySession.Remember(doc);
                JObject audit = Audit(doc, source, copy, rewritten, dialogs);
                audit["unknown_worksets"] = parameters["_unknown_worksets"] as JArray ?? new JArray();
                audit["file_was_workshared"] = parameters.Value<bool?>("_workshared_file") ?? false;
                audit["detach"] = (parameters.Value<bool?>("_workshared_file") ?? false) ? (parameters.Value<string>("detach") ?? "preserve") : "not_workshared";
                audit["is_active"] = app.ActiveUIDocument != null && doc.Equals(app.ActiveUIDocument.Document);
                if (audit.Value<bool>("is_active"))
                    audit["warning"] = "Revit made the copy the active document. It was not saved. Switch back to your own window without saving the copy.";
                return audit;
            }
            catch (Exception ex)
            {
                if (doc != null)
                {
                    try { doc.Close(false); } catch (Exception) { /* already closing */ }
                    FmcVerifySession.Forget(doc);
                }
                string seen = dialogs.Count == 0 ? "" : " Dialogs: " + dialogs.ToString(Newtonsoft.Json.Formatting.None);
                throw new InvalidOperationException(ex.Message + seen);
            }
            finally
            {
                app.DialogBoxShowing -= OnDialog;
            }
        }

        /// <summary>Revit links on an open document: name, saved path, whether it is loaded. Nothing is reloaded.</summary>
        public static JArray Links(Document doc)
        {
            var links = new JArray();
            if (doc == null || doc.IsFamilyDocument) return links;
            foreach (RevitLinkType type in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkType)).Cast<RevitLinkType>())
            {
                string path = "";
                try
                {
                    ExternalFileReference ext = type.GetExternalFileReference();
                    if (ext != null) path = ModelPathUtils.ConvertModelPathToUserVisiblePath(ext.GetAbsolutePath());
                }
                catch (Exception) { /* a missing external path is reported empty */ }
                LinkedFileStatus status;
                try { status = type.GetLinkedFileStatus(); }
                catch (Exception) { status = LinkedFileStatus.Invalid; }
                links.Add(new JObject
                {
                    ["name"] = type.Name,
                    ["path"] = path,
                    ["status"] = status.ToString(),
                    ["loaded"] = status == LinkedFileStatus.Loaded,
                    ["writable"] = false,
                });
            }
            return links;
        }

        private static Document OpenDetached(UIApplication app, string copy, JObject parameters)
        {
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(copy);
            var options = new OpenOptions { Audit = parameters.Value<bool?>("audit") ?? false };
            bool workshared = false;
            try { workshared = BasicFileInfo.Extract(copy).IsWorkshared; }
            catch (Exception ex) { throw new InvalidOperationException($"Not a Revit project file: {ex.Message}"); }
            var unknown = new JArray();
            if (workshared)
            {
                string detach = parameters.Value<string>("detach") ?? "preserve";
                options.DetachFromCentralOption = detach == "discard"
                    ? DetachFromCentralOption.DetachAndDiscardWorksets
                    : DetachFromCentralOption.DetachAndPreserveWorksets;
                options.SetOpenWorksetsConfiguration(Worksets(mp, parameters["worksets"], unknown));
            }
            parameters["_unknown_worksets"] = unknown;
            parameters["_workshared_file"] = workshared;
            return app.Application.OpenDocumentFile(mp, options);
        }

        private static WorksetConfiguration Worksets(ModelPath mp, JToken spec, JArray unknown)
        {
            if (spec is JArray names)
            {
                var config = new WorksetConfiguration(WorksetConfigurationOption.CloseAllWorksets);
                var known = new Dictionary<string, WorksetId>(StringComparer.OrdinalIgnoreCase);
                foreach (WorksetPreview preview in WorksharingUtils.GetUserWorksetInfo(mp)) known[preview.Name] = preview.Id;
                foreach (JToken name in names)
                {
                    string n = name.ToString();
                    if (known.TryGetValue(n, out WorksetId id)) config.Open(id);
                    else unknown.Add(n);
                }
                return config;
            }
            string mode = spec?.ToString() ?? "all";
            if (mode == "none") return new WorksetConfiguration(WorksetConfigurationOption.CloseAllWorksets);
            if (mode == "last") return new WorksetConfiguration(WorksetConfigurationOption.OpenLastViewed);
            return new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets);
        }

        /// <summary>Writes link load flags on the copy only. Returns whether transmission data was written.</summary>
        private static bool ApplyLinks(string copy, JObject links)
        {
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(copy);
            TransmissionData data = TransmissionData.ReadTransmissionData(mp);
            if (data == null) return false;
            string mode = links?.Value<string>("mode") ?? "unload";
            var rows = (links?["repath"] as JArray)?.OfType<JObject>().ToList() ?? new List<JObject>();
            foreach (ElementId id in data.GetAllExternalFileReferenceIds().ToList())
            {
                ExternalFileReference ext = data.GetLastSavedReferenceData(id);
                if (ext == null || ext.ExternalFileReferenceType != ExternalFileReferenceType.RevitLink) continue;
                string absolute = SafePath(ext.GetAbsolutePath());
                string saved = SafePath(ext.GetPath());
                ModelPath desired = ext.GetAbsolutePath();
                bool load = mode == "keep";
                if (mode == "repath")
                {
                    JObject hit = rows.FirstOrDefault(r => Same(r.Value<string>("from"), absolute) || Same(r.Value<string>("from"), saved));
                    load = false;
                    if (hit != null)
                    {
                        string to = hit.Value<string>("to") ?? "";
                        if (string.IsNullOrWhiteSpace(to)) throw new InvalidOperationException("a repath row needs to");
                        desired = ModelPathUtils.ConvertUserVisiblePathToModelPath(to);
                        load = hit.Value<bool?>("load") ?? true;
                    }
                }
                data.SetDesiredReferenceData(id, desired, ext.PathType, load);
            }
            TransmissionData.WriteTransmissionData(mp, data);
            return true;
        }

        private static string SafePath(ModelPath path)
        {
            try { return path == null ? "" : ModelPathUtils.ConvertModelPathToUserVisiblePath(path); }
            catch (Exception) { return ""; }
        }

        private static bool Same(string a, string b)
        {
            if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b)) return false;
            try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        }

        private static JObject Audit(Document doc, string source, string copy, bool rewritten, JArray dialogs)
        {
            bool active = false;
            JObject state = FmcTarget.DescribeState(doc);
            state["source"] = source;
            state["copy_to"] = copy;
            state["is_active"] = active;
            state["read_only"] = true;
            state["opened_in_background"] = true;
            state["saved"] = false;
            state["synced"] = false;
            state["relinquished"] = false;
            state["reload_modified"] = false;
            state["writes_source"] = false;
            state["transmission_rewritten"] = rewritten;
            state["links"] = Links(doc);
            state["dialogs"] = dialogs;
            state["unknown_worksets"] = new JArray();
            return state;
        }
    }
}
