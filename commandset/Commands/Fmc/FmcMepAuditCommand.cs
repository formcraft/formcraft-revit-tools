using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only MEP connectivity and system audit. No transaction.</summary>
    public class FmcMepAuditCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMepAuditHandler HandlerCast => (FmcMepAuditHandler)Handler;

        public FmcMepAuditCommand(UIApplication uiApp) : base(new FmcMepAuditHandler(), uiApp) { }
        public override string CommandName => "fmc_mep_audit";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_mep_audit timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_mep_audit: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
