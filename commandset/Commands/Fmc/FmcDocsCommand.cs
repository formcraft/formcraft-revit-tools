using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>List and probe. No transaction.</summary>
    public class FmcDocsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDocsHandler HandlerCast => (FmcDocsHandler)Handler;

        public FmcDocsCommand(UIApplication uiApp) : base(new FmcDocsHandler(), uiApp) { }
        public override string CommandName => "fmc_docs";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException("fmc_docs timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_docs: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>Open or close. Runs on the API thread. A save is refused for a protected path.</summary>
    public class FmcDocsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDocsHandler HandlerCast => (FmcDocsHandler)Handler;

        public FmcDocsApplyCommand(UIApplication uiApp) : base(new FmcDocsHandler(), uiApp) { }
        public override string CommandName => "fmc_docs_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_docs_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_docs_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
