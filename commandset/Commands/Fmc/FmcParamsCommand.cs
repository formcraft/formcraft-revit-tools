using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Project parameter bindings and parameter values (read-only).</summary>
    public class FmcParamsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcParamsHandler HandlerCast => (FmcParamsHandler)Handler;

        public FmcParamsCommand(UIApplication uiApp) : base(new FmcParamsHandler(), uiApp) { }
        public override string CommandName => "fmc_params";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_params timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_params: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>Binds kit shared parameters and sets parameter values in one transaction.</summary>
    public class FmcParamsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcParamsApplyHandler HandlerCast => (FmcParamsApplyHandler)Handler;

        public FmcParamsApplyCommand(UIApplication uiApp) : base(new FmcParamsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_params_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_params_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_params_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
