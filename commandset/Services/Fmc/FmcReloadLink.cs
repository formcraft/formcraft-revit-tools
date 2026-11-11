using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Reloads one Revit link type. Revit 2025 refuses <c>RevitLinkType.LoadFrom</c> and <c>Reload</c> with
    /// "Operation is not permitted when there is any open transaction phase started by API client", including when
    /// <c>send_code_to_revit</c> uses <c>transactionMode</c> none, because that wrapper still opens a
    /// <c>TransactionGroup</c>. This handler therefore opens no <c>Transaction</c>, <c>TransactionGroup</c> or
    /// <c>SubTransaction</c>. Existing link instances are not deleted or recreated, so their positions stay.
    /// </summary>
    public class FmcReloadLinkHandler : IExternalEventHandler, IWaitableExternalEventHandler
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

        public string GetName() => "FMC reload link";

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
            using FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
            Document doc = target.Doc;
            if (doc.IsFamilyDocument)
                throw new InvalidOperationException("A family document has no Revit links. fmc_reload_link is refused.");
            RefuseOriginal(doc);
            if (doc.IsModifiable)
                throw new InvalidOperationException(
                    $"A transaction is already open on {doc.Title}, so the link was not reloaded. " +
                    "LoadFrom and Reload are refused while an API transaction phase is open.");

            if (Parameters["link_type_id"] == null || Parameters["link_type_id"].Type == JTokenType.Null)
                throw new InvalidOperationException("link_type_id is required: the Revit link type's element id.");
            long id = Parameters.Value<long>("link_type_id");
            Element element = doc.GetElement(new ElementId(id));
            if (element is RevitLinkInstance instance)
                throw new InvalidOperationException($"id {id} is a link instance. Pass its link type id ({instance.GetTypeId().GetValue()}).");
            if (element is not RevitLinkType type)
                throw new InvalidOperationException($"id {id} isn't a Revit link type.");

            var placed = new List<(ElementId Id, XYZ Origin)>();
            foreach (RevitLinkInstance link in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
            {
                if (link.GetTypeId().GetValue() != type.Id.GetValue()) continue;
                placed.Add((link.Id, link.GetTotalTransform().Origin));
            }

            string given = (Parameters.Value<string>("path") ?? "").Trim();
            LinkLoadResult load = given.Length > 0
                ? type.LoadFrom(ModelPathUtils.ConvertUserVisiblePathToModelPath(given), new WorksetConfiguration())
                : type.Reload();
            if (load == null) throw new InvalidOperationException("Revit returned no link load result.");

            bool positionsKept = true;
            foreach ((ElementId elementId, XYZ origin) in placed)
            {
                var after = doc.GetElement(elementId) as RevitLinkInstance;
                if (after == null || !after.GetTotalTransform().Origin.IsAlmostEqualTo(origin)) positionsKept = false;
            }

            return new JObject
            {
                ["load_result"] = load.LoadResult.ToString(),
                ["status"] = type.GetLinkedFileStatus().ToString(),
                ["path"] = VisiblePath(type, given),
                ["link_type_id"] = id,
                ["instances"] = placed.Count,
                ["positions_kept"] = positionsKept,
                ["document"] = new JObject { ["title"] = doc.Title ?? "", ["path"] = doc.PathName ?? "" },
            };
        }

        /// <summary>The same refusals as a save, sync, reload or relinquish: a verification copy, a linked document, or a protected original.</summary>
        private void RefuseOriginal(Document doc)
        {
            if (doc.IsLinked || doc.IsDetached || FmcVerifySession.Contains(doc) || FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException($"reload is refused on {doc.Title}: a verification copy, a link, or a protected original is never saved, synced, reloaded or relinquished.");
        }

        private static string VisiblePath(RevitLinkType type, string given)
        {
            try
            {
                ExternalFileReference reference = type.GetExternalFileReference();
                if (reference != null)
                {
                    string shown = ModelPathUtils.ConvertModelPathToUserVisiblePath(reference.GetAbsolutePath());
                    if (!string.IsNullOrWhiteSpace(shown)) return shown;
                }
            }
            catch (Exception) { /* the path we asked for is still reported */ }
            return given;
        }
    }
}
