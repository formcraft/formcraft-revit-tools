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
    /// fmc_visibility: why each element is or is not visible in one view. Read only: no transaction is opened and nothing is
    /// set, hidden, unhidden, isolated or overridden (see <see cref="FmcVisibility"/>). The view is view_id, else the
    /// active view of the target document.
    /// </summary>
    public class FmcVisibilityHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const int MaxElements = 50;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft visibility";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    IList<long> ids = ElementIds();
                    View view = ResolveView(doc, target);
                    RevitLinkInstance link = null;
                    long linkId = Id(Parameters["link_instance_id"]);
                    if (linkId != 0)
                    {
                        link = doc.GetElement(new ElementId(linkId)) as RevitLinkInstance;
                        if (link == null) throw new InvalidOperationException($"[FMC-VIS-LINK] link_instance_id {linkId} is not a Revit link instance in {doc.Title}.");
                        if (link.GetLinkDocument() == null) throw new InvalidOperationException($"[FMC-VIS-LINK] The link \"{link.Name}\" is not loaded, so its elements cannot be read.");
                    }
                    Result = FmcVisibility.Explain(doc, view, link, ids);
                    Result["document"] = doc.Title;
                    Result["checks"] = new JArray(FmcVisibility.Order);
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private IList<long> ElementIds()
        {
            var ids = new List<long>();
            JToken t = Parameters["element_ids"];
            if (t is JArray a) foreach (JToken x in a) { long v = Id(x); if (v != 0 && !ids.Contains(v)) ids.Add(v); }
            else if (t != null && t.Type != JTokenType.Null) { long v = Id(t); if (v != 0) ids.Add(v); }
            if (ids.Count == 0) throw new InvalidOperationException("[FMC-VIS-IDS] element_ids is required: one or more element ids.");
            if (ids.Count > MaxElements) throw new InvalidOperationException($"[FMC-VIS-IDS] At most {MaxElements} element ids per call ({ids.Count} given).");
            return ids;
        }

        private static long Id(JToken t)
        {
            if (t == null || t.Type == JTokenType.Null) return 0;
            return long.TryParse(t.ToString(), out long v) ? v : 0;
        }

        private View ResolveView(Document doc, FmcTarget target)
        {
            long vid = Id(Parameters["view_id"]);
            View view;
            if (vid != 0)
            {
                view = doc.GetElement(new ElementId(vid)) as View;
                if (view == null) throw new InvalidOperationException($"[FMC-VIS-VIEW] view_id {vid} is not a view in {doc.Title}.");
            }
            else
            {
                view = target.Ui?.ActiveView;
                if (view == null) throw new InvalidOperationException($"[FMC-VIS-VIEW] No view_id was given and {doc.Title} is not the document on screen, so there is no active view. Pass view_id.");
            }
            if (view.IsTemplate) throw new InvalidOperationException($"[FMC-VIS-VIEW] \"{view.Name}\" is a view template: it displays no elements. Pass the id of a view that uses it.");
            switch (view.ViewType)
            {
                case ViewType.Schedule: case ViewType.DrawingSheet: case ViewType.ProjectBrowser: case ViewType.SystemBrowser:
                case ViewType.Internal: case ViewType.Report: case ViewType.PanelSchedule: case ViewType.ColumnSchedule: case ViewType.CostReport: case ViewType.LoadsReport:
                    throw new InvalidOperationException($"[FMC-VIS-VIEW] \"{view.Name}\" is a {view.ViewType}, not a graphical view of the model.");
            }
            return view;
        }
    }
}
