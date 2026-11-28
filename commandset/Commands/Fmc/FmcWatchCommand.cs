using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_watch: start, stop or report the change ledger of an open model (no transaction, no model change).</summary>
    public class FmcWatchCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcWatchHandler HandlerCast => (FmcWatchHandler)Handler;
        public FmcWatchCommand(UIApplication uiApp) : base(new FmcWatchHandler(), uiApp) { }
        public override string CommandName => "fmc_watch";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException("fmc_watch timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_watch: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
