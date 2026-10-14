using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Review (U20) on the Revit main thread. context reads the model's name, the active view and the selected elements, so
    /// a review item links to what the person was looking at. The register itself is a project file the server keeps;
    /// nothing here changes the model (revision clouds come next, behind the live-model lock).
    /// </summary>
    public class FmcReviewEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
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

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                UIDocument ui = app.ActiveUIDocument ?? throw new InvalidOperationException("Open a model first.");
                switch (Action)
                {
                    case "context": Result = Context(ui); break;
                    default: Error = $"Unknown FMC review action '{Action}'"; break;
                }
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

        public string GetName() => "FMC review";

        private static JObject Context(UIDocument ui)
        {
            Document doc = ui.Document;
            View view = ui.ActiveView;
            var selected = ui.Selection.GetElementIds().Take(200).Select(id => id.Value).ToList();
            return new JObject
            {
                ["model"] = doc.Title.EndsWith(".rvt", StringComparison.OrdinalIgnoreCase) ? doc.Title : doc.Title + ".rvt",
                ["view"] = view?.Name ?? "", ["view_id"] = view?.Id.Value ?? -1,
                ["sheet"] = view is ViewSheet s ? s.SheetNumber : "",
                ["selected"] = new JArray(selected),
            };
        }
    }
}
