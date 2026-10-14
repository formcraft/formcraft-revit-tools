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
            string key = (parameters?.Value<string>("document") ?? "").Trim();
            Document active = app.ActiveUIDocument?.Document;
            var open = new List<Document>();
            foreach (Document d in app.Application.Documents) if (!d.IsLinked) open.Add(d);

            if (key.Length > 0)
            {
                Document found = open.FirstOrDefault(d => Same(d, key));
                if (found != null) return new FmcTarget(found, active != null && found.Equals(active) ? app.ActiveUIDocument : null, false);
                if (!LooksLikeFile(key))
                    throw new InvalidOperationException($"No open document is called \"{key}\". Open: {List(open)}.");
                if (!mayOpen)
                    throw new InvalidOperationException($"{Path.GetFileName(key)} isn't open. Changes go only to documents already open: open it first (in the background is fine).");
                if (!File.Exists(key)) throw new InvalidOperationException($"File not found: {key}");
                return new FmcTarget(OpenInBackground(app, key), null, true);
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

        private static Document OpenInBackground(UIApplication app, string path)
        {
            ModelPath mp = ModelPathUtils.ConvertUserVisiblePathToModelPath(path);
            var options = new OpenOptions { Audit = false };
            bool workshared = false;
            try { workshared = BasicFileInfo.Extract(path).IsWorkshared; } catch (Exception) { /* not a project file */ }
            if (workshared) options.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
            return app.Application.OpenDocumentFile(mp, options);
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
