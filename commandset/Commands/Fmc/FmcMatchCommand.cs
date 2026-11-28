using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Source and target elements for a match (read-only).</summary>
    public class FmcMatchCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMatchHandler HandlerCast => (FmcMatchHandler)Handler;

        public FmcMatchCommand(UIApplication uiApp) : base(new FmcMatchHandler(), uiApp) { }
        public override string CommandName => "fmc_match";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_match timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_match: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>Copies type, parameters and view overrides in one transaction.</summary>
    public class FmcMatchApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMatchApplyHandler HandlerCast => (FmcMatchApplyHandler)Handler;

        public FmcMatchApplyCommand(UIApplication uiApp) : base(new FmcMatchApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_match_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_match_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_match_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
