using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>True north and project north. Read-only: no transaction and no change to shared coordinates.</summary>
    public class FmcNorthCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcNorthHandler HandlerCast => (FmcNorthHandler)Handler;

        public FmcNorthCommand(UIApplication uiApp) : base(new FmcNorthHandler(), uiApp) { }
        public override string CommandName => "fmc_north";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_north timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_north: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction for a crop, scope box or north arrow. Project north is checked and not changed.</summary>
    public class FmcNorthApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcNorthApplyHandler HandlerCast => (FmcNorthApplyHandler)Handler;

        public FmcNorthApplyCommand(UIApplication uiApp) : base(new FmcNorthApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_north_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_north_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_north_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
