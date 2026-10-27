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
            _uidoc = app.ActiveUIDocument;
            try { Result = Select(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private UIDocument _uidoc;

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
}
