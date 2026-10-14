using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft library commands (U15).</summary>
    public abstract class FmcLibraryCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcLibraryEventHandler _handler => (FmcLibraryEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcLibraryCommandBase(UIApplication uiApp) : base(new FmcLibraryEventHandler(), uiApp) { }

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

    /// <summary>Reads every loadable family in the active project (read-only; works on live models).</summary>
    public class FmcFamilyScanCommand : FmcLibraryCommandBase
    {
        public FmcFamilyScanCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_family_scan";
        protected override string Action => "scan";
    }

    /// <summary>Reads an outside .rfa opened in the background: size, imported CAD, nested families, types, parameters.</summary>
    public class FmcFamilyInspectCommand : FmcLibraryCommandBase
    {
        public FmcFamilyInspectCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_family_inspect";
        protected override string Action => "inspect";
    }

    /// <summary>Kit parameters and keynote onto an outside family, saved under its standard name in library staging.</summary>
    public class FmcFamilyBringInCommand : FmcLibraryCommandBase
    {
        public FmcFamilyBringInCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_family_bring_in";
        protected override string Action => "bring_in";
    }
}
