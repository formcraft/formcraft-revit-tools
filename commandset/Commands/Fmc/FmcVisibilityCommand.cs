using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_visibility: why elements are or are not visible in a view (no transaction, nothing is changed).</summary>
    public class FmcVisibilityCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcVisibilityHandler HandlerCast => (FmcVisibilityHandler)Handler;
        public FmcVisibilityCommand(UIApplication uiApp) : base(new FmcVisibilityHandler(), uiApp) { }
        public override string CommandName => "fmc_visibility";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException("fmc_visibility timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_visibility: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
