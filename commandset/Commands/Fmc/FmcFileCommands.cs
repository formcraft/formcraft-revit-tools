using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft file commands: one handler, one action each.</summary>
    public abstract class FmcFileCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFileEventHandler _handler => (FmcFileEventHandler)Handler;
        protected abstract string Action { get; }
        protected virtual int TimeoutMs => 120000;

        protected FmcFileCommandBase(UIApplication uiApp) : base(new FmcFileEventHandler(), uiApp) { }

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

    /// <summary>Open documents and the active one. The MCP server's live-model lock reads this before any model-changing tool.</summary>
    public class FmcDocumentInfoCommand : FmcFileCommandBase
    {
        public FmcDocumentInfoCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_document_info";
        protected override string Action => "info";
        // Ogala night report: an autosave holds Revit 40-60 s; the document check waits it out instead of timing out at 15 s
        protected override int TimeoutMs => 120000;
    }

    /// <summary>New family, project or template from a template file, saved to a path the server has checked.</summary>
    public class FmcCreateDocumentCommand : FmcFileCommandBase
    {
        public FmcCreateDocumentCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_create_document";
        protected override string Action => "create";
    }

    /// <summary>Save an open, non-workshared document to a path the server has checked.</summary>
    public class FmcSaveDocumentAsCommand : FmcFileCommandBase
    {
        public FmcSaveDocumentAsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_save_document_as";
        protected override string Action => "save_as";
    }

    /// <summary>Close an open document that is not the active one.</summary>
    public class FmcCloseDocumentCommand : FmcFileCommandBase
    {
        public FmcCloseDocumentCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_close_document";
        protected override string Action => "close";
    }

    /// <summary>Open a detached verification copy in the background. The source file is not opened or written.</summary>
    public class FmcOpenCopyCommand : FmcFileCommandBase
    {
        public FmcOpenCopyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_open_copy";
        protected override string Action => "open_copy";
        protected override int TimeoutMs => 300000;
    }

    /// <summary>Open a person's existing workshared local, optionally as the active document. No detach, no new local, no sync. A central is refused.</summary>
    public class FmcOpenLocalCommand : FmcFileCommandBase
    {
        public FmcOpenLocalCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_open_local";
        protected override string Action => "open_local";
        protected override int TimeoutMs => 300000;
    }

    /// <summary>Close an open local without saving, syncing or relinquishing. A save goes through fmc_close_local_apply.</summary>
    public class FmcCloseLocalCommand : FmcFileCommandBase
    {
        public FmcCloseLocalCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_close_local";
        protected override string Action => "close_local";
        protected override int TimeoutMs => 180000;
    }

    /// <summary>Save the local file, then close it. A write command: the server applies the live-model lock, the AI gate and the batch lease. Never syncs.</summary>
    public class FmcCloseLocalApplyCommand : FmcFileCommandBase
    {
        public FmcCloseLocalApplyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_close_local_apply";
        protected override string Action => "close_local_apply";
        protected override int TimeoutMs => 180000;
    }
}
