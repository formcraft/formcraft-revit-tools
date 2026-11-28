using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>What changed in one open model, who and when (F19). Read-only. No transaction, no save, no sync.</summary>
    public class FmcChangeFeedReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcChangeFeedReadHandler HandlerCast => (FmcChangeFeedReadHandler)Handler;

        public FmcChangeFeedReadCommand(UIApplication uiApp) : base(new FmcChangeFeedReadHandler(), uiApp) { }
        public override string CommandName => "fmc_change_feed_read";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException("fmc_change_feed_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_change_feed_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
