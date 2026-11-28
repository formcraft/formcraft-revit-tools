using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Stair, ramp and handrail facts for the compliance check. Read-only. No transaction.</summary>
    public class FmcStairsCheckCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcStairsCheckHandler HandlerCast => (FmcStairsCheckHandler)Handler;

        public FmcStairsCheckCommand(UIApplication uiApp) : base(new FmcStairsCheckHandler(), uiApp) { }
        public override string CommandName => "fmc_stairs_check";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_stairs_check timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_stairs_check: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
