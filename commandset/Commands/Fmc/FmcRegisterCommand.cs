using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcRegisterReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcRegisterReadHandler HandlerCast => (FmcRegisterReadHandler)Handler;
        public FmcRegisterReadCommand(UIApplication uiApp) : base(new FmcRegisterReadHandler(), uiApp) { }
        public override string CommandName => "fmc_register_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException("fmc_register_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_register_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcRegisterApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcRegisterApplyHandler HandlerCast => (FmcRegisterApplyHandler)Handler;
        public FmcRegisterApplyCommand(UIApplication uiApp) : base(new FmcRegisterApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_register_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException("fmc_register_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_register_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
