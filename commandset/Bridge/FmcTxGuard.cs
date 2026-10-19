using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// Transaction safety for send_code_to_revit (KISIC §4.1, FMC-CODE-TX-LEAK). The bridge wraps every transaction a script
    /// creates in <see cref="FmcScript.Track{T}"/>; after the run (also after an exception) anything still started is rolled
    /// back, newest first, and reported. When the document is still modifiable after that (a transaction the bridge could
    /// not see or could not roll back), the document is marked "needs a person" and every further script on it is refused
    /// until it is closed. Revit runs one script at a time on its API thread, so one list is enough.
    /// </summary>
    public static class FmcTxGuard
    {
        private static readonly List<object> _tracked = new List<object>();
        private static readonly Dictionary<string, string> _blocked = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private static bool _hooked;

        /// <summary>What the clean-up found: each leak and whether every one was rolled back.</summary>
        public sealed class Cleanup
        {
            public List<string> Leaks { get; } = new List<string>();
            public bool AllRolledBack { get; set; } = true;
            public bool Any => Leaks.Count > 0;
        }

        /// <summary>Starts a run: forgets the last run's transactions and lifts a block when its document closes.</summary>
        public static void Begin(UIApplication app)
        {
            lock (_tracked) _tracked.Clear();
            if (_hooked || app?.Application == null) return;
            try
            {
                app.Application.DocumentClosing += OnClosing;
                _hooked = true;
            }
            catch (Exception) { /* without the hook a block lasts until Revit restarts */ }
        }

        private static void OnClosing(object sender, DocumentClosingEventArgs e)
        {
            try { lock (_blocked) _blocked.Remove(Key(e.Document)); } catch (Exception) { }
        }

        /// <summary>Remembers a transaction, sub-transaction or transaction group the script created.</summary>
        public static T Track<T>(T transaction) where T : class
        {
            if (transaction != null) lock (_tracked) _tracked.Add(transaction);
            return transaction;
        }

        /// <summary>Rolls back, newest first, every tracked transaction still started (sub-transactions, then transactions, then groups).</summary>
        public static Cleanup RollBackLeaks()
        {
            var result = new Cleanup();
            object[] tracked;
            lock (_tracked)
            {
                tracked = _tracked.ToArray();
                _tracked.Clear();
            }
            for (int i = tracked.Length - 1; i >= 0; i--)
            {
                object o = tracked[i];
                string what = o.GetType().Name;
                try
                {
                    switch (o)
                    {
                        case SubTransaction sub when sub.IsValidObject && sub.GetStatus() == TransactionStatus.Started:
                            sub.RollBack();
                            result.Leaks.Add("SubTransaction left open: rolled back");
                            break;
                        case Transaction t when t.IsValidObject && t.GetStatus() == TransactionStatus.Started:
                            what = $"Transaction \"{t.GetName()}\"";
                            t.RollBack();
                            result.Leaks.Add($"{what} left open: rolled back");
                            break;
                        case TransactionGroup g when g.IsValidObject && g.GetStatus() == TransactionStatus.Started:
                            what = $"TransactionGroup \"{g.GetName()}\"";
                            g.RollBack();
                            result.Leaks.Add($"{what} left open: rolled back");
                            break;
                    }
                }
                catch (Exception ex)
                {
                    result.AllRolledBack = false;
                    result.Leaks.Add($"{what} left open and could not be rolled back: {ex.Message}");
                }
            }
            return result;
        }

        private static string Key(Document doc)
        {
            if (doc == null) return "";
            string path = "";
            try { path = doc.PathName ?? ""; } catch (Exception) { }
            return path.Length > 0 ? path : "title:" + doc.Title;
        }

        /// <summary>Marks a document "needs a person": scripts on it are refused until it closes.</summary>
        public static void Block(Document doc, string reason)
        {
            lock (_blocked) _blocked[Key(doc)] = $"{DateTime.Now:HH:mm} {reason}";
        }

        /// <summary>Why scripts on this document are refused, or null.</summary>
        public static string BlockedReason(Document doc)
        {
            lock (_blocked) return _blocked.TryGetValue(Key(doc), out string r) ? r : null;
        }
    }
}
