using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcBatchUndoReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcBatchUndoReadHandler HandlerCast => (FmcBatchUndoReadHandler)Handler;
        public FmcBatchUndoReadCommand(UIApplication uiApp) : base(new FmcBatchUndoReadHandler(), uiApp) { }
        public override string CommandName => "fmc_batch_undo_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException("fmc_batch_undo_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_batch_undo_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcBatchUndoApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcBatchUndoApplyHandler HandlerCast => (FmcBatchUndoApplyHandler)Handler;
        public FmcBatchUndoApplyCommand(UIApplication uiApp) : base(new FmcBatchUndoApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_batch_undo_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException("fmc_batch_undo_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_batch_undo_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
