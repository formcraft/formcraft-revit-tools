using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only clash scan. No transaction. Boxes are dropped after each chunk.</summary>
    public class FmcClashCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcClashHandler HandlerCast => (FmcClashHandler)Handler;

        public FmcClashCommand(UIApplication uiApp) : base(new FmcClashHandler(), uiApp) { }
        public override string CommandName => "fmc_clash";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_clash timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_clash: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
