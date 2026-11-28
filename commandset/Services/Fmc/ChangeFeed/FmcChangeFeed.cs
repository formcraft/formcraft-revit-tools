using System;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Bridge;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>
    /// The live side of the change feed (F19): listens to Revit's own events for the whole session and writes what it hears
    /// into an in-memory journal. Hooked on Revit's API thread by the first Formcraft call of the session (FmcAiJob) and by
    /// fmc_model_changes. It only listens: no transaction, no save, no sync with central, no reload latest, no relinquish,
    /// no ownership request. A save or a sync someone runs in Revit is recorded after it happened, as an entry.
    /// Nothing is written to disk and nothing leaves this PC.
    /// </summary>
    public static class FmcChangeFeed
    {
        private static readonly object L = new object();
        private static bool _hooked;

        public static FeedJournal Journal { get; } = new FeedJournal(FeedJournal.DefaultCap);

        public static bool Hooked { get { lock (L) return _hooked; } }

        public static string Key(Document d)
        {
            if (d == null) return "";
            return string.IsNullOrEmpty(d.PathName) ? (d.Title ?? "") : d.PathName;
        }

        /// <summary>Subscribes once per Revit session. Never throws: without the hooks the feed says it isn't listening.</summary>
        public static void Hook(UIApplication app)
        {
            if (app == null) return;
            lock (L)
            {
                if (_hooked) return;
                try
                {
                    var a = app.Application;
                    a.DocumentChanged += OnChanged;
                    a.DocumentSaved += OnSaved;
                    a.DocumentSavedAs += OnSavedAs;
                    a.DocumentSynchronizedWithCentral += OnSynced;
                    a.DocumentClosing += OnClosing;
                    _hooked = true;
                    Journal.Started(DateTime.UtcNow);
                }
                catch (Exception) { /* the reply says listening: false */ }
            }
        }

        private static string UserOf(Document d)
        {
            try { return d?.Application?.Username ?? ""; } catch (Exception) { return ""; }
        }

        private static string ByNow() => FmcAiJob.Executing ? "ai" : "person";

        private static void OnChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                Document doc = e.GetDocument();
                if (doc == null || doc.IsLinked) return;
                var added = e.GetAddedElementIds();
                var modified = e.GetModifiedElementIds();
                var deleted = e.GetDeletedElementIds();
                Journal.Add(new FeedEntry
                {
                    AtUtc = DateTime.UtcNow,
                    Document = Key(doc),
                    Kind = FeedJournal.KindOf(e.Operation.ToString()),
                    Label = string.Join(", ", e.GetTransactionNames()),
                    User = UserOf(doc),
                    By = ByNow(),
                    Added = added.Count,
                    Modified = modified.Count,
                    Deleted = deleted.Count,
                    AddedIds = added.Take(FeedJournal.IdCap).Select(x => x.GetValue()).ToList(),
                    ModifiedIds = modified.Take(FeedJournal.IdCap).Select(x => x.GetValue()).ToList(),
                    DeletedIds = deleted.Take(FeedJournal.IdCap).Select(x => x.GetValue()).ToList(),
                });
            }
            catch (Exception) { /* never break Revit's own event */ }
        }

        private static void Note(Document doc, string kind, string label)
        {
            try
            {
                if (doc == null || doc.IsLinked) return;
                Journal.Add(new FeedEntry { AtUtc = DateTime.UtcNow, Document = Key(doc), Kind = kind, Label = label ?? "", User = UserOf(doc), By = ByNow() });
            }
            catch (Exception) { /* never break Revit's own event */ }
        }

        private static void OnSaved(object sender, DocumentSavedEventArgs e) => Note(e.Document, "saved", e.Status.ToString());
        private static void OnSavedAs(object sender, DocumentSavedAsEventArgs e) => Note(e.Document, "saved", "save as: " + e.Status);
        private static void OnSynced(object sender, DocumentSynchronizedWithCentralEventArgs e) => Note(e.Document, "synced", e.Status.ToString());
        private static void OnClosing(object sender, DocumentClosingEventArgs e) => Note(e.Document, "closed", "");
    }
}
