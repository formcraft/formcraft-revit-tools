using System;
using System.IO;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// PNG export that does not leave another document on screen.
    /// ExportImage with SetOfViews is not supposed to switch the window. In Revit 2025 it still can:
    /// a screenshot of a background model has made that model the active document. The call is wrapped
    /// so the document and view that were active before the export are put back afterwards.
    /// Pictures go to %LOCALAPPDATA%\Formcraft\images, never beside the model and never on D:.
    /// </summary>
    internal static class FmcImageExport
    {
        internal static string Folder(string requested, Document doc)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string preferred = Path.Combine(local, "Formcraft", "images");
            string agent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "agent-tools", "images");
            string dir = string.IsNullOrWhiteSpace(requested) ? preferred : requested.Trim();
            if (OnD(dir) || BesideModel(dir, doc)) dir = preferred;
            if (OnD(dir)) dir = agent;
            if (OnD(dir)) dir = @"C:\Users\Public\agent-tools\images";
            Directory.CreateDirectory(dir);
            return dir;
        }

        /// <summary>The document and view on screen before a picture is taken.</summary>
        internal static Shot Capture(UIApplication app) => Shot.Take(app);

        /// <summary>Write the PNG. Does not touch the active window. Call PutBack after any transaction has closed.</summary>
        internal static void Write(Document doc, ImageExportOptions options) => doc.ExportImage(options);

        /// <summary>Put the captured document and view back. Safe only when no transaction phase is open.</summary>
        internal static void PutBack(UIApplication app, Shot prior) => prior?.Restore(app);

        /// <summary>SEE-2: before/after active document and view, read after PutBack.</summary>
        internal static Newtonsoft.Json.Linq.JObject RestoreReport(UIApplication app, Shot prior) => prior?.Report(app);

        internal static void Export(UIApplication app, Document doc, ImageExportOptions options)
        {
            Shot prior = Shot.Take(app);
            try { doc.ExportImage(options); }
            finally { prior.Restore(app); }
        }

        private static bool OnD(string path) =>
            path.Length >= 2 && (path[0] == 'D' || path[0] == 'd') && path[1] == ':';

        private static bool BesideModel(string dir, Document doc)
        {
            string model = doc?.PathName;
            if (string.IsNullOrEmpty(model)) return false;
            string parent = Path.GetDirectoryName(model) ?? "";
            if (parent.Length == 0) return false;
            string left = dir.TrimEnd('\\', '/');
            string right = parent.TrimEnd('\\', '/');
            return left.Equals(right, StringComparison.OrdinalIgnoreCase)
                || left.StartsWith(right + "\\", StringComparison.OrdinalIgnoreCase)
                || left.StartsWith(right + "/", StringComparison.OrdinalIgnoreCase);
        }

        internal sealed class Shot
        {
            private readonly Document _doc;
            private readonly string _path;
            private readonly ElementId _view;

            private Shot(Document doc, string path, ElementId view) { _doc = doc; _path = path; _view = view; }

            internal static Shot Take(UIApplication app)
            {
                UIDocument ui = app?.ActiveUIDocument;
                Document doc = ui?.Document;
                ElementId view = null;
                try { view = ui?.ActiveView?.Id; } catch (Exception) { view = null; }
                return new Shot(doc, doc?.PathName ?? "", view);
            }

            /// <summary>SEE-2: what was active before the picture and what is active now, so a caller can confirm the restore.</summary>
            internal Newtonsoft.Json.Linq.JObject Report(UIApplication app)
            {
                var r = new Newtonsoft.Json.Linq.JObject
                {
                    ["before_document"] = _doc?.Title,
                    ["before_view_id"] = _view == null ? null : (Newtonsoft.Json.Linq.JToken)_view.Value,
                };
                try
                {
                    UIDocument now = app?.ActiveUIDocument;
                    ElementId nowView = null;
                    try { nowView = now?.ActiveView?.Id; } catch (Exception) { nowView = null; }
                    r["after_document"] = now?.Document?.Title;
                    r["after_view_id"] = nowView == null ? null : (Newtonsoft.Json.Linq.JToken)nowView.Value;
                    bool sameDoc = _doc == null || (now?.Document != null && _doc.Equals(now.Document));
                    bool sameView = _view == null || (nowView != null && nowView.Equals(_view));
                    r["restored"] = sameDoc && sameView;
                }
                catch (Exception ex) { r["restored"] = false; r["error"] = ex.GetType().Name; }
                return r;
            }

            internal void Restore(UIApplication app)
            {
                if (app == null || _doc == null) return;
                try
                {
                    UIDocument now = app.ActiveUIDocument;
                    Document current = now?.Document;
                    if ((current == null || !_doc.Equals(current)) && !string.IsNullOrEmpty(_path))
                    {
                        // An already-open file is activated, not opened a second time.
                        app.OpenAndActivateDocument(_path);
                        now = app.ActiveUIDocument;
                    }
                    if (now == null || _view == null || now.Document == null || !_doc.Equals(now.Document)) return;
                    if (now.ActiveView != null && now.ActiveView.Id.Equals(_view)) return;
                    View back = now.Document.GetElement(_view) as View;
                    if (back != null) now.ActiveView = back;
                }
                catch (Exception) { /* the picture is already written; the person can click back */ }
            }
        }
    }
}
