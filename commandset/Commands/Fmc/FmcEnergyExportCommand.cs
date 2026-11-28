using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>gbXML export beside the open .rvt. Writes one new file. Never saves. Any transaction is rolled back.</summary>
    public class FmcEnergyExportCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcEnergyExportHandler HandlerCast => (FmcEnergyExportHandler)Handler;

        public FmcEnergyExportCommand(UIApplication uiApp) : base(new FmcEnergyExportHandler(), uiApp) { }
        public override string CommandName => "fmc_energy_export";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(600000))
                    throw new TimeoutException("fmc_energy_export timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_energy_export: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
