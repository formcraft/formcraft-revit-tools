using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcGroupsAuditCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcGroupsAuditHandler HandlerCast => (FmcGroupsAuditHandler)Handler;
        public FmcGroupsAuditCommand(UIApplication uiApp) : base(new FmcGroupsAuditHandler(), uiApp) { }
        public override string CommandName => "fmc_groups_audit";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000)) throw new TimeoutException("fmc_groups_audit timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_groups_audit: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
