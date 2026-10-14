using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft review commands (U20 Review).</summary>
    public abstract class FmcReviewCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcReviewEventHandler _handler => (FmcReviewEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcReviewCommandBase(UIApplication uiApp) : base(new FmcReviewEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(30000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A revision cloud around a review item's elements in the active view (dry run unless dry_run is false; behind the lock).</summary>
    public class FmcReviewCloudCommand : FmcReviewCommandBase
    {
        public FmcReviewCloudCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_review_cloud";
        protected override string Action => "cloud";
    }

    /// <summary>The model, the active view and the selected elements, for a review item (read-only).</summary>
    public class FmcReviewContextCommand : FmcReviewCommandBase
    {
        public FmcReviewContextCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_review_context";
        protected override string Action => "context";
    }
}
