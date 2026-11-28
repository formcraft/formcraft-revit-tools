using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the F59 assembly commands: one handler, one action each.</summary>
    public abstract class FmcAssembliesCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcAssembliesHandler _handler => (FmcAssembliesHandler)Handler;
        protected abstract string Action { get; }

        protected FmcAssembliesCommandBase(UIApplication uiApp) : base(new FmcAssembliesHandler(), uiApp) { }

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

    /// <summary>The model's fill patterns, curtain wall, mullion, panel, railing and top rail types and legend views (read only).</summary>
    public class FmcAssembliesReadCommand : FmcAssembliesCommandBase
    {
        public FmcAssembliesReadCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_assemblies_read";
        protected override string Action => "read";
    }

    /// <summary>Patterns made or changed, curtain wall and railing types duplicated and set, in one Undo (dry run rolls back; behind the lock).</summary>
    public class FmcAssembliesApplyCommand : FmcAssembliesCommandBase
    {
        public FmcAssembliesApplyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_assemblies_apply";
        protected override string Action => "apply";
    }
}
