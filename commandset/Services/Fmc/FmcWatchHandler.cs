using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_watch actions that need Revit: start, stop, status. (read and summary are the server's: they read the ledger file.)
    /// Starting registers a document-specific updater and the DocumentChanged hook (see <see cref="FmcWatch"/>); no
    /// transaction is opened and no model element is touched. The ledger path comes from the server, which applies the guard.
    /// </summary>
    public class FmcWatchHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft watch";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                string action = (Parameters.Value<string>("action") ?? "").Trim().ToLowerInvariant();
                switch (action)
                {
                    case "start": Result = Start(app); break;
                    case "stop": Result = Stop(app); break;
                    case "status": Result = Status(app); break;
                    default: throw new InvalidOperationException($"[FMC-WATCH-ACTION] action is start, stop or status (read and summary are answered by the server), not \"{action}\".");
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Start(UIApplication app)
        {
            using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
            {
                FmcWatch.Session s = FmcWatch.Start(app, target.Doc, Parameters.Value<string>("file") ?? "", Parameters.Value<string>("scope") ?? "model", out bool already);
                var r = FmcWatch.Describe(s);
                r["action"] = "start"; r["already_running"] = already; r["model_changed"] = false;
                r["note"] = already ? "A watch was already running on this document; nothing was changed." : "Watching. Every change is appended to the ledger file until stop or the document closes.";
                return r;
            }
        }

        private JObject Stop(UIApplication app)
        {
            if (Parameters.Value<bool?>("all") == true)
            {
                var stopped = new JArray();
                foreach (FmcWatch.Session s in FmcWatch.All())
                {
                    Document d = Open(app, s.Key);
                    if (d != null && FmcWatch.Stop(app, d, "stop (all)") != null) { var r = FmcWatch.Describe(s); r["running"] = false; stopped.Add(r); }
                }
                return new JObject { ["action"] = "stop", ["stopped"] = stopped, ["model_changed"] = false };
            }
            using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
            {
                FmcWatch.Session s = FmcWatch.Stop(app, target.Doc, "stop");
                if (s == null) return new JObject { ["action"] = "stop", ["document"] = target.Doc.Title, ["running"] = false, ["was_running"] = false, ["model_changed"] = false };
                var r = FmcWatch.Describe(s);
                r["action"] = "stop"; r["running"] = false; r["was_running"] = true; r["model_changed"] = false;
                return r;
            }
        }

        private JObject Status(UIApplication app)
        {
            var watches = new JArray(FmcWatch.All().Select(FmcWatch.Describe));
            return new JObject { ["action"] = "status", ["watching"] = watches.Count, ["watches"] = watches, ["model_changed"] = false };
        }

        private static Document Open(UIApplication app, string key)
        {
            foreach (Document d in app.Application.Documents) if (!d.IsLinked && string.Equals(FmcWatch.Key(d), key, StringComparison.OrdinalIgnoreCase)) return d;
            return null;
        }
    }
}
