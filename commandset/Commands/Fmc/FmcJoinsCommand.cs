using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// Join audit, hosting, room closure and the envelope pressure test.
    /// Read-only: no transaction, no checkout, no save, and the active view stays put.
    /// </summary>
    public class FmcJoinsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcJoinsHandler HandlerCast => (FmcJoinsHandler)Handler;

        public FmcJoinsCommand(UIApplication uiApp) : base(new FmcJoinsHandler(), uiApp) { }
        public override string CommandName => "fmc_joins";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_joins timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_joins: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction for a join plan. Reads stay on fmc_joins.</summary>
    public class FmcJoinsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcJoinsApplyHandler HandlerCast => (FmcJoinsApplyHandler)Handler;

        public FmcJoinsApplyCommand(UIApplication uiApp) : base(new FmcJoinsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_joins_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_joins_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_joins_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
