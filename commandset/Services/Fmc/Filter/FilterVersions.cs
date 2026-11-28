using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;

namespace RevitMCPCommandSet.Services.Fmc.Filter
{
    /// <summary>
    /// Change detection for snapshots (Emlyn 28 Nov, decision 1: the document version). Revit's DocumentVersion
    /// (VersionGUID + NumberOfSaves) moves on save; an edit in memory is caught by a per-document counter on
    /// DocumentChanged (commits, undo, redo). The version string is both, so an unsaved edit between pages is seen too.
    /// </summary>
    public static class FilterVersions
    {
        private static readonly object L = new object();
        private static readonly Dictionary<string, long> Edits = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        private static bool _hooked;

        public static string Key(Document d) => string.IsNullOrEmpty(d?.PathName) ? (d?.Title ?? "") : d.PathName;

        /// <summary>Hooked once per Revit session, from an API call (the external event).</summary>
        public static void Hook(Autodesk.Revit.ApplicationServices.Application app)
        {
            lock (L)
            {
                if (_hooked || app == null) return;
                app.DocumentChanged += OnChanged;
                app.DocumentClosing += OnClosing;
                _hooked = true;
            }
        }

        private static void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                string k = Key(e.GetDocument());
                lock (L) Edits[k] = (Edits.TryGetValue(k, out long n) ? n : 0) + 1;
            }
            catch (Exception) { /* never break Revit's own event */ }
        }

        private static void OnClosing(object sender, DocumentClosingEventArgs e)
        {
            try { FilterEngine.Cache.DropDocument(Key(e.Document)); } catch (Exception) { }
        }

        public static string Version(Document d)
        {
            string v;
            try
            {
                DocumentVersion dv = Document.GetDocumentVersion(d);
                v = dv == null ? "nv" : $"{dv.VersionGUID:N}.{dv.NumberOfSaves}";
            }
            catch (Exception) { v = "nv"; }
            long n;
            lock (L) n = Edits.TryGetValue(Key(d), out long x) ? x : 0;
            return $"{v}.{n}";
        }
    }
}
