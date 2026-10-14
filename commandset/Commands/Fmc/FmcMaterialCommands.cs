using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft material commands (U18).</summary>
    public abstract class FmcMaterialCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMaterialEventHandler _handler => (FmcMaterialEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcMaterialCommandBase(UIApplication uiApp) : base(new FmcMaterialEventHandler(), uiApp) { }

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

    /// <summary>The model's materials, whether each is used, and their texture paths (read-only).</summary>
    public class FmcMaterialFactsCommand : FmcMaterialCommandBase
    {
        public FmcMaterialFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_material_facts";
        protected override string Action => "facts";
    }

    /// <summary>A database material onto types (dry run unless dry_run is false; the server applies the live-model lock).</summary>
    public class FmcMaterialAssignCommand : FmcMaterialCommandBase
    {
        public FmcMaterialAssignCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_material_assign";
        protected override string Action => "assign";
    }

    /// <summary>Deletes materials nothing uses (dry run unless dry_run is false; the server applies the live-model lock).</summary>
    public class FmcMaterialPurgeCommand : FmcMaterialCommandBase
    {
        public FmcMaterialPurgeCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_material_purge";
        protected override string Action => "purge";
    }
}
