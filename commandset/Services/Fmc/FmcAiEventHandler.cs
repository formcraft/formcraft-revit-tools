using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The AI-assisted modeller's checks in Revit (Phase A), read-only. types: each element type's category, so the
    /// server lets AI place only doors, windows, fixtures and the other listed categories, never structure.
    /// </summary>
    public class FmcAiEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "FMC AI checks";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                Document doc = target.Doc;
                if (Action != "types") { Error = $"Unknown FMC AI action '{Action}'"; return; }
                var types = new JArray();
                foreach (long id in (Parameters["ids"] as JArray ?? new JArray()).Select(x => x.Value<long>()).Distinct())
                {
                    Element e = doc.GetElement(new ElementId(id));
                    BuiltInCategory bic = e?.Category != null ? (BuiltInCategory)e.Category.Id.Value : BuiltInCategory.INVALID;
                    types.Add(new JObject { ["id"] = id, ["found"] = e is ElementType, ["category"] = e is ElementType ? bic.ToString() : "", ["name"] = e?.Name ?? "" });
                }
                Result = new JObject { ["model"] = doc.Title, ["types"] = types };
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }
    }
}
