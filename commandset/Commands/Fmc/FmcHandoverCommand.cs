using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_handover_read: document, project information and element parameters for the handover zip. Read-only.</summary>
    public class FmcHandoverReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcHandoverHandler HandlerCast => (FmcHandoverHandler)Handler;
        public FmcHandoverReadCommand(UIApplication uiApp) : base(new FmcHandoverHandler(), uiApp) { }
        public override string CommandName => "fmc_handover_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_handover_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_handover_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
