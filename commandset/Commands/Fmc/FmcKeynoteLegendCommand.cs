using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcKeynoteLegendCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcKeynoteLegendHandler HandlerCast => (FmcKeynoteLegendHandler)Handler;
        public FmcKeynoteLegendCommand(UIApplication uiApp) : base(new FmcKeynoteLegendHandler(), uiApp) { }
        public override string CommandName => "fmc_keynote_legend";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_keynote_legend timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_keynote_legend: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcKeynoteLegendApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcKeynoteLegendApplyHandler HandlerCast => (FmcKeynoteLegendApplyHandler)Handler;
        public FmcKeynoteLegendApplyCommand(UIApplication uiApp) : base(new FmcKeynoteLegendApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_keynote_legend_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_keynote_legend_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_keynote_legend_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
