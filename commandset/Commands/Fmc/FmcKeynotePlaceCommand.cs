using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Keynote seeds and hosts. Read-only.</summary>
    public class FmcKeynotePlaceCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcKeynotePlaceHandler HandlerCast => (FmcKeynotePlaceHandler)Handler;

        public FmcKeynotePlaceCommand(UIApplication uiApp) : base(new FmcKeynotePlaceHandler(), uiApp) { }
        public override string CommandName => "fmc_keynote_place";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_keynote_place timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_keynote_place: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction. Copies a linked keynote seed and retargets it. A blank copy is rolled back.</summary>
    public class FmcKeynotePlaceApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcKeynotePlaceApplyHandler HandlerCast => (FmcKeynotePlaceApplyHandler)Handler;

        public FmcKeynotePlaceApplyCommand(UIApplication uiApp) : base(new FmcKeynotePlaceApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_keynote_place_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_keynote_place_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_keynote_place_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
