using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Envelope energy facts: U-values, areas, directions. Read-only. No transaction, no energy model.</summary>
    public class FmcEnergyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcEnergyHandler HandlerCast => (FmcEnergyHandler)Handler;

        public FmcEnergyCommand(UIApplication uiApp) : base(new FmcEnergyHandler(), uiApp) { }
        public override string CommandName => "fmc_energy";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_energy timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_energy: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
