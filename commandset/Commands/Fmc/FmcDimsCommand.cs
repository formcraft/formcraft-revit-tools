using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcDimsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDimsHandler HandlerCast => (FmcDimsHandler)Handler;
        public FmcDimsCommand(UIApplication uiApp) : base(new FmcDimsHandler(), uiApp) { }
        public override string CommandName => "fmc_dims";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_dims timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_dims: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcDimsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDimsApplyHandler HandlerCast => (FmcDimsApplyHandler)Handler;
        public FmcDimsApplyCommand(UIApplication uiApp) : base(new FmcDimsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_dims_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_dims_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_dims_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
