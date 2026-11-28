using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The CollaborationCache guard (fmc_cloud). Revit's local cloud cache folder is never read, written, deleted or
    /// listed by a Formcraft command: a parameter naming it is refused, and a path Revit reports inside it is replaced
    /// with a marker. Nothing in fmc_cloud touches the file system at all.
    /// </summary>
    public static class FmcCloudGuard
    {
        public const string Redacted = "(inside CollaborationCache: not read)";

        public static bool Mentions(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            string s = text;
            try { s = Uri.UnescapeDataString(s); } catch (Exception) { /* keep as given */ }
            var flat = new string(s.ToLowerInvariant().Where(c => !char.IsWhiteSpace(c) && c != '_' && c != '-' && c != '.' && c != '%').ToArray());
            return flat.Contains("collaborationcache");
        }

        /// <summary>Throws when any string in the parameters names CollaborationCache.</summary>
        public static void RejectParameters(JToken token, string field = "parameters")
        {
            if (token == null) return;
            switch (token.Type)
            {
                case JTokenType.String:
                    if (Mentions(token.ToString()))
                        throw new InvalidOperationException($"[FMC-CLOUD-CACHE] Refused: {field} names the CollaborationCache folder. It is never read, written, deleted or listed.");
                    break;
                case JTokenType.Object:
                    foreach (var p in ((JObject)token).Properties())
                    {
                        if (Mentions(p.Name)) throw new InvalidOperationException($"[FMC-CLOUD-CACHE] Refused: {field}.{p.Name} names the CollaborationCache folder.");
                        RejectParameters(p.Value, field + "." + p.Name);
                    }
                    break;
                case JTokenType.Array:
                    int i = 0;
                    foreach (var t in (JArray)token) RejectParameters(t, $"{field}[{i++}]");
                    break;
            }
        }

        public static string Safe(string path) => Mentions(path) ? Redacted : (path ?? "");
    }

    /// <summary>
    /// fmc_cloud on the Revit main thread. facts and path only read: no transaction, no file opened, no file system
    /// access. save_as runs Document.SaveAsCloudModel on an open, non-workshared, non-cloud project document after the
    /// server's gate (dry run, approved_by, live-model lock). Nothing here synchronises or publishes (CLAUDE.md rule 6).
    /// </summary>
    public class FmcCloudHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                FmcCloudGuard.RejectParameters(Parameters);
                switch (Action)
                {
                    case "path": Result = CloudPath(Parameters); break;
                    case "facts":
                    {
                        using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                        Result = Facts(app, target.Doc);
                        break;
                    }
                    case "save_as":
                    {
                        using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                        Result = SaveAs(app, target.Doc, Parameters);
                        break;
                    }
                    default: Error = $"Unknown FMC cloud action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC cloud";

        private static JToken Try(Func<JToken> read)
        {
            try { return read(); }
            catch (Exception) { return JValue.CreateNull(); }
        }

        internal static JObject Facts(UIApplication app, Document doc)
        {
            bool inCloud = false;
            try { inCloud = doc.IsModelInCloud; } catch (Exception) { /* older or odd documents: not cloud */ }
            var o = new JObject
            {
                ["title"] = doc.Title,
                ["is_family"] = doc.IsFamilyDocument,
                ["is_cloud"] = inCloud,
                ["is_workshared"] = doc.IsWorkshared,
                ["is_detached"] = doc.IsDetached,
                ["is_modified"] = doc.IsModified,
                ["is_read_only"] = doc.IsReadOnly,
                ["path_name"] = FmcCloudGuard.Safe(doc.PathName),
                ["user"] = app.Application.Username ?? "",
                ["logged_in"] = Try(() => Autodesk.Revit.ApplicationServices.Application.IsLoggedIn),
            };

            var version = Try(() =>
            {
                DocumentVersion v = Document.GetDocumentVersion(doc);
                return v == null ? JValue.CreateNull() : new JObject { ["version_guid"] = v.VersionGUID.ToString(), ["number_of_saves"] = v.NumberOfSaves };
            });
            o["version"] = version;

            if (inCloud)
            {
                o["cloud"] = Try(() =>
                {
                    ModelPath mp = doc.GetCloudModelPath();
                    var c = new JObject
                    {
                        ["cloud_path"] = mp != null && mp.CloudPath,
                        ["region"] = mp == null ? "" : (mp.Region ?? ""),
                        ["project_guid"] = mp == null ? "" : mp.GetProjectGUID().ToString(),
                        ["model_guid"] = mp == null ? "" : mp.GetModelGUID().ToString(),
                        ["user_visible_path"] = mp == null ? "" : FmcCloudGuard.Safe(ModelPathUtils.ConvertModelPathToUserVisiblePath(mp)),
                    };
                    c["model_urn"] = Try(() => doc.GetCloudModelUrn() ?? "");
                    c["hub_id"] = Try(() => doc.GetHubId() ?? "");
                    c["project_id"] = Try(() => doc.GetProjectId() ?? "");
                    c["folder_id"] = Try(() => doc.GetCloudFolderId(false) ?? "");
                    return c;
                });
            }

            if (doc.IsWorkshared)
            {
                o["central"] = Try(() =>
                {
                    ModelPath central = doc.GetWorksharingCentralModelPath();
                    if (central == null) return JValue.CreateNull();
                    return new JObject
                    {
                        ["cloud"] = central.CloudPath,
                        ["path"] = FmcCloudGuard.Safe(ModelPathUtils.ConvertModelPathToUserVisiblePath(central)),
                    };
                });
            }
            return o;
        }

        private static JObject CloudPath(JObject p)
        {
            string region = (p.Value<string>("region") ?? "").Trim().ToUpperInvariant();
            string known = region == "US" ? ModelPathUtils.CloudRegionUS : region == "EMEA" ? ModelPathUtils.CloudRegionEMEA : null;
            if (known == null) throw new InvalidOperationException($"Region '{region}' is not US or EMEA.");
            if (!Guid.TryParse(p.Value<string>("project_guid") ?? "", out Guid project)) throw new InvalidOperationException("project_guid is not a GUID.");
            if (!Guid.TryParse(p.Value<string>("model_guid") ?? "", out Guid model)) throw new InvalidOperationException("model_guid is not a GUID.");
            ModelPath mp = ModelPathUtils.ConvertCloudGUIDsToCloudPath(known, project, model);
            return new JObject
            {
                ["region"] = known,
                ["project_guid"] = project.ToString(),
                ["model_guid"] = model.ToString(),
                ["cloud_path"] = mp != null && mp.CloudPath,
                ["user_visible_path"] = mp == null ? "" : FmcCloudGuard.Safe(ModelPathUtils.ConvertModelPathToUserVisiblePath(mp)),
                ["opened"] = false,
            };
        }

        private static JObject SaveAs(UIApplication app, Document doc, JObject p)
        {
            string approvedBy = (p.Value<string>("approved_by") ?? "").Trim();
            if (approvedBy.Length < 2) throw new InvalidOperationException("[FMC-CLOUD-APPROVAL] approved_by is required for a real cloud write.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("A family is not saved to Autodesk Docs by this tool.");
            if (doc.IsModelInCloud) throw new InvalidOperationException("This model is already a cloud model.");
            if (doc.IsWorkshared) throw new InvalidOperationException("Workshared models are saved and synced by a person in Revit (rule 6).");
            if (doc.IsReadOnly) throw new InvalidOperationException("This document is read-only.");
            if (!Guid.TryParse(p.Value<string>("account_id") ?? "", out Guid account)) throw new InvalidOperationException("account_id is not a GUID.");
            if (!Guid.TryParse(p.Value<string>("project_id") ?? "", out Guid project)) throw new InvalidOperationException("project_id is not a GUID.");
            string folder = (p.Value<string>("folder_id") ?? "").Trim();
            string name = (p.Value<string>("model_name") ?? "").Trim();
            if (folder.Length == 0 || name.Length == 0) throw new InvalidOperationException("folder_id and model_name are required.");
            string title = doc.Title;
            doc.SaveAsCloudModel(account, project, folder, name);
            var after = Facts(app, doc);
            return new JObject { ["saved_as_cloud"] = true, ["document_before"] = title, ["model_name"] = name, ["approved_by"] = approvedBy, ["after"] = after };
        }
    }
}
