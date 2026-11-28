using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_select_by (Ogala report: a region selection missed the old BQ stair): elements by category, level, type,
    /// family, comment, mark, workset, phase, a box or a view, read-only; ids with their category, type and level.
    /// <para>Build plan item 32 (Emlyn 28 Nov: select_by upgraded in place, in line with the hub's revit_select_by): a
    /// call with action, criteria, cursor or result_set goes to the filter engine (Filter/FilterEngine.cs: criteria tree,
    /// preview, cursor pages, links, several documents, rooms and boundaries, invert). A flat call with none of those
    /// answers exactly as before, so the hub's revit_select_by and every existing caller keep their reply.</para>
    /// </summary>
    public class FmcSelectByHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft select by";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                if (IsEngineCall(Parameters)) Result = Filter.FilterEngine.Run(app, Parameters);
                else
                    using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                    {
                        _uidoc = target.Ui;
                        Result = Select(target.Doc);
                    }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private UIDocument _uidoc;

        /// <summary>The filter engine's arguments (spec 3.1); a flat select_by call has none of them.</summary>
        public static bool IsEngineCall(JObject p) =>
            p != null && (p["action"] != null || p["criteria"] != null || p["cursor"] != null || p["result_set"] != null || p["scope"] != null || p["invert"] != null);

        private JObject Select(Document doc)
        {
            // owner 27 Oct: the shared query (FmcSelect), the same one every modify_model op takes as select
            JObject p = Parameters;
            var all = FmcSelect.Find(doc, p, null, _uidoc?.ActiveView);
            int limit = p.Value<int?>("limit") ?? 500;
            return new JObject
            {
                ["count"] = all.Count,
                ["by_category"] = new JObject(all.GroupBy(e => e.Category?.Name ?? "(none)").OrderByDescending(g => g.Count()).Select(g => new JProperty(g.Key, g.Count()))),
                ["ids"] = new JArray(all.Take(limit).Select(e => e.Id.Value)),
                ["elements"] = new JArray(all.Take(Math.Min(limit, 100)).Select(e => new JObject
                {
                    ["id"] = e.Id.Value, ["category"] = e.Category?.Name, ["type"] = doc.GetElement(e.GetTypeId())?.Name ?? e.Name, ["level"] = doc.GetElement(e.LevelId)?.Name ?? "",
                })),
            };
        }
    }

    /// <summary>fmc_select_by_show (build plan item 32, spec 5.8): puts a result set or ids into Revit's selection.
    /// No transaction, nothing in the undo list. The active document only, capped (default 2000, at most 5000).
    /// The server refuses it while another bot holds the lease (Emlyn 28 Nov, decision 3).</summary>
    public class FmcSelectByShowHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft select by: show";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                RevitMCPCommandSet.Bridge.FmcAiJob.Enter(app, RevitMCPCommandSet.Bridge.FmcAiJob.JobOf(Parameters));
                Result = Filter.FilterEngine.Show(app, Parameters);
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }
}
