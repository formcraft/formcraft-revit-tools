using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// Reloads one Revit link type with no transaction phase. A path uses LoadFrom; otherwise Reload.
    /// Link instances are left in place.
    /// </summary>
    public class FmcReloadLinkCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcReloadLinkHandler _handler => (FmcReloadLinkHandler)Handler;

        public FmcReloadLinkCommand(UIApplication uiApp) : base(new FmcReloadLinkHandler(), uiApp) { }
        public override string CommandName => "fmc_reload_link";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
