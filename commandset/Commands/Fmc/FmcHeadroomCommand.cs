using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Clear headroom. Read-only. No transaction.</summary>
    public class FmcHeadroomCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcHeadroomHandler HandlerCast => (FmcHeadroomHandler)Handler;

        public FmcHeadroomCommand(UIApplication uiApp) : base(new FmcHeadroomHandler(), uiApp) { }
        public override string CommandName => "fmc_headroom";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_headroom timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_headroom: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
