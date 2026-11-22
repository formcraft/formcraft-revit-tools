using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Runs one Dynamo graph inside a transaction group. Preview rolls the group back. Apply keeps it.
    /// Neither mode saves the document. Dynamo calls are late-bound (FmcDynamoHost).
    /// </summary>
    public class FmcDynamoHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _done.Reset();
            return FmcBusy.Wait(_done, timeoutMilliseconds);
        }

        public string GetName() => "FMC Dynamo";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try { Result = Run(app); }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private JObject Run(UIApplication app)
        {
            string action = (Parameters.Value<string>("action") ?? "run").Trim();
            if (action == "status")
            {
                FmcAiJob.Enter(app, FmcAiJob.JobOf(Parameters));
                try { return FmcDynamoHost.Session(); }
                finally { FmcAiJob.Exit(); }
            }

            using FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
            Document doc = target.Doc;
            string path = (Parameters.Value<string>("path") ?? "").Trim();
            if (!FmcDynamoHost.Approved(path))
                throw new InvalidOperationException("[FMC-SCRIPT-ROOT] " + path + " is outside 05_Scripts\\library or 05_Scripts\\Dynamo.");
            string mode = (Parameters.Value<string>("mode") ?? "preview").Trim();
            bool preview = mode != "apply";
            string scriptJob = (Parameters.Value<string>("script_job") ?? "").Trim();
            JObject inputs = Parameters["inputs"] as JObject ?? new JObject();

            var added = new HashSet<long>();
            var deleted = new HashSet<long>();
            var modified = new HashSet<long>();
            EventHandler<DocumentChangedEventArgs> changed = (sender, args) =>
            {
                if (!args.GetDocument().Equals(doc)) return;
                foreach (ElementId id in args.GetAddedElementIds()) added.Add(id.Value);
                foreach (ElementId id in args.GetDeletedElementIds()) { deleted.Add(id.Value); added.Remove(id.Value); }
                foreach (ElementId id in args.GetModifiedElementIds()) modified.Add(id.Value);
            };
            app.Application.DocumentChanged += changed;
            try
            {
                using var group = new TransactionGroup(doc, preview ? "FMC: Dynamo preview" : "FMC: Dynamo");
                group.Start();
                JObject run = null;
                JArray after = new JArray();
                bool cancel = false;
                try
                {
                    FmcAiJob.ThrowIfCancelled();
                    if (CancelFile(scriptJob)) cancel = true;
                    run = cancel
                        ? new JObject { ["cancelled"] = true, ["message"] = "Cancelled before the graph ran." }
                        : FmcDynamoHost.Run(doc, path, inputs);
                    if (!cancel && CancelFile(scriptJob)) cancel = true;
                    after = FmcModelDiff.Read(doc, modified.Concat(added), 50);
                }
                finally
                {
                    if (group.HasStarted())
                    {
                        if (!preview && !cancel && runKeeps(run)) group.Assimilate();
                        else group.RollBack();
                    }
                }
                bool kept = !preview && !cancel && runKeeps(run);
                return new JObject
                {
                    ["mode"] = preview ? "preview" : "apply",
                    ["dry_run"] = preview,
                    ["rolled_back"] = !kept,
                    ["auto_saved"] = false,
                    ["createdIds"] = new JArray(added.Take(50)),
                    ["deletedIds"] = new JArray(deleted.Take(50)),
                    ["modifiedIds"] = new JArray(modified.Take(50)),
                    ["createdCount"] = added.Count,
                    ["deletedCount"] = deleted.Count,
                    ["modifiedCount"] = modified.Count,
                    ["parameter_after"] = after,
                    ["outputs"] = run?["outputs"] ?? new JObject(),
                    ["loaded"] = run?["loaded"],
                    ["version"] = run?["version"],
                    ["code"] = run?["code"],
                    ["message"] = run?["message"],
                    ["ran"] = run?.Value<bool?>("ran") == true && kept || run?.Value<bool?>("ran") == true,
                    ["cancelled"] = cancel,
                    ["binding"] = "reflection",
                    ["resolved_document"] = FmcTarget.Resolved(doc),
                    ["document"] = FmcTarget.Resolved(doc),
                };
            }
            finally
            {
                app.Application.DocumentChanged -= changed;
            }
        }

        private static bool runKeeps(JObject run)
        {
            if (run == null) return false;
            if (run.Value<string>("code") == "FMC-DYNAMO-UNAVAILABLE") return false;
            return run.Value<bool?>("ran") == true;
        }

        private static bool CancelFile(string job)
        {
            if (string.IsNullOrEmpty(job)) return false;
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "jobs", "cancel", job);
            return File.Exists(dir);
        }
    }
}
