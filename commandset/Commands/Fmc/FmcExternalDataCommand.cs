using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// What the open document pulls in from outside: links, CAD, keynote and decal files, external resources and their
    /// servers (read-only; it loads, reloads and repaths nothing). Revit 2027's External Data Manager is not in R25.
    /// </summary>
    public class FmcExternalDataCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcExternalDataEventHandler _handler => (FmcExternalDataEventHandler)Handler;
        public override string CommandName => "fmc_external_data";

        public FmcExternalDataCommand(UIApplication uiApp) : base(new FmcExternalDataEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}