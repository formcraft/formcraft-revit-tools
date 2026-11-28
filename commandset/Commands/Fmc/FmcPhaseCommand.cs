using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// Phases, phase filters, revisions, views and the element rows fmc_phase summarises.
    /// Read-only: no transaction, no checkout, no save, and the active view stays put.
    /// </summary>
    public class FmcPhaseCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPhaseHandler HandlerCast => (FmcPhaseHandler)Handler;

        public FmcPhaseCommand(UIApplication uiApp) : base(new FmcPhaseHandler(), uiApp) { }
        public override string CommandName => "fmc_phase";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_phase timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_phase: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction for a phase or revision plan. Reads stay on fmc_phase.</summary>
    public class FmcPhaseApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPhaseApplyHandler HandlerCast => (FmcPhaseApplyHandler)Handler;

        public FmcPhaseApplyCommand(UIApplication uiApp) : base(new FmcPhaseApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_phase_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_phase_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_phase_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
