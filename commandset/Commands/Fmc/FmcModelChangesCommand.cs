using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Read-only: the elements created, modified or deleted since a document version. No transaction.</summary>
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
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException("fmc_model_changes timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_model_changes: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
