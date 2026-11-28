using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    // GAP-13 fmc_transfer, GAP-14 fmc_cad_audit, GAP-24 fmc_carbon and fmc_view_audit (feat/gap-tools-13-14-24).

    public class FmcTransferReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcTransferReadHandler H => (FmcTransferReadHandler)Handler;
        public FmcTransferReadCommand(UIApplication uiApp) : base(new FmcTransferReadHandler(), uiApp) { }
        public override string CommandName => "fmc_transfer_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                H.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_transfer_read timed out");
                if (!string.IsNullOrEmpty(H.Error)) throw new Exception("fmc_transfer_read: " + H.Error);
                return H.Result;
            }
        }
    }

    public class FmcTransferApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcTransferApplyHandler H => (FmcTransferApplyHandler)Handler;
        public FmcTransferApplyCommand(UIApplication uiApp) : base(new FmcTransferApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_transfer_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                H.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(600000)) throw new TimeoutException("fmc_transfer_apply timed out");
                if (!string.IsNullOrEmpty(H.Error)) throw new Exception("fmc_transfer_apply: " + H.Error);
                return H.Result;
            }
        }
    }
}

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcCadAuditCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCadAuditHandler H => (FmcCadAuditHandler)Handler;
        public FmcCadAuditCommand(UIApplication uiApp) : base(new FmcCadAuditHandler(), uiApp) { }
        public override string CommandName => "fmc_cad_audit";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                H.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(900000)) throw new TimeoutException("fmc_cad_audit timed out");
                if (!string.IsNullOrEmpty(H.Error)) throw new Exception("fmc_cad_audit: " + H.Error);
                return H.Result;
            }
        }
    }
}
