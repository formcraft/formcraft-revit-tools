using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Active document and view, as one string. Link tools compare it and stop when it changes.
    /// They do not switch the active document back.
    /// </summary>
    public static class FmcLinkGuard
    {
        public static string Stamp(UIApplication app)
        {
            try
            {
                UIDocument ui = app?.ActiveUIDocument;
                Document doc = ui?.Document;
                string view = "";
                try { view = ui?.ActiveView == null ? "" : ui.ActiveView.Id.Value.ToString(); }
                catch (Exception) { view = ""; }
                return (doc?.Title ?? "") + "\u001f" + (doc?.PathName ?? "") + "\u001f" + view;
            }
            catch (Exception) { return ""; }
        }

        public static bool IsOpen(UIApplication app, string path)
        {
            if (app == null || string.IsNullOrWhiteSpace(path)) return false;
            foreach (Document doc in app.Application.Documents)
            {
                if (doc.IsLinked || string.IsNullOrEmpty(doc.PathName)) continue;
                if (FmcTarget.SamePath(doc.PathName, path)) return true;
            }
            return false;
        }

        public static bool CentralSegment(string path)
        {
            foreach (string raw in (path ?? "").Split('\\', '/'))
            {
                string seg = raw.Trim();
                if (seg.StartsWith("_", StringComparison.Ordinal)) seg = seg.Substring(1);
                if (seg.Length > 3 && char.IsDigit(seg[0]) && char.IsDigit(seg[1]) && seg[2] == '_') seg = seg.Substring(3);
                if (seg.Equals("central", StringComparison.OrdinalIgnoreCase) || seg.Equals("centrals", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        public static void RefuseCopyPath(string path, UIApplication app, JObject parameters, bool checkHeader)
        {
            if (CentralSegment(path))
                throw new InvalidOperationException("[FMC-LINK-CENTRAL] " + path + " is under a centrals folder. Workshared centrals are never written.");
            if (FmcTarget.IsProtected(path, Listed(parameters, "_protected_paths", "_protected_roots", "protected_roots")))
                throw new InvalidOperationException("[FMC-LINK-PROTECTED] " + path + " is under a protected path.");
            if (NameExcluded(path, parameters))
                throw new InvalidOperationException("[FMC-LINK-PROTECTED] " + Path.GetFileName(path) + " is excluded by save_exclude or sync_exclude. It is not written.");
            if (IsOpen(app, path))
                throw new InvalidOperationException("[FMC-LINK-SAME-FILE] " + path + " is open. A published link copy is never that file.");
            if (!checkHeader || !File.Exists(path)) return;
            if (!TryHeader(path, out bool workshared, out _, out _, out string error))
                throw new InvalidOperationException("[FMC-LINK-CENTRAL] Could not read " + path + ", so it was not written. " + error);
            if (workshared)
                throw new InvalidOperationException("[FMC-LINK-CENTRAL] " + path + " is workshared. Published link copies never overwrite a workshared file.");
        }

        public static void Dismiss(DialogBoxShowingEventArgs e)
        {
            string id = e.DialogId ?? "";
            string message = e is TaskDialogShowingEventArgs task ? task.Message ?? "" : "";
            string text = (id + " " + message).ToLowerInvariant();
            bool dangerous = text.Contains("save") || text.Contains("synchron") || text.Contains("relinquish");
            try
            {
                if (dangerous) e.OverrideResult((int)TaskDialogResult.Cancel);
                else if (text.Contains("detach") || text.Contains("upgrade") || text.Contains("audit"))
                    e.OverrideResult(e is TaskDialogShowingEventArgs ? (int)TaskDialogResult.CommandLink1 : (int)TaskDialogResult.Ok);
            }
            catch (Exception) { /* the open fails closed when the dialog stays */ }
        }

        static bool NameExcluded(string path, JObject parameters)
        {
            string name = Path.GetFileNameWithoutExtension(path) ?? "";
            foreach (string item in Listed(parameters, "_save_exclude"))
            {
                string want = Path.GetFileNameWithoutExtension(item);
                if (string.IsNullOrWhiteSpace(want)) want = item.Trim();
                if (want.Length == 0) continue;
                if (name.Equals(want, StringComparison.OrdinalIgnoreCase)) return true;
                if (name.StartsWith(want, StringComparison.OrdinalIgnoreCase) && name.Length > want.Length)
                {
                    char next = name[want.Length];
                    if (next == '_' || next == ' ') return true;
                }
            }
            return false;
        }

        static List<string> Listed(JObject parameters, params string[] keys)
        {
            var list = new List<string>();
            foreach (string key in keys)
            {
                if (parameters?[key] is JArray array)
                    foreach (JToken item in array)
                        if (item.Type == JTokenType.String && !string.IsNullOrWhiteSpace(item.ToString())) list.Add(item.ToString());
            }
            return list;
        }

        public static bool TryHeader(string path, out bool workshared, out bool createdLocal, out string central, out string error)
        {
            workshared = false;
            createdLocal = false;
            central = "";
            error = "";
            try
            {
                BasicFileInfo info = BasicFileInfo.Extract(path);
                workshared = info.IsWorkshared;
                createdLocal = info.IsCreatedLocal;
                central = info.CentralPath ?? "";
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }
    }

    /// <summary>
    /// Closed-file link tables, unload, and a published link copy.
    /// Reload and LoadFrom stay on <see cref="FmcReloadLinkHandler"/>, which opens no transaction.
    /// This handler does not open the source model, does not save or sync an open model, and does not
    /// activate a document. A workshared published copy is DetachAndDiscardWorksets then SaveAs, so the
    /// file is not a central. A byte copy would keep the central identity.
    /// </summary>
    public class FmcLinkSessionHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _done.Reset();
            return FmcBusy.Wait(_done, timeoutMilliseconds);
        }

        public string GetName() => "FMC link session";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string before = FmcLinkGuard.Stamp(app);
            try
            {
                switch (Action)
                {
                    case "transmission": Result = Transmission(app); break;
                    case "publish": Result = Publish(app); break;
                    case "unload": Result = Unload(app); break;
                    default: throw new InvalidOperationException("Unknown FMC link session action '" + Action + "'");
                }
                Result["active_before"] = before;
                Result["active_after"] = FmcLinkGuard.Stamp(app);
                Result["active_unchanged"] = (string)Result["active_before"] == (string)Result["active_after"];
                if (Result.Value<bool>("active_unchanged") == false)
                    throw new InvalidOperationException("[FMC-LINK-ACTIVE-CHANGED] The active document or view changed. It was not restored.");
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        JObject Transmission(UIApplication app)
        {
            string file = (Parameters.Value<string>("file") ?? "").Trim();
            if (file.Length == 0) file = (Parameters.Value<string>("document") ?? "").Trim();
            if (!File.Exists(file)) throw new InvalidOperationException("[FMC-LINK-NOT-LOADED] File not found: " + file);
            bool write = Parameters.Value<bool?>("write") == true;
            if (write)
            {
                if (FmcLinkGuard.IsOpen(app, file))
                    throw new InvalidOperationException("[FMC-LINK-OPEN-FILE] " + file + " is open. Transmission data is not written, and the file is not closed.");
                FmcLinkGuard.RefuseCopyPath(file, app, Parameters, checkHeader: true);
                return WriteTransmission(file);
            }
            return ReadTransmission(file);
        }

        static JObject ReadTransmission(string file)
        {
            FmcLinkGuard.TryHeader(file, out bool workshared, out bool createdLocal, out string central, out _);
            bool isCentral = workshared && !createdLocal && (central.Length == 0 || FmcTarget.SamePath(central, file));
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(file);
            TransmissionData data = TransmissionData.ReadTransmissionData(mp);
            var links = new JArray();
            if (data != null)
            {
                foreach (ElementId id in data.GetAllExternalFileReferenceIds())
                {
                    ExternalFileReference ext = data.GetLastSavedReferenceData(id);
                    if (ext == null || ext.ExternalFileReferenceType != ExternalFileReferenceType.RevitLink) continue;
                    string absolute = Safe(ext.GetAbsolutePath());
                    string saved = Safe(ext.GetPath());
                    links.Add(new JObject
                    {
                        ["id"] = id.Value,
                        ["name"] = Path.GetFileName(absolute.Length > 0 ? absolute : saved),
                        ["path"] = absolute,
                        ["saved_path"] = saved,
                        ["path_type"] = ext.PathType.ToString(),
                        ["loaded"] = JValue.CreateNull(),
                        ["pinned"] = JValue.CreateNull(),
                        ["workset"] = JValue.CreateNull(),
                    });
                }
            }
            return new JObject
            {
                ["ok"] = true,
                ["file"] = file,
                ["opened"] = false,
                ["transmission"] = data != null,
                ["workshared"] = workshared,
                ["is_central"] = isCentral,
                ["central"] = central,
                ["links"] = links,
            };
        }

        JObject WriteTransmission(string file)
        {
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(file);
            TransmissionData data = TransmissionData.ReadTransmissionData(mp);
            if (data == null)
                throw new InvalidOperationException("[FMC-LINK-NOT-LOADED] TransmissionData was null for " + file + ". The file was not opened and was not written.");
            var edits = (Parameters["edits"] as JArray)?.OfType<JObject>().ToList() ?? new List<JObject>();
            int updated = 0;
            foreach (ElementId id in data.GetAllExternalFileReferenceIds().ToList())
            {
                ExternalFileReference ext = data.GetLastSavedReferenceData(id);
                if (ext == null || ext.ExternalFileReferenceType != ExternalFileReferenceType.RevitLink) continue;
                string absolute = Safe(ext.GetAbsolutePath());
                string saved = Safe(ext.GetPath());
                JObject hit = edits.FirstOrDefault(row => Matches(row, id.Value, absolute, saved));
                if (hit == null) continue;
                string to = (hit.Value<string>("to") ?? "").Trim();
                if (to.Length > 0 && FmcTarget.SamePath(to, file))
                    throw new InvalidOperationException("[FMC-LINK-SAME-FILE] Refusing to point " + file + " at itself.");
                bool load = hit.Value<bool?>("load") ?? true;
                ModelPath desired = to.Length > 0 ? ModelPathUtils.ConvertUserVisiblePathToModelPath(to) : ext.GetAbsolutePath();
                data.SetDesiredReferenceData(id, desired, ext.PathType, load);
                updated++;
            }
            if (updated == 0)
                throw new InvalidOperationException("[FMC-LINK-NOT-LOADED] No Revit link matched the edits. Nothing was written.");
            // Revit applies desired references on the next open only when the file is marked transmitted.
            data.IsTransmitted = true;
            TransmissionData.WriteTransmissionData(mp, data);
            return new JObject
            {
                ["ok"] = true,
                ["file"] = file,
                ["updated"] = updated,
                ["transmitted"] = true,
                ["opened"] = false,
                ["saved"] = false,
                ["synced"] = false,
            };
        }

        static bool Matches(JObject row, long id, string absolute, string saved)
        {
            long wanted = row.Value<long?>("id") ?? 0;
            if (wanted != 0 && wanted == id) return true;
            string from = (row.Value<string>("from") ?? "").Trim();
            if (from.Length == 0) return false;
            return Same(from, absolute) || Same(from, saved);
        }

        JObject Publish(UIApplication app)
        {
            string source = (Parameters.Value<string>("source") ?? "").Trim();
            string staging = (Parameters.Value<string>("staging") ?? "").Trim();
            string dest = (Parameters.Value<string>("dest") ?? "").Trim();
            if (source.Length == 0 || staging.Length == 0 || dest.Length == 0)
                throw new InvalidOperationException("[FMC-LINK-PROTECTED] publish needs source, staging and dest.");
            if (FmcTarget.SamePath(staging, source) || FmcTarget.SamePath(dest, source))
                throw new InvalidOperationException("[FMC-LINK-SAME-FILE] Refusing to open or write the source file.");
            FmcLinkGuard.RefuseCopyPath(dest, app, Parameters, checkHeader: true);
            FmcLinkGuard.RefuseCopyPath(staging, app, Parameters, checkHeader: false);
            if (!File.Exists(staging)) throw new InvalidOperationException("[FMC-LINK-NOT-LOADED] Staging copy not found: " + staging);
            if (!FmcLinkGuard.TryHeader(staging, out bool workshared, out _, out _, out string error))
                throw new InvalidOperationException("[FMC-LINK-NOT-LOADED] Could not read the staging copy, so it was not opened. " + error);

            string before = FmcLinkGuard.Stamp(app);
            Document opened = null;
            bool closed = false;
            void OnDialog(object sender, DialogBoxShowingEventArgs e) => FmcLinkGuard.Dismiss(e);
            app.DialogBoxShowing += OnDialog;
            try
            {
                var options = new OpenOptions { Audit = false };
                if (workshared) options.DetachFromCentralOption = DetachFromCentralOption.DetachAndDiscardWorksets;
                opened = app.Application.OpenDocumentFile(ModelPathUtils.ConvertUserVisiblePathToModelPath(staging), options);
                if (opened == null) throw new InvalidOperationException("[FMC-LINK-NOT-LOADED] Revit did not open the staging copy.");
                if (FmcLinkGuard.Stamp(app) != before)
                {
                    try { opened.Close(false); closed = true; } catch (Exception) { /* still reported below */ }
                    throw new InvalidOperationException("[FMC-LINK-ACTIVE-CHANGED] Opening the link copy changed the active document. It was closed without saving when Revit allowed it. The source was not opened. The active document was not restored.");
                }
                string dir = Path.GetDirectoryName(dest);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                if (File.Exists(dest)) File.SetAttributes(dest, FileAttributes.Normal);
                opened.SaveAs(dest, new SaveAsOptions { OverwriteExistingFile = true, MaximumBackups = 1 });
                if (FmcLinkGuard.Stamp(app) != before)
                {
                    try { opened.Close(false); closed = true; } catch (Exception) { /* reported below */ }
                    throw new InvalidOperationException("[FMC-LINK-ACTIVE-CHANGED] Saving the link copy changed the active document. It was not restored. The source was not saved.");
                }
                opened.Close(false);
                closed = true;
                try { File.SetAttributes(dest, File.GetAttributes(dest) | FileAttributes.ReadOnly); } catch (Exception) { /* the copy still exists */ }
                try { if (!FmcTarget.SamePath(staging, dest) && File.Exists(staging)) File.Delete(staging); } catch (Exception) { /* leftover staging is not the source */ }
                return new JObject
                {
                    ["ok"] = true,
                    ["dest"] = dest,
                    ["method"] = workshared ? "detach-save" : "save-as",
                    ["worksets"] = workshared ? "discarded" : "not_workshared",
                    ["opened_source"] = false,
                    ["opened_staging"] = true,
                    ["saved_source"] = false,
                    ["synced"] = false,
                    ["read_only"] = true,
                    ["identity"] = workshared ? "new-document-after-detach" : "save-as",
                };
            }
            finally
            {
                app.DialogBoxShowing -= OnDialog;
                if (opened != null && !closed) { try { opened.Close(false); } catch (Exception) { /* already closed */ } }
            }
        }

        JObject Unload(UIApplication app)
        {
            using FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
            Document doc = target.Doc;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("A family document has no Revit links.");
            if (doc.IsLinked || doc.IsDetached || FmcVerifySession.Contains(doc) || FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("unload is refused on " + doc.Title + ": a verification copy, a link, or a protected original is never changed.");
            if (doc.IsModifiable)
                throw new InvalidOperationException("A transaction is already open on " + doc.Title + ", so the link was not unloaded.");
            if (Parameters["link_type_id"] == null || Parameters["link_type_id"].Type == JTokenType.Null)
                throw new InvalidOperationException("link_type_id is required: the Revit link type's element id.");
            long id = Parameters.Value<long>("link_type_id");
            Element element = doc.GetElement(new ElementId(id));
            if (element is RevitLinkInstance instance)
                throw new InvalidOperationException("id " + id + " is a link instance. Pass its link type id (" + instance.GetTypeId().Value + ").");
            if (element is not RevitLinkType type)
                throw new InvalidOperationException("id " + id + " isn't a Revit link type.");
            type.Unload(null);
            string status;
            try { status = type.GetLinkedFileStatus().ToString(); }
            catch (Exception) { status = ""; }
            return new JObject
            {
                ["ok"] = true,
                ["link_type_id"] = id,
                ["status"] = status,
                ["unloaded"] = status == "Unloaded" || status == "NotFound",
                ["saved"] = false,
                ["synced"] = false,
                ["document"] = FmcTarget.Resolved(doc),
            };
        }

        static string Safe(ModelPath modelPath)
        {
            try { return modelPath == null ? "" : ModelPathUtils.ConvertModelPathToUserVisiblePath(modelPath); }
            catch (Exception) { return ""; }
        }

        static bool Same(string a, string b)
        {
            if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b)) return false;
            return FmcTarget.SamePath(a, b);
        }
    }
}
