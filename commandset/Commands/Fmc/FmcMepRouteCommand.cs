using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only pipe or duct types, routing preferences, system types and levels for a route. No transaction.</summary>
    public class FmcMepRouteCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMepRouteHandler HandlerCast => (FmcMepRouteHandler)Handler;

        public FmcMepRouteCommand(UIApplication uiApp) : base(new FmcMepRouteHandler(), uiApp) { }
        public override string CommandName => "fmc_mep_route";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_mep_route timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_mep_route: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction. Each piece and each fitting is its own subtransaction.</summary>
    public class FmcMepRouteApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMepRouteApplyHandler HandlerCast => (FmcMepRouteApplyHandler)Handler;

        public FmcMepRouteApplyCommand(UIApplication uiApp) : base(new FmcMepRouteApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_mep_route_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_mep_route_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_mep_route_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
