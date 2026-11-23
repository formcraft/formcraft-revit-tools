using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcElecDiagramsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcElecDiagramsHandler HandlerCast => (FmcElecDiagramsHandler)Handler;

        public FmcElecDiagramsCommand(UIApplication uiApp) : base(new FmcElecDiagramsHandler(), uiApp) { }
        public override string CommandName => "fmc_elec_diagrams";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_elec_diagrams timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_elec_diagrams: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcElecDiagramsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSchematicApplyHandler HandlerCast => (FmcSchematicApplyHandler)Handler;

        public FmcElecDiagramsApplyCommand(UIApplication uiApp) : base(new FmcSchematicApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_elec_diagrams_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Tool = "fmc_elec_diagrams";
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_elec_diagrams_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_elec_diagrams_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcPlumbDiagramsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPlumbDiagramsHandler HandlerCast => (FmcPlumbDiagramsHandler)Handler;

        public FmcPlumbDiagramsCommand(UIApplication uiApp) : base(new FmcPlumbDiagramsHandler(), uiApp) { }
        public override string CommandName => "fmc_plumb_diagrams";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_plumb_diagrams timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_plumb_diagrams: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcPlumbDiagramsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSchematicApplyHandler HandlerCast => (FmcSchematicApplyHandler)Handler;

        public FmcPlumbDiagramsApplyCommand(UIApplication uiApp) : base(new FmcSchematicApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_plumb_diagrams_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Tool = "fmc_plumb_diagrams";
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_plumb_diagrams_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_plumb_diagrams_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
