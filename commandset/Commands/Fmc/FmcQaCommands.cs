using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft QA commands (U16).</summary>
    public abstract class FmcQaCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcQaEventHandler _handler => (FmcQaEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcQaCommandBase(UIApplication uiApp) : base(new FmcQaEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Reads what the kit's QA rules check in the active model (read-only; live and shared models too).</summary>
    public class FmcQaFactsCommand : FmcQaCommandBase
    {
        public FmcQaFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_qa_facts";
        protected override string Action => "facts";
    }

    /// <summary>Selects and shows elements (a QA result's Zoom). Selection never changes the model.</summary>
    public class FmcSelectElementsCommand : FmcQaCommandBase
    {
        public FmcSelectElementsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_select_elements";
        protected override string Action => "select";
    }
}
