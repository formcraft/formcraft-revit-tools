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
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
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

    /// <summary>Revit's design option sets and options, and the active one (O3); read-only.</summary>
    public class FmcDesignOptionsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDesignOptionsHandler _handler => (FmcDesignOptionsHandler)Handler;

        public FmcDesignOptionsCommand(UIApplication uiApp) : base(new FmcDesignOptionsHandler(), uiApp) { }
        public override string CommandName => "fmc_design_options";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A schedule set made or updated in the active template or WIP model (F60); behind the lock.</summary>
    public class FmcSchedulesApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSchedulesHandler _handler => (FmcSchedulesHandler)Handler;

        public FmcSchedulesApplyCommand(UIApplication uiApp) : base(new FmcSchedulesHandler(), uiApp) { }
        public override string CommandName => "fmc_schedules_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
