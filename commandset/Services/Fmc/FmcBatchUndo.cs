using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Ids a batch created, after sync. Read-only: exists, checkout, and a bounding-box fingerprint.
    /// CheckoutElements is never called.
    /// </summary>
    public class FmcBatchUndoReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft batch undo read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var rows = new JArray();
                    foreach (long id in Ids(Parameters["ids"] as JArray))
                    {
                        Element element = doc.GetElement(new ElementId(id));
                        if (element == null)
                        {
                            rows.Add(new JObject { ["id"] = id.ToString(CultureInfo.InvariantCulture), ["exists"] = false, ["editable"] = false, ["code"] = "FMC-UNDO-GONE" });
                            continue;
                        }
                        JObject held = FmcCheckout.Hold(doc, element.Id);
                        rows.Add(new JObject
                        {
                            ["id"] = id.ToString(CultureInfo.InvariantCulture),
                            ["exists"] = true,
                            ["editable"] = held == null,
                            ["fingerprint"] = Fingerprint(element),
                            ["code"] = held?["code"],
                            ["reason"] = held == null ? null : held.Value<string>("owner"),
                            ["owner"] = held?["owner"] ?? "",
                        });
                    }
                    Result = new JObject { ["read_only"] = true, ["elements"] = rows, ["resolved_document"] = FmcTarget.Resolved(doc) };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        internal static string Fingerprint(Element element)
        {
            BoundingBoxXYZ box = null;
            try { box = element.get_BoundingBox(null); } catch (Exception) { return ""; }
            if (box == null) return "";
            string part(double feet) => Math.Round(feet * 304.8, 1).ToString(CultureInfo.InvariantCulture);
            return $"{part(box.Min.X)},{part(box.Min.Y)},{part(box.Min.Z)}|{part(box.Max.X)},{part(box.Max.Y)},{part(box.Max.Z)}";
        }

        internal static IEnumerable<long> Ids(JArray array)
        {
            foreach (JToken token in array ?? new JArray())
                if (long.TryParse(token.ToString(), out long id) && id != 0) yield return id;
        }
    }

    /// <summary>One transaction. Deletes only the ids the server already checked. Does not request a checkout.</summary>
    public class FmcBatchUndoApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft batch undo apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var wanted = new Dictionary<long, string>();
                    foreach (JObject row in (Parameters["fingerprints"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        if (long.TryParse(row.Value<string>("id") ?? row["id"]?.ToString(), out long id))
                            wanted[id] = row.Value<string>("fingerprint") ?? "";
                    }
                    foreach (long id in FmcBatchUndoReadHandler.Ids(Parameters["ids"] as JArray))
                        if (!wanted.ContainsKey(id)) wanted[id] = "";
                    var deleted = new JArray();
                    var skipped = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft undo created"))
                    {
                        transaction.Start();
                        foreach (var pair in wanted)
                        {
                            Element element = doc.GetElement(new ElementId(pair.Key));
                            if (element == null)
                            {
                                skipped.Add(new JObject { ["id"] = pair.Key.ToString(CultureInfo.InvariantCulture), ["code"] = "FMC-UNDO-GONE", ["reason"] = "The element is not in the model." });
                                continue;
                            }
                            JObject held = FmcCheckout.Hold(doc, element.Id);
                            if (held != null)
                            {
                                skipped.Add(held);
                                continue;
                            }
                            string now = FmcBatchUndoReadHandler.Fingerprint(element);
                            if (!string.IsNullOrEmpty(pair.Value) && !string.Equals(pair.Value, now, StringComparison.Ordinal))
                            {
                                skipped.Add(new JObject { ["id"] = pair.Key.ToString(CultureInfo.InvariantCulture), ["code"] = "FMC-UNDO-CHANGED", ["reason"] = "The element changed after the batch." });
                                continue;
                            }
                            doc.Delete(element.Id);
                            deleted.Add(pair.Key.ToString(CultureInfo.InvariantCulture));
                        }
                        transaction.Commit();
                    }
                    Result = new JObject { ["ok"] = true, ["deleted"] = deleted, ["skipped"] = skipped, ["saved"] = false, ["synced"] = false, ["resolved_document"] = FmcTarget.Resolved(doc) };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
