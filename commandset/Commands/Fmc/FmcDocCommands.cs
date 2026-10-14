using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// The asset builder's engine (plan B1): background documents held in sessions. Only new documents from a template or
    /// files in staging, which the server checks; never a project model or a workshared one.
    /// </summary>
    public abstract class FmcDocCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDocEventHandler _handler => (FmcDocEventHandler)Handler;
        protected abstract string Action { get; }
        protected virtual int TimeoutMs => 120000;

        protected FmcDocCommandBase(UIApplication uiApp) : base(new FmcDocEventHandler(), uiApp) { }

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

    public class FmcDocOpenCommand : FmcDocCommandBase
    {
        public FmcDocOpenCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_open";
        protected override string Action => "open";
    }

    public class FmcDocReportCommand : FmcDocCommandBase
    {
        public FmcDocReportCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_report";
        protected override string Action => "report";
    }

    public class FmcDocScreenshotCommand : FmcDocCommandBase
    {
        public FmcDocScreenshotCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_screenshot";
        protected override string Action => "screenshot";
    }

    public class FmcDocSaveCommand : FmcDocCommandBase
    {
        public FmcDocSaveCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_save";
        protected override string Action => "save";
    }

    /// <summary>Runs a batch of named ops on a session (plan B1b): dry run unless dry_run is false.</summary>
    public class FmcDocApplyCommand : FmcDocCommandBase
    {
        public FmcDocApplyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_apply";
        protected override string Action => "apply";
        protected override int TimeoutMs => 300000;
    }

    /// <summary>Flex: every type regenerated in turn, constraint errors per type; nothing is kept (plan B1c).</summary>
    public class FmcDocFlexCommand : FmcDocCommandBase
    {
        public FmcDocFlexCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_flex";
        protected override string Action => "flex";
        protected override int TimeoutMs => 300000;
    }

    public class FmcDocCloseCommand : FmcDocCommandBase
    {
        public FmcDocCloseCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_doc_close";
        protected override string Action => "close";
    }
}
