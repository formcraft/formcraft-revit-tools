using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_assets_read: facility, spaces, types, components and systems for the COBie-style asset register. Read-only.</summary>
    public class FmcAssetsReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcAssetsHandler HandlerCast => (FmcAssetsHandler)Handler;
        public FmcAssetsReadCommand(UIApplication uiApp) : base(new FmcAssetsHandler(), uiApp) { }
        public override string CommandName => "fmc_assets_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_assets_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_assets_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
