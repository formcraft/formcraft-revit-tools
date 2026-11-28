using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only duct and pipe systems and routing preferences. No transaction.</summary>
    public class FmcMepSystemsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMepSystemsHandler HandlerCast => (FmcMepSystemsHandler)Handler;

        public FmcMepSystemsCommand(UIApplication uiApp) : base(new FmcMepSystemsHandler(), uiApp) { }
        public override string CommandName => "fmc_mep_systems";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_mep_systems timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_mep_systems: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
