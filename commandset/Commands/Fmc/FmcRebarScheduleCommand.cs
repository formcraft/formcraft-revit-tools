using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>BS 8666 bar bending schedule facts. Read-only. No transaction.</summary>
    public class FmcRebarScheduleCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcRebarScheduleHandler HandlerCast => (FmcRebarScheduleHandler)Handler;

        public FmcRebarScheduleCommand(UIApplication uiApp) : base(new FmcRebarScheduleHandler(), uiApp) { }
        public override string CommandName => "fmc_rebar_schedule";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_rebar_schedule timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_rebar_schedule: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
