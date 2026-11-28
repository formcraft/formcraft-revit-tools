using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// One Revit command for fmc_coord. The action (snapshot, align, place) is in the parameters.
    /// Align and place change the model only when dry_run is false. The server sends those through the live-model lock.
    /// </summary>
    public class FmcCoordApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCoordEventHandler _handler => (FmcCoordEventHandler)Handler;

        public FmcCoordApplyCommand(UIApplication uiApp) : base(new FmcCoordEventHandler(), uiApp) { }

        public override string CommandName => "fmc_coord_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
