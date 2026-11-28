using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Lists, opens and closes documents on Revit's API thread.
    /// A workshared central is opened as a new local. A save never touches a protected title.
    /// </summary>
    public class FmcDocsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return RevitMCPCommandSet.FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft documents";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string action = (Parameters.Value<string>("action") ?? "list").Trim().ToLowerInvariant();
                if (action == "probe") Result = Probe(Parameters.Value<string>("path") ?? "");
                else if (action == "open") Result = Open(app);
                else if (action == "close") Result = Close(app);
                else Result = List(app);
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject List(UIApplication app)
        {
            var docs = new JArray();
            Document active = app.ActiveUIDocument?.Document;
            foreach (Document doc in app.Application.Documents)
            {
                if (doc.IsLinked) continue;
                docs.Add(Describe(doc, active));
            }
            return new JObject { ["documents"] = docs, ["count"] = docs.Count, ["read_only"] = true };
        }

        private static JObject Describe(Document doc, Document active)
        {
            bool central = false;
            try
            {
                if (doc.IsWorkshared && !string.IsNullOrEmpty(doc.PathName))
                {
                    string path = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                    central = !string.IsNullOrEmpty(path) && string.Equals(Path.GetFullPath(path), Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (Exception) { central = false; }
            return new JObject
            {
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["family"] = doc.IsFamilyDocument,
                ["workshared"] = doc.IsWorkshared,
                ["active"] = active != null && doc.Equals(active),
                ["modified"] = doc.IsModified,
                ["central"] = central,
                ["detached"] = doc.IsDetached,
            };
        }

        private static JObject Probe(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return new JObject { ["exists"] = false, ["workshared"] = false, ["central"] = false };
            var info = BasicFileInfo.Extract(path);
            // Same rule as open_local (FmcOpenLocal.IsCentralFile): a local is never central, whatever IsCentral says.
            bool central = FmcOpenLocal.IsCentralFile(info, path);
            return new JObject { ["exists"] = true, ["workshared"] = info.IsWorkshared, ["central"] = central, ["read_only"] = true };
        }

        private JObject Open(UIApplication app)
        {
            string path = Parameters.Value<string>("path") ?? "";
            if (!File.Exists(path)) throw new InvalidOperationException("The file was not found: " + path);
            bool detach = Parameters.Value<bool?>("detach") ?? false;
            bool asLocal = Parameters.Value<bool?>("as_local") ?? true;
            string worksets = (Parameters.Value<string>("worksets") ?? "all").Trim().ToLowerInvariant();
            string local = Parameters.Value<string>("local_path") ?? "";
            var info = BasicFileInfo.Extract(path);
            bool central = FmcOpenLocal.IsCentralFile(info, path);
            string openPath = path;
            if (info.IsWorkshared && central && asLocal && !detach)
            {
                if (string.IsNullOrWhiteSpace(local))
                {
                    string name = Path.GetFileNameWithoutExtension(path);
                    if (!name.EndsWith("_USER", StringComparison.OrdinalIgnoreCase)) name += "_USER";
                    local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), name + ".rvt");
                }
                if (!File.Exists(local))
                {
                    WorksharingUtils.CreateNewLocal(
                        ModelPathUtils.ConvertUserVisiblePathToModelPath(path),
                        ModelPathUtils.ConvertUserVisiblePathToModelPath(local));
                }
                openPath = local;
            }
            var options = new OpenOptions();
            if (detach && info.IsWorkshared)
                options.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
            else
                options.DetachFromCentralOption = DetachFromCentralOption.DoNotDetach;
            var configuration = worksets == "last" ? WorksetConfigurationOption.OpenLastViewed : WorksetConfigurationOption.OpenAllWorksets;
            if (info.IsWorkshared) options.SetOpenWorksetsConfiguration(new WorksetConfiguration(configuration));
            Document opened = app.Application.OpenDocumentFile(ModelPathUtils.ConvertUserVisiblePathToModelPath(openPath), options);
            return new JObject
            {
                ["opened"] = true,
                ["title"] = opened.Title ?? "",
                ["path"] = opened.PathName ?? openPath,
                ["as_local"] = openPath != path,
                ["detach"] = opened.IsDetached,
                ["saved"] = false,
            };
        }

        private JObject Close(UIApplication app)
        {
            string key = (Parameters.Value<string>("document") ?? "").Trim();
            bool save = Parameters.Value<bool?>("save") ?? false;
            var open = new List<Document>();
            foreach (Document doc in app.Application.Documents) if (!doc.IsLinked) open.Add(doc);
            if (open.Count <= 1) throw new InvalidOperationException("The last open document is never closed.");
            Document hit = open.FirstOrDefault(doc => Same(doc, key));
            if (hit == null) throw new InvalidOperationException("No open document matches " + key + ".");
            if (hit.IsModified && !save) throw new InvalidOperationException("The document is modified. close refuses it unless save is true.");
            if (save)
            {
                string blob = (hit.Title ?? "") + " " + (hit.PathName ?? "");
                if (blob.IndexOf("hebert hostels", StringComparison.OrdinalIgnoreCase) >= 0)
                    throw new InvalidOperationException("HEBERT HOSTELS_USER is never saved.");
                if (hit.IsWorkshared) throw new InvalidOperationException("A workshared model is not saved by a tool.");
                var roots = Parameters["protected_roots"] as JArray ?? new JArray();
                foreach (JToken root in roots)
                {
                    string prefix = (root?.ToString() ?? "").Trim();
                    if (prefix.Length == 0 || string.IsNullOrEmpty(hit.PathName)) continue;
                    if (hit.PathName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("The path is under a protected root. It was not saved.");
                }
                hit.Save();
            }
            string title = hit.Title ?? "";
            hit.Close(false);
            return new JObject { ["closed"] = true, ["title"] = title, ["saved"] = save };
        }

        private static bool Same(Document doc, string key)
        {
            if (string.IsNullOrEmpty(key)) return false;
            if (string.Equals(doc.Title, key, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.IsNullOrEmpty(doc.PathName)) return false;
            try { return string.Equals(Path.GetFullPath(doc.PathName), Path.GetFullPath(key), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return string.Equals(doc.PathName, key, StringComparison.OrdinalIgnoreCase); }
        }
    }
}
