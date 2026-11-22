using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcSheetLayoutCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSheetLayoutHandler HandlerCast => (FmcSheetLayoutHandler)Handler;
        public FmcSheetLayoutCommand(UIApplication uiApp) : base(new FmcSheetLayoutHandler(), uiApp) { }
        public override string CommandName => "fmc_sheets_layout";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_sheets_layout timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_sheets_layout: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcSheetLayoutApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSheetLayoutApplyHandler HandlerCast => (FmcSheetLayoutApplyHandler)Handler;
        public FmcSheetLayoutApplyCommand(UIApplication uiApp) : base(new FmcSheetLayoutApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_sheets_layout_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_sheets_layout_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_sheets_layout_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
