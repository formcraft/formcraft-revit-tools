using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft annotation commands (U19, read-only).</summary>
    public abstract class FmcAnnotationCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcAnnotationEventHandler _handler => (FmcAnnotationEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcAnnotationCommandBase(UIApplication uiApp) : base(new FmcAnnotationEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Text types, line patterns, dimension types and tag families in the model (read-only).</summary>
    public class FmcAnnotationFactsCommand : FmcAnnotationCommandBase
    {
        public FmcAnnotationFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_annotation_facts";
        protected override string Action => "facts";
    }

    /// <summary>Untagged doors, windows, rooms and electrical fixtures in the current view or sheet (read-only).</summary>
    public class FmcMissingTagsCommand : FmcAnnotationCommandBase
    {
        public FmcMissingTagsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_missing_tags";
        protected override string Action => "missing_tags";
    }
}
