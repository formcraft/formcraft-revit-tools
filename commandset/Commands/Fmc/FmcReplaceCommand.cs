using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// Preview-only structural replacement on a document opened with fmc_open_copy.
    /// The transaction group is always rolled back. Nothing is saved.
    /// </summary>
    public class FmcReplaceCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcReplaceHandler _handler => (FmcReplaceHandler)Handler;

        public FmcReplaceCommand(UIApplication uiApp) : base(new FmcReplaceHandler(), uiApp) { }
        public override string CommandName => "fmc_replace";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(600000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
