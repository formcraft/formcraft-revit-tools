using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>What changed in one open model, who and when (F19). Read-only. No transaction, no save, no sync.</summary>
    public class FmcModelChangesCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcModelChangesHandler HandlerCast => (FmcModelChangesHandler)Handler;

        public FmcModelChangesCommand(UIApplication uiApp) : base(new FmcModelChangesHandler(), uiApp) { }
        public override string CommandName => "fmc_model_changes";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException("fmc_model_changes timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_model_changes: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
