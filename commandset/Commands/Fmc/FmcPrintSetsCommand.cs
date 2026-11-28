using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcPrintSetsReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPrintSetsReadHandler HandlerCast => (FmcPrintSetsReadHandler)Handler;
        public FmcPrintSetsReadCommand(UIApplication uiApp) : base(new FmcPrintSetsReadHandler(), uiApp) { }
        public override string CommandName => "fmc_print_sets_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException("fmc_print_sets_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_print_sets_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcPrintSetsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPrintSetsApplyHandler HandlerCast => (FmcPrintSetsApplyHandler)Handler;
        public FmcPrintSetsApplyCommand(UIApplication uiApp) : base(new FmcPrintSetsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_print_sets_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException("fmc_print_sets_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_print_sets_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
