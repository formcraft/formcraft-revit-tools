using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The document a Formcraft command works on (issue #85, phase 0): the call's <c>document</c> (a title or full path)
    /// when it names one, else the active document, else the only open one. The tester works in the background while the
    /// owner keeps the screen, so a command never needs its document to be the active one.
    /// <para>A read-only command may open a closed file itself: in the background, detached (worksets kept) if it is
    /// workshared, never activated, and closed again without saving when the command ends. Model-changing commands only
    /// work on documents already open, so the live-model lock has always checked the document they change.</para>
    /// </summary>
    public sealed class FmcTarget : IDisposable
    {
        public Document Doc { get; }
        /// <summary>The UI document when the target is the active one; null in the background (no view, no selection).</summary>
        public UIDocument Ui { get; }
        /// <summary>True when this command opened the file and will close it.</summary>
        public bool OpenedHere { get; }

        private FmcTarget(Document doc, UIDocument ui, bool openedHere) { Doc = doc; Ui = ui; OpenedHere = openedHere; }

        public static FmcTarget Resolve(UIApplication app, JObject parameters, bool mayOpen)
        {
            // F-030/F-032: the AI job starts here for every Formcraft handler (default failures handling, the save
            // reminder kept from blocking, a cancel honoured before any work). See commandset/Bridge/FmcAiJob.cs.
            RevitMCPCommandSet.Bridge.FmcAiJob.Enter(app, RevitMCPCommandSet.Bridge.FmcAiJob.JobOf(parameters));
            string key = (parameters?.Value<string>("document") ?? "").Trim();
            Document active = app.ActiveUIDocument?.Document;
            var open = new List<Document>();
            foreach (Document d in app.Application.Documents) if (!d.IsLinked) open.Add(d);

            if (key.Length > 0)
            {
                var found = open.Where(d => Same(d, key)).ToList();
                string activeName = active?.Title ?? "none";
                if (found.Count > 1)
                    throw new InvalidOperationException($"More than one open document matches \"{key}\" ({string.Join("; ", found.Select(d => string.IsNullOrEmpty(d.PathName) ? d.Title : d.PathName))}). Pass the full path. Refusing to use the active document ({activeName}).");
                if (found.Count == 1) return new FmcTarget(found[0], active != null && found[0].Equals(active) ? app.ActiveUIDocument : null, false);
                // A named document that is not open is never replaced with the active one.
                if (!LooksLikeFile(key))
                    throw new InvalidOperationException($"No open document is called \"{key}\". Open: {List(open)}. Refusing to use the active document ({activeName}).");
                if (!mayOpen)
                    throw new InvalidOperationException($"{Path.GetFileName(key)} isn't open. Refusing to use the active document ({activeName}).");
                if (IsProtected(key, Roots(parameters)))
                    throw new InvalidOperationException($"Refusing to open {key}: it is under a protected original. Refusing to use the active document ({activeName}).");
                if (IsCloud(key))
                    throw new InvalidOperationException($"Refusing to open {key}: cloud and Revit Server models are not opened in the background.");
                if (!File.Exists(key)) throw new InvalidOperationException($"File not found: {key}. Refusing to use the active document ({activeName}).");
                return new FmcTarget(OpenInBackground(app, key, parameters), null, true);
            }
            if (active != null) return new FmcTarget(active, app.ActiveUIDocument, false);
            if (open.Count == 1) return new FmcTarget(open[0], null, false);
            throw new InvalidOperationException(open.Count == 0
                ? "No document is open in Revit. Open one (the workbench _Staging\\FMC_Claude_Workbench.rvt is fine), or pass document with a file path."
                : $"{open.Count} documents are open and none is active: pass document with one of {List(open)}.");
        }

        /// <summary>The UI document, for commands that need the active view or the selection.</summary>
        public UIDocument RequireUi(string what)
        {
            if (Ui != null) return Ui;
            throw new InvalidOperationException($"{what} needs {Doc.Title} to be the active document (it works on the view or the selection). It is open in the background.");
        }

        public void Dispose()
        {
            // Never saved: a file opened here was only read.
            if (OpenedHere) { try { Doc.Close(false); } catch (Exception) { /* Revit closes it with the session */ } }
        }

        private static Document OpenInBackground(UIApplication app, string path, JObject parameters)
        {
            if (IsProtected(path, Roots(parameters)))
                throw new InvalidOperationException($"Refusing to open {path}: it is under a protected original.");
            if (IsCloud(path))
                throw new InvalidOperationException("Cloud and Revit Server models are not opened in the background.");
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(path);
            var options = new OpenOptions { Audit = false };
            bool workshared = false;
            try { workshared = BasicFileInfo.Extract(path).IsWorkshared; } catch (Exception) { /* not a project file */ }
            if (workshared) options.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
            return app.Application.OpenDocumentFile(mp, options);
        }

        public static List<string> Roots(JObject parameters)
        {
            var list = new List<string>();
            void Take(JToken token)
            {
                if (token is JArray array)
                    foreach (JToken item in array)
                        if (item.Type == JTokenType.String && !string.IsNullOrWhiteSpace(item.ToString())) list.Add(item.ToString());
            }
            Take(parameters?["_protected_roots"]);
            Take(parameters?["protected_roots"]);
            return list;
        }

        public static bool IsProtected(string path, IEnumerable<string> roots)
        {
            if (string.IsNullOrWhiteSpace(path) || roots == null) return false;
            foreach (string root in roots)
                if (!string.IsNullOrWhiteSpace(root) && (SamePath(path, root) || path.StartsWith(root.TrimEnd('\\', '/') + "\\", StringComparison.OrdinalIgnoreCase) || path.StartsWith(root.TrimEnd('\\', '/') + "/", StringComparison.OrdinalIgnoreCase)))
                    return true;
            return false;
        }

        public static bool IsCloud(string path)
        {
            string s = (path ?? "").Trim();
            if (s.StartsWith("BIM 360:", StringComparison.OrdinalIgnoreCase)) return true;
            if (s.StartsWith("Autodesk Docs:", StringComparison.OrdinalIgnoreCase)) return true;
            if (s.StartsWith("Revit Server:", StringComparison.OrdinalIgnoreCase)) return true;
            if (s.StartsWith("RSN:", StringComparison.OrdinalIgnoreCase)) return true;
            bool local = s.Length >= 3 && char.IsLetter(s[0]) && s[1] == ':';
            return !(local || s.StartsWith("\\\\"));
        }

        public static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        }

        /// <summary>Path, detach, link and read-only flags for a result. is_active is filled by the caller.</summary>
        public static JObject DescribeState(Document doc)
        {
            return new JObject
            {
                ["title"] = doc?.Title ?? "",
                ["path"] = doc?.PathName ?? "",
                ["is_detached"] = doc?.IsDetached ?? false,
                ["is_workshared"] = doc?.IsWorkshared ?? false,
                ["is_linked"] = doc?.IsLinked ?? false,
                ["is_modified"] = doc?.IsModified ?? false,
                ["read_only"] = doc != null && (doc.IsLinked || doc.IsDetached || FmcVerifySession.Contains(doc)),
            };
        }

        public static bool Same(Document d, string key)
        {
            if (string.Equals(d.Title, key, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(Path.GetFileNameWithoutExtension(d.PathName ?? ""), key, StringComparison.OrdinalIgnoreCase) && !key.Contains("\\")) return true;
            if (string.IsNullOrEmpty(d.PathName) || !LooksLikeFile(key)) return false;
            try { return string.Equals(Path.GetFullPath(d.PathName), Path.GetFullPath(key), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return false; }
        }

        private static bool LooksLikeFile(string key) =>
            (key.Contains("\\") || key.Contains("/")) && new[] { ".rvt", ".rfa", ".rte", ".rft" }.Contains(Path.GetExtension(key).ToLowerInvariant());

        private static string List(List<Document> docs) => docs.Count == 0 ? "none" : string.Join(", ", docs.Select(d => "\"" + d.Title + "\""));
    }
}
