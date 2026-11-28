using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcViewStyleCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcViewStyleHandler HandlerCast => (FmcViewStyleHandler)Handler;
        public FmcViewStyleCommand(UIApplication uiApp) : base(new FmcViewStyleHandler(), uiApp) { }
        public override string CommandName => "fmc_viewstyle";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_viewstyle timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_viewstyle: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcViewStyleApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcViewStyleApplyHandler HandlerCast => (FmcViewStyleApplyHandler)Handler;
        public FmcViewStyleApplyCommand(UIApplication uiApp) : base(new FmcViewStyleApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_viewstyle_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_viewstyle_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_viewstyle_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
