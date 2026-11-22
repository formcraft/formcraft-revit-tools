using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Legend views and legend components. Read-only. Revit cannot create either from nothing.</summary>
    public class FmcLegendViewsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcLegendViewsHandler HandlerCast => (FmcLegendViewsHandler)Handler;

        public FmcLegendViewsCommand(UIApplication uiApp) : base(new FmcLegendViewsHandler(), uiApp) { }
        public override string CommandName => "fmc_legend_views";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_legend_views timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_legend_views: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction. Copies a seed legend view or seed component. No text notes.</summary>
    public class FmcLegendApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcLegendApplyHandler HandlerCast => (FmcLegendApplyHandler)Handler;

        public FmcLegendApplyCommand(UIApplication uiApp) : base(new FmcLegendApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_legend_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_legend_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_legend_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
