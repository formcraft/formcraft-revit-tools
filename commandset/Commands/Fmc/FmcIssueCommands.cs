using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft issue commands (U19 Ready to issue).</summary>
    public abstract class FmcIssueCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcIssueEventHandler _handler => (FmcIssueEventHandler)Handler;
        protected abstract string Action { get; }
        protected virtual int TimeoutMs => 120000;

        protected FmcIssueCommandBase(UIApplication uiApp) : base(new FmcIssueEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(TimeoutMs))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>The model's revisions and each sheet's current revision (read-only).</summary>
    public class FmcIssueFactsCommand : FmcIssueCommandBase
    {
        public FmcIssueFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_issue_facts";
        protected override string Action => "facts";
    }

    /// <summary>One PDF per sheet into the issue folder the server checked; the model is not changed.</summary>
    public class FmcIssueExportCommand : FmcIssueCommandBase
    {
        public FmcIssueExportCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_issue_export";
        protected override string Action => "export";
        protected override int TimeoutMs => 900000;
    }
}
