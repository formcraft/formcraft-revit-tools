using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// What a bot may change in a workshared model. Revit 2025:
    /// GetCheckoutStatus and GetModelUpdatesStatus are read-only.
    /// CheckoutElements would ask for ownership; this type never calls it.
    /// RelinquishOptions only drops what the current user owns. Another user's borrowings stay.
    /// Incoming editing requests are not listed by the API and are never granted here.
    /// </summary>
    internal static class FmcCheckout
    {
        internal const string OwnedByOther = "FMC-ELEM-OWNED-BY-OTHER";
        internal const string NotCurrent = "FMC-ELEM-NOT-CURRENT";

        internal sealed class AllHeldBack : Exception
        {
            internal JArray Skipped { get; }
            internal AllHeldBack(JArray skipped) : base(skipped.Count > 0 ? skipped[0].Value<string>("code") ?? OwnedByOther : OwnedByOther)
            {
                Skipped = skipped;
            }
        }

        internal static void Partition(Document doc, IList<ElementId> ids, List<ElementId> kept, JArray skipped)
        {
            kept.Clear();
            if (!doc.IsWorkshared)
            {
                foreach (ElementId id in ids) kept.Add(id);
                return;
            }
            foreach (ElementId id in ids)
            {
                JObject row = Hold(doc, id);
                if (row == null) kept.Add(id);
                else skipped.Add(row);
            }
        }

        /// <summary>Null when this user may edit the element. Otherwise a skip row. Never requests a checkout.</summary>
        internal static JObject Hold(Document doc, ElementId id)
        {
            if (doc == null || !doc.IsWorkshared || id == null || id == ElementId.InvalidElementId) return null;
            try
            {
                CheckoutStatus checkout = WorksharingUtils.GetCheckoutStatus(doc, id);
                string owner = "";
                try { owner = WorksharingUtils.GetWorksharingTooltipInfo(doc, id)?.Owner ?? ""; } catch (Exception) { owner = ""; }
                if (checkout == CheckoutStatus.OwnedByOtherUser)
                    return new JObject { ["id"] = id.Value, ["code"] = OwnedByOther, ["owner"] = string.IsNullOrEmpty(owner) ? "another user" : owner };
                ModelUpdatesStatus updates = WorksharingUtils.GetModelUpdatesStatus(doc, id);
                if (updates == ModelUpdatesStatus.UpdatedInCentral || updates == ModelUpdatesStatus.DeletedInCentral)
                    return new JObject { ["id"] = id.Value, ["code"] = NotCurrent, ["owner"] = owner, ["updates"] = updates.ToString() };
            }
            catch (Exception) { /* a non-workshared element, or the status is not available: leave it to the edit */ }
            return null;
        }

        internal static JObject Currency(Document doc, IEnumerable<long> ids)
        {
            var rows = new JArray();
            foreach (long value in ids)
            {
                var id = new ElementId(value);
                var row = new JObject { ["id"] = value.ToString() };
                if (doc != null && doc.IsWorkshared && doc.GetElement(id) != null)
                {
                    try
                    {
                        row["checkout"] = WorksharingUtils.GetCheckoutStatus(doc, id).ToString();
                        row["updates"] = WorksharingUtils.GetModelUpdatesStatus(doc, id).ToString();
                        row["owner"] = WorksharingUtils.GetWorksharingTooltipInfo(doc, id)?.Owner ?? "";
                    }
                    catch (Exception ex) { row["error"] = ex.Message; }
                }
                else
                {
                    row["checkout"] = "NotOwned";
                    row["updates"] = "CurrentWithCentral";
                    row["owner"] = "";
                }
                rows.Add(row);
            }
            return new JObject
            {
                ["elements"] = rows,
                ["editing_requests"] = new JObject
                {
                    ["granted"] = false,
                    ["pending"] = null,
                    ["reason"] = "Revit 2025 has no API to list or grant incoming editing requests. They stay for the person.",
                },
            };
        }
    }

    /// <summary>Read-only checkout and central-currency of named elements. Never checks anything out.</summary>
    public class FmcElemCurrencyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft element currency";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    var ids = (Parameters["ids"] as JArray ?? new JArray()).Select(t => long.TryParse(t.ToString(), out long v) ? v : 0L).Where(v => v != 0);
                    Result = FmcCheckout.Currency(target.Doc, ids);
                    Result["document"] = FmcTarget.DescribeState(target.Doc);
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
