using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>MEP fabrication: the configuration, its services, the FabricationParts and their ancillaries. Read-only. No transaction.</summary>
    public class FmcFabricationCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFabricationHandler HandlerCast => (FmcFabricationHandler)Handler;

        public FmcFabricationCommand(UIApplication uiApp) : base(new FmcFabricationHandler(), uiApp) { }
        public override string CommandName => "fmc_fabrication";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_fabrication timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_fabrication: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
