using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// fmc_ui: read and steer the Formcraft pane for UI tests (get_state, open_section, set_mock_licence,
    /// screenshot_pane). It never touches the model, so the server allows it on live models.
    /// </summary>
    public class FmcUiCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcUiEventHandler _handler => (FmcUiEventHandler)Handler;

        public FmcUiCommand(UIApplication uiApp) : base(new FmcUiEventHandler(), uiApp) { }

        public override string CommandName => "fmc_ui";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                parameters = parameters ?? new JObject();
                _handler.Action = (string)parameters["action"] ?? "";
                _handler.Parameters = parameters;
                if (!RaiseAndWaitForCompletion(15000))
                    throw new TimeoutException($"{CommandName} timed out: Revit is busy (a dialog or a long command). Try again when Revit is idle.");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
