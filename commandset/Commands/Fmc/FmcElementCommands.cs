using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Marked elements' facts for a ticket's fix plan (R3/R6); read-only.</summary>
    public class FmcElementFactsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcElementFactsHandler _handler => (FmcElementFactsHandler)Handler;

        public FmcElementFactsCommand(UIApplication uiApp) : base(new FmcElementFactsHandler(), uiApp) { }
        public override string CommandName => "fmc_element_facts";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(30000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A ticket's planned fix applied in one transaction, after a person's yes (R6); behind the lock.</summary>
    public class FmcElementApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcElementApplyHandler _handler => (FmcElementApplyHandler)Handler;

        public FmcElementApplyCommand(UIApplication uiApp) : base(new FmcElementApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_element_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
