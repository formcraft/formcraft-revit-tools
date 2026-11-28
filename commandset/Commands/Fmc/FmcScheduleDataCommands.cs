using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_schedule_data read (GAP-06): a schedule's fields and rows. Read-only.</summary>
    public class FmcScheduleDataReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcScheduleDataReadHandler HandlerCast => (FmcScheduleDataReadHandler)Handler;
        public FmcScheduleDataReadCommand(UIApplication uiApp) : base(new FmcScheduleDataReadHandler(), uiApp) { }
        public override string CommandName => "fmc_schedule_data_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000)) throw new TimeoutException("fmc_schedule_data_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_schedule_data_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>fmc_schedule_data apply (GAP-06): edited cells in one transaction, under a batch lease, behind the live-model lock.</summary>
    public class FmcScheduleDataApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcScheduleDataApplyHandler HandlerCast => (FmcScheduleDataApplyHandler)Handler;
        public FmcScheduleDataApplyCommand(UIApplication uiApp) : base(new FmcScheduleDataApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_schedule_data_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_schedule_data_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_schedule_data_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
