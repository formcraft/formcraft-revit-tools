using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only conduit and tray ends. No transaction.</summary>
    public class FmcConduitCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcConduitHandler HandlerCast => (FmcConduitHandler)Handler;

        public FmcConduitCommand(UIApplication uiApp) : base(new FmcConduitHandler(), uiApp) { }
        public override string CommandName => "fmc_conduit";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_conduit timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_conduit: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction. Each fitting is its own subtransaction.</summary>
    public class FmcConduitApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcConduitApplyHandler HandlerCast => (FmcConduitApplyHandler)Handler;

        public FmcConduitApplyCommand(UIApplication uiApp) : base(new FmcConduitApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_conduit_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_conduit_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_conduit_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
