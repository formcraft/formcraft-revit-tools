using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft ceiling commands (CL2, CL4).</summary>
    public abstract class FmcCeilingCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCeilingEventHandler _handler => (FmcCeilingEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcCeilingCommandBase(UIApplication uiApp) : base(new FmcCeilingEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(600000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Places a ceiling design: ceilings per zone, line features where loaded, fixture marks (behind the lock).</summary>
    public class FmcCeilingPlaceCommand : FmcCeilingCommandBase
    {
        public FmcCeilingPlaceCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_ceiling_place";
        protected override string Action => "place";
    }

    /// <summary>Replaces what the last place made with the design as it is now (behind the lock).</summary>
    public class FmcCeilingEditCommand : FmcCeilingCommandBase
    {
        public FmcCeilingEditCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_ceiling_edit";
        protected override string Action => "edit";
    }

    /// <summary>The set-out and section drafting views, the RCP and the RCP sheet (behind the lock).</summary>
    public class FmcCeilingSheetCommand : FmcCeilingCommandBase
    {
        public FmcCeilingSheetCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_ceiling_sheet";
        protected override string Action => "sheet";
    }
}
