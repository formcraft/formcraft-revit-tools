using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft sheet commands (U19).</summary>
    public abstract class FmcSheetCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSheetEventHandler _handler => (FmcSheetEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcSheetCommandBase(UIApplication uiApp) : base(new FmcSheetEventHandler(), uiApp) { }

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

    /// <summary>Every sheet: number, name, views placed and the asked-for fields; the loaded title blocks (read-only).</summary>
    public class FmcSheetFactsCommand : FmcSheetCommandBase
    {
        public FmcSheetFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_sheet_facts";
        protected override string Action => "facts";
    }

    /// <summary>Makes the register's missing sheets with a title block (dry run unless dry_run is false; behind the lock).</summary>
    public class FmcSheetCreateCommand : FmcSheetCommandBase
    {
        public FmcSheetCreateCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_sheet_create";
        protected override string Action => "create";
    }

    /// <summary>Gives sheets the register's names (dry run unless dry_run is false; behind the lock).</summary>
    public class FmcSheetRenameCommand : FmcSheetCommandBase
    {
        public FmcSheetRenameCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_sheet_rename";
        protected override string Action => "rename";
    }
}
