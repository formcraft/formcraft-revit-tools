using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>DirectShapes fmc_directshape made: check a planned set, or list. Read-only: no transaction.</summary>
    public class FmcDirectShapeCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDirectShapeHandler HandlerCast => (FmcDirectShapeHandler)Handler;

        public FmcDirectShapeCommand(UIApplication uiApp) : base(new FmcDirectShapeHandler(), uiApp) { }
        public override string CommandName => "fmc_directshape";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_directshape timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_directshape: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction: create DirectShapes, or remove only the ones this tool made. All or nothing.</summary>
    public class FmcDirectShapeApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDirectShapeApplyHandler HandlerCast => (FmcDirectShapeApplyHandler)Handler;

        public FmcDirectShapeApplyCommand(UIApplication uiApp) : base(new FmcDirectShapeApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_directshape_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_directshape_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_directshape_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
