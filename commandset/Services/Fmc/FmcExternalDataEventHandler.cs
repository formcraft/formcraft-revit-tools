using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExternalService;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_external_data on the Revit main thread: what the open document pulls in from outside (Manage Links), read-only.
    /// external_files is ExternalFileUtils (Revit links, CAD links, keynote and assembly code tables, decals, systems analysis
    /// report: type, path kind, load state, path). external_resources is ExternalResourceUtils (elements whose data comes from an
    /// external resource server, with the server, version and display path). servers lists the registered external resource
    /// servers. It never opens a transaction, loads, reloads, unloads or repaths anything. R25 has no External Data Manager
    /// (IExternalDataManagerServer) and no Extended Properties: those are Revit 2027 API, so this reads what R25 can.
    /// Values that look like a credential are replaced by "[redacted]" here, before they leave Revit.
    /// </summary>
    public class FmcExternalDataEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

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
                // Never opens a closed file: a read of the open document only.
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("External data is read from a project model.");
                Result = Read(doc, Parameters.Value<bool?>("check_versions") == true);
                Result["resolved_document"] = FmcTarget.Resolved(doc);
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

        public string GetName() => "FMC external data";

        /// <summary>A key whose value is never reported.</summary>
        private static readonly Regex SecretKey = new Regex("token|secret|passw|pwd|credential|signature|bearer|cookie|api[_-]?key|access[_-]?key|private[_-]?key|authoriz|^auth|[_-]auth|^sig$|^sas$", RegexOptions.IgnoreCase);
        /// <summary>A value shaped like a token: a JWT, a long unbroken base64/hex run, or a URL carrying credentials.</summary>
        private static readonly Regex SecretValue = new Regex(@"^eyJ[\w-]+\.[\w-]+\.[\w-]*$|^[A-Za-z0-9+/=_-]{40,}$", RegexOptions.Compiled);

        internal static string RedactValue(string key, string value)
        {
            if (value == null) return "";
            if (SecretKey.IsMatch(key ?? "")) return "[redacted]";
            if (SecretValue.IsMatch(value)) return "[redacted]";
            return StripUrl(value);
        }

        /// <summary>A URL loses user:password@ and its ?query and #fragment; anything else is returned as it is.</summary>
        internal static string StripUrl(string value)
        {
            if (value.IndexOf("://", StringComparison.Ordinal) < 0) return value;
            string v = value;
            int q = v.IndexOfAny(new[] { '?', '#' });
            if (q >= 0) v = v.Substring(0, q) + "?[redacted]";
            int scheme = v.IndexOf("://", StringComparison.Ordinal);
            int at = v.IndexOf('@', scheme + 3);
            int slash = v.IndexOf('/', scheme + 3);
            if (at > 0 && (slash < 0 || at < slash)) v = v.Substring(0, scheme + 3) + v.Substring(at + 1);
            return v;
        }

        private static string Visible(ModelPath p)
        {
            try { return p == null ? "" : StripUrl(ModelPathUtils.ConvertModelPathToUserVisiblePath(p)); }
            catch { return ""; }
        }

        private static Dictionary<Guid, string> BuiltInTypeNames()
        {
            var map = new Dictionary<Guid, string>();
            foreach (PropertyInfo p in typeof(ExternalResourceTypes.BuiltInExternalResourceTypes).GetProperties(BindingFlags.Public | BindingFlags.Static))
            {
                try { if (p.GetValue(null) is ExternalResourceType t) map[t.Guid] = p.Name; }
                catch { /* a type that can't be read stays a guid */ }
            }
            return map;
        }

        internal static JObject Read(Document doc, bool checkVersions)
        {
            var warnings = new JArray();
            var files = new JArray();
            try
            {
                foreach (ElementId id in ExternalFileUtils.GetAllExternalFileReferences(doc))
                {
                    var row = new JObject { ["element_id"] = id.GetValue() };
                    try
                    {
                        Element e = doc.GetElement(id);
                        row["name"] = e?.Name ?? "";
                        ExternalFileReference r = ExternalFileUtils.GetExternalFileReference(doc, id);
                        row["type"] = r.ExternalFileReferenceType.ToString();
                        row["path_type"] = r.PathType.ToString();
                        row["status"] = r.GetLinkedFileStatus().ToString();
                        ModelPath abs = r.GetAbsolutePath();
                        row["path"] = Visible(abs);
                        row["stored_path"] = Visible(r.GetPath());
                        row["cloud"] = abs != null && abs.CloudPath;
                        row["server_path"] = abs != null && abs.ServerPath;
                        if (e is RevitLinkType lt) row["attachment"] = lt.AttachmentType.ToString();
                    }
                    catch (Exception ex) { row["error"] = ex.Message; }
                    files.Add(row);
                }
            }
            catch (Exception ex) { warnings.Add("external files: " + ex.Message); }

            var serverNames = new Dictionary<Guid, string>();
            var servers = new JArray();
            try
            {
                var service = ExternalServiceRegistry.GetService(ExternalServices.BuiltInExternalServices.ExternalResourceService) as MultiServerService;
                if (service != null)
                {
                    foreach (Guid sid in service.GetRegisteredServerIds())
                    {
                        var row = new JObject { ["server_id"] = sid.ToString() };
                        try
                        {
                            IExternalServer s = service.GetServer(sid);
                            serverNames[sid] = s?.GetName() ?? "";
                            row["name"] = s?.GetName() ?? "";
                            row["vendor"] = s?.GetVendorId() ?? "";
                            row["description"] = s?.GetDescription() ?? "";
                            row["active"] = service.GetActiveServerIds().Contains(sid);
                        }
                        catch (Exception ex) { row["error"] = ex.Message; }
                        servers.Add(row);
                    }
                }
            }
            catch (Exception ex) { warnings.Add("servers: " + ex.Message); }

            var typeNames = BuiltInTypeNames();
            var resources = new JArray();
            try
            {
                foreach (ElementId id in ExternalResourceUtils.GetAllExternalResourceReferences(doc))
                {
                    Element e = doc.GetElement(id);
                    if (e == null) continue;
                    IDictionary<ExternalResourceType, ExternalResourceReference> refs;
                    try { refs = e.GetExternalResourceReferences(); }
                    catch (Exception ex) { resources.Add(new JObject { ["element_id"] = id.GetValue(), ["error"] = ex.Message }); continue; }
                    foreach (var pair in refs)
                    {
                        var row = new JObject { ["element_id"] = id.GetValue(), ["element"] = e.Name ?? "", ["element_class"] = e.GetType().Name };
                        try
                        {
                            ExternalResourceReference r = pair.Value;
                            row["resource_type"] = typeNames.TryGetValue(pair.Key.Guid, out string tn) ? tn : pair.Key.Guid.ToString();
                            row["server_id"] = r.ServerId.ToString();
                            row["server"] = serverNames.TryGetValue(r.ServerId, out string sn) ? sn : "";
                            row["version"] = r.Version ?? "";
                            row["in_session_path"] = StripUrl(r.InSessionPath ?? "");
                            try { row["display_name"] = r.GetResourceShortDisplayName(); } catch { row["display_name"] = ""; }
                            // GetResourceVersionStatus asks the resource's server, which may reach out, so it is opt-in.
                            row["version_status"] = checkVersions ? VersionStatus(r) : "not checked";
                            var info = new JObject();
                            foreach (var kv in r.GetReferenceInformation()) info[kv.Key] = RedactValue(kv.Key, kv.Value);
                            row["reference_info"] = info;
                        }
                        catch (Exception ex) { row["error"] = ex.Message; }
                        resources.Add(row);
                    }
                }
            }
            catch (Exception ex) { warnings.Add("external resources: " + ex.Message); }

            return new JObject
            {
                ["model"] = doc.Title,
                ["revit"] = doc.Application.VersionNumber,
                ["external_files"] = files,
                ["external_resources"] = resources,
                ["servers"] = servers,
                ["warnings"] = warnings,
                ["read_only"] = true,
            };
        }

        private static string VersionStatus(ExternalResourceReference r)
        {
            try { return r.GetResourceVersionStatus().ToString(); }
            catch (Exception ex) { return "unknown (" + ex.Message + ")"; }
        }
    }
}