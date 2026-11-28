using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    public class FmcTagsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcTagsHandler HandlerCast => (FmcTagsHandler)Handler;
        public FmcTagsCommand(UIApplication uiApp) : base(new FmcTagsHandler(), uiApp) { }
        public override string CommandName => "fmc_tags";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_tags timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_tags: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    public class FmcTagsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcTagsApplyHandler HandlerCast => (FmcTagsApplyHandler)Handler;
        public FmcTagsApplyCommand(UIApplication uiApp) : base(new FmcTagsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_tags_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_tags_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_tags_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
