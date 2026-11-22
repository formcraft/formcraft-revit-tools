using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Resolves the project for a kit detail. Read-only.</summary>
    public class FmcDetailsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDetailsHandler HandlerCast => (FmcDetailsHandler)Handler;

        public FmcDetailsCommand(UIApplication uiApp) : base(new FmcDetailsHandler(), uiApp) { }
        public override string CommandName => "fmc_details";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException("fmc_details timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_details: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction. Copies a kit detail into a drafting view. The kit file is not saved.</summary>
    public class FmcDetailsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDetailsApplyHandler HandlerCast => (FmcDetailsApplyHandler)Handler;

        public FmcDetailsApplyCommand(UIApplication uiApp) : base(new FmcDetailsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_details_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_details_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_details_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
