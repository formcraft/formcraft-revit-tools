using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using System;
using System.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The JSON-RPC parameters of the command running now. Legacy handlers read the document from here
    /// instead of <c>ActiveUIDocument</c>. One command runs at a time on the external-event queue.
    /// </summary>
    public static class FmcCallContext
    {
        public static JObject Parameters { get; private set; } = new JObject();
        static Document _cached;

        public static void Begin(JObject parameters)
        {
            Parameters = parameters ?? new JObject();
            _cached = null;
        }

        /// <summary>The call's document. A given document that is not open throws FMC-DOC-NOT-FOUND and does not use the active document.</summary>
        public static Document Document(UIApplication app, bool mayOpen = false)
        {
            if (_cached != null && _cached.IsValidObject) return _cached;
            using (FmcTarget target = FmcTarget.Resolve(app, Parameters ?? new JObject(), mayOpen))
            {
                _cached = target.Doc;
                return _cached;
            }
        }

        /// <summary>
        /// The view the call's document shows, never the active window's view of another document.
        /// <c>Document.ActiveView</c> follows Revit's active window, so for a document that is open in the background it
        /// answered the active document's view (get_current_view_info and get_current_view_elements always described the
        /// active model), and for a document with no window it was null. The document's own window is used instead: the
        /// UI active view when the document is the active one, else its open view (the document's ActiveView when that is
        /// one of its windows, else the first). A view of another document is never accepted.
        /// No view is [FMC-VIEW-NONE], never a null.
        /// </summary>
        public static View ViewOf(UIApplication app, Document doc)
        {
            View view = null;
            try
            {
                UIDocument active = app.ActiveUIDocument;
                if (active != null && active.Document.Equals(doc))
                {
                    view = active.ActiveView;
                }
                else
                {
                    var open = new UIDocument(doc).GetOpenUIViews().Select(u => doc.GetElement(u.ViewId) as View).Where(v => v != null).ToList();
                    View own = null;
                    try { own = doc.ActiveView; } catch (Exception) { /* a document without a window has none */ }
                    view = open.FirstOrDefault(v => own != null && v.Id == own.Id) ?? open.FirstOrDefault();
                }
            }
            catch (Exception) { view = null; }
            if (view == null || !view.IsValidObject || !view.Document.Equals(doc))
                throw new InvalidOperationException($"[FMC-VIEW-NONE] {doc.Title} has no active view: it has no open view window. Open or activate a view in it, then ask again. Refusing to use another document's view.");
            return view;
        }
    }
}
