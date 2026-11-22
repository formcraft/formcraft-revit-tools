using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only circuit snapshot. No transaction.</summary>
    public class FmcCircuitsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCircuitsHandler HandlerCast => (FmcCircuitsHandler)Handler;

        public FmcCircuitsCommand(UIApplication uiApp) : base(new FmcCircuitsHandler(), uiApp) { }
        public override string CommandName => "fmc_circuits";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_circuits timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_circuits: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction for circuits or a panel. A failed circuit rolls back only its subtransaction.</summary>
    public class FmcCircuitsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCircuitsApplyHandler HandlerCast => (FmcCircuitsApplyHandler)Handler;

        public FmcCircuitsApplyCommand(UIApplication uiApp) : base(new FmcCircuitsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_circuits_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_circuits_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_circuits_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
