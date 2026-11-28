using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_area_check: reads the facts a planning check needs (areas, rooms, floors by level, footprint outline, property
    /// lines, named areas, Parking elements) and returns them. Read only: no transaction, nothing is created or changed.
    /// The server holds the planning values and does the checks.
    /// </summary>
    public class FmcAreaCheckHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft area check";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    var only = new HashSet<long>();
                    if (Parameters["property_line_ids"] is JArray a)
                        foreach (JToken t in a) if (long.TryParse(t.ToString(), out long v) && v > 0) only.Add(v);
                    Result = FmcAreaFacts.Collect(target.Doc,
                        Parameters.Value<string>("area_scheme") ?? "",
                        Parameters.Value<string>("footprint_level") ?? "",
                        Parameters.Value<string>("plot_area_name") ?? "",
                        only);
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }
}
