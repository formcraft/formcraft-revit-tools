using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_area_check: the model facts for a planning area check (no transaction, nothing is changed).</summary>
    public class FmcAreaCheckCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcAreaCheckHandler HandlerCast => (FmcAreaCheckHandler)Handler;
        public FmcAreaCheckCommand(UIApplication uiApp) : base(new FmcAreaCheckHandler(), uiApp) { }
        public override string CommandName => "fmc_area_check";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException("fmc_area_check timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_area_check: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
