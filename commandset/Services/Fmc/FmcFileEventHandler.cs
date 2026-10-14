using System.Collections.Generic;
using System.IO;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using Directory = System.IO.Directory;
using File = System.IO.File;
using Path = System.IO.Path;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Runs Formcraft file operations on the Revit main thread.
    /// Path and name rules are enforced by the MCP server (server/src/fmc/policy.ts) before a request
    /// arrives here. This handler adds the checks only Revit can make: workshared models are never
    /// saved by a tool, and the active document is never closed.
    /// </summary>
    public class FmcFileEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                switch (Action)
                {
                    case "info": Result = Info(app, Parameters?.Value<string>("document")); break;
                    case "create": Result = Create(app); break;
                    case "save_as": Result = SaveAs(app); break;
                    case "close": Result = Close(app); break;
                    default: Error = $"Unknown FMC file action '{Action}'"; break;
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

        public string GetName() => "FMC file operation";

        private static JObject Describe(Document d, Document active)
        {
            return new JObject
            {
                ["title"] = d.Title,
                ["path"] = d.PathName ?? "",
                ["isFamily"] = d.IsFamilyDocument,
                ["isWorkshared"] = d.IsWorkshared,
                ["isModified"] = d.IsModified,
                ["isActive"] = active != null && d.Equals(active),
                // A person's local copy of a workshared model (not the central): the only workshared file the
                // AI-assisted modeller may change. Null when it isn't workshared.
                ["isLocal"] = d.IsWorkshared ? (JToken)IsLocalCopy(d) : null,
            };
        }

        private static bool IsLocalCopy(Document d)
        {
            try
            {
                if (d.IsDetached) return false;
                ModelPath central = d.GetWorksharingCentralModelPath();
                if (central == null) return false;
                string c = ModelPathUtils.ConvertModelPathToUserVisiblePath(central);
                return !string.IsNullOrEmpty(d.PathName) && !string.Equals(Path.GetFullPath(c), Path.GetFullPath(d.PathName), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; } // unknown counts as central: AI stays out
        }

        /// <summary>
        /// The open documents, and "active": the document the call works on. With a document target (issue #85) that is
        /// the named document, open in the background or not, so the live-model lock checks the document a change goes
        /// to, never just whichever is on screen. A named file that isn't open is described from the file itself.
        /// </summary>
        private static JObject Info(UIApplication app, string target)
        {
            Document active = app.ActiveUIDocument?.Document;
            var docs = new JArray();
            Document named = null;
            target = (target ?? "").Trim();
            foreach (Document d in app.Application.Documents)
            {
                if (d.IsLinked) continue;
                docs.Add(Describe(d, active));
                if (target.Length > 0 && named == null && FmcTarget.Same(d, target)) named = d;
            }
            JObject subject = target.Length == 0 ? (active != null ? Describe(active, active) : null)
                : named != null ? Describe(named, active)
                : File.Exists(target) ? FromFile(target) : null;
            return new JObject
            {
                ["active"] = subject,
                ["target"] = target.Length > 0 ? target : null,
                ["documents"] = docs,
                ["revitVersion"] = app.Application.VersionNumber,
            };
        }

        private static JObject FromFile(string path)
        {
            bool workshared = false;
            try { workshared = BasicFileInfo.Extract(path).IsWorkshared; } catch (Exception) { /* not a project file */ }
            return new JObject
            {
                ["title"] = Path.GetFileName(path), ["path"] = path,
                ["isFamily"] = string.Equals(Path.GetExtension(path), ".rfa", StringComparison.OrdinalIgnoreCase),
                ["isWorkshared"] = workshared, ["isActive"] = false, ["open"] = false,
            };
        }

        private static Document Find(UIApplication app, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("document is required");
            foreach (Document d in app.Application.Documents)
            {
                if (d.IsLinked) continue;
                if (string.Equals(d.Title, key, StringComparison.OrdinalIgnoreCase)) return d;
                if (!string.IsNullOrEmpty(d.PathName) &&
                    string.Equals(Path.GetFullPath(d.PathName), Path.GetFullPath(key), StringComparison.OrdinalIgnoreCase)) return d;
            }
            throw new InvalidOperationException($"Document not open: {key}");
        }

        private SaveAsOptions Options()
        {
            return new SaveAsOptions
            {
                OverwriteExistingFile = Parameters["overwrite"]?.Value<bool>() ?? false,
                MaximumBackups = Math.Max(1, Parameters["max_backups"]?.Value<int>() ?? 3),
            };
        }

        private JObject Create(UIApplication app)
        {
            string kind = Parameters["kind"]?.Value<string>() ?? "";
            string template = Parameters["template_path"]?.Value<string>() ?? "";
            string target = Parameters["save_path"]?.Value<string>() ?? "";
            bool closeAfter = Parameters["close_after"]?.Value<bool>() ?? true;
            if (!File.Exists(template)) throw new System.IO.FileNotFoundException($"Template not found: {template}");
            if (string.IsNullOrWhiteSpace(target)) throw new ArgumentException("save_path is required");

            Document doc;
            switch (kind)
            {
                case "family": doc = app.Application.NewFamilyDocument(template); break;
                case "project": doc = app.Application.NewProjectDocument(template); break;
                case "template": doc = app.Application.NewProjectTemplateDocument(template); break;
                default: throw new ArgumentException($"kind must be family, project or template, got '{kind}'");
            }
            if (doc == null) throw new InvalidOperationException($"Revit could not create a {kind} from {template}");

            // Project start (fmc_project): Project Information is typed once in the pane and written into each new model.
            var missing = new JArray();
            if (kind == "project" && Parameters["project_info"] is JObject info && info.Count > 0)
                foreach (string name in SetProjectInfo(doc, info)) missing.Add(name);

            Directory.CreateDirectory(Path.GetDirectoryName(target));
            doc.SaveAs(target, Options());
            string title = doc.Title;
            bool closed = false;
            if (closeAfter) closed = doc.Close(false);
            return new JObject { ["created"] = target, ["title"] = title, ["kind"] = kind, ["closed"] = closed, ["projectInfoMissing"] = missing };
        }

        /// <summary>
        /// Writes Project Information into a new model: Revit's own fields (Project Name, Number, Client Name, Address,
        /// Status) and any other text parameter on Project Information by name (the kit's FMC_ parameters, where the
        /// template has them). Returns the names the template doesn't have.
        /// </summary>
        private static List<string> SetProjectInfo(Document doc, JObject info)
        {
            var missing = new List<string>();
            using (var t = new Transaction(doc, "Formcraft: Project Information"))
            {
                t.Start();
                ProjectInfo p = doc.ProjectInformation;
                foreach (var prop in info.Properties())
                {
                    string value = prop.Value?.ToString() ?? "";
                    switch (prop.Name)
                    {
                        case "Project Name": p.Name = value; continue;
                        case "Project Number": p.Number = value; continue;
                        case "Client Name": p.ClientName = value; continue;
                        case "Project Address": p.Address = value; continue;
                        case "Project Status": p.Status = value; continue;
                    }
                    Parameter param = p.LookupParameter(prop.Name);
                    if (param != null && !param.IsReadOnly && param.StorageType == StorageType.String) param.Set(value);
                    else missing.Add(prop.Name);
                }
                t.Commit();
            }
            return missing;
        }

        private JObject SaveAs(UIApplication app)
        {
            Document doc = Find(app, Parameters["document"]?.Value<string>());
            string target = Parameters["save_path"]?.Value<string>() ?? "";
            if (doc.IsWorkshared)
                throw new InvalidOperationException(
                    $"{doc.Title} is workshared. Tools never save workshared models: synchronise with central in Revit (Manual 7.2).");
            if (string.IsNullOrWhiteSpace(target)) throw new ArgumentException("save_path is required");
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            string before = doc.PathName ?? "";
            doc.SaveAs(target, Options());
            return new JObject { ["saved"] = target, ["previousPath"] = before, ["title"] = doc.Title };
        }

        private JObject Close(UIApplication app)
        {
            Document doc = Find(app, Parameters["document"]?.Value<string>());
            bool save = Parameters["save"]?.Value<bool>() ?? false;
            Document active = app.ActiveUIDocument?.Document;
            if (active != null && doc.Equals(active))
                throw new InvalidOperationException(
                    $"{doc.Title} is the active document. The Revit API cannot close it: switch to another view or document first.");
            if (save && doc.IsWorkshared)
                throw new InvalidOperationException($"{doc.Title} is workshared. Synchronise with central in Revit instead of saving.");
            string title = doc.Title;
            bool closed = doc.Close(save);
            return new JObject { ["closed"] = closed, ["title"] = title, ["saved"] = save };
        }
    }
}
