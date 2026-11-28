using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_wipe scan (GAP-02): clutter counts and ids per category. Read-only.</summary>
    public class FmcWipeScanCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcWipeScanHandler HandlerCast => (FmcWipeScanHandler)Handler;
        public FmcWipeScanCommand(UIApplication uiApp) : base(new FmcWipeScanHandler(), uiApp) { }
        public override string CommandName => "fmc_wipe_scan";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_wipe_scan timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_wipe_scan: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>fmc_wipe apply (GAP-02): deletes checked ids in one transaction, under a batch lease, behind the live-model lock.</summary>
    public class FmcWipeApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcWipeApplyHandler HandlerCast => (FmcWipeApplyHandler)Handler;
        public FmcWipeApplyCommand(UIApplication uiApp) : base(new FmcWipeApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_wipe_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(600000)) throw new TimeoutException("fmc_wipe_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_wipe_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
