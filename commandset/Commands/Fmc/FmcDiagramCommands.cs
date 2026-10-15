using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft line diagrams (track LD, docs/PLAN_LINE_DIAGRAMS.md).</summary>
    public abstract class FmcDiagramCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDiagramEventHandler _handler => (FmcDiagramEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcDiagramCommandBase(UIApplication uiApp) : base(new FmcDiagramEventHandler(), uiApp) { }

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

    /// <summary>One system graph per diagram (SCAN_RESULT), read from Revit's own connections, with the gaps (read-only).</summary>
    public class FmcDiagramScanCommand : FmcDiagramCommandBase
    {
        public FmcDiagramScanCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_diagram_scan";
        protected override string Action => "scan";
    }

    /// <summary>Drafting views from a DRAW_SPEC: tool-drawn items are redrawn in place, a person's notes are kept (dry run first).</summary>
    public class FmcDiagramDrawCommand : FmcDiagramCommandBase
    {
        public FmcDiagramDrawCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_diagram_draw";
        protected override string Action => "draw";
    }
}
