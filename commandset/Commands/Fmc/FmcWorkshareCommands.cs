using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft workshare commands (U20 Workshare). None of them syncs or saves (rule 6).</summary>
    public abstract class FmcWorkshareCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcWorkshareEventHandler _handler => (FmcWorkshareEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcWorkshareCommandBase(UIApplication uiApp) : base(new FmcWorkshareEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Worksharing state, the user worksets and the warnings count (read-only).</summary>
    public class FmcWorkshareFactsCommand : FmcWorkshareCommandBase
    {
        public FmcWorkshareFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_workshare_facts";
        protected override string Action => "facts";
    }

    /// <summary>Creates user worksets the server checked against the naming rule (behind the lock; never syncs).</summary>
    public class FmcWorksetCreateCommand : FmcWorkshareCommandBase
    {
        public FmcWorksetCreateCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_workset_create";
        protected override string Action => "create";
    }
}
