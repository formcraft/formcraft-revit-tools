using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the casework commands (CW2): one handler, one action each.</summary>
    public abstract class FmcCaseworkCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCaseworkHandler _handler => (FmcCaseworkHandler)Handler;
        protected abstract string Action { get; }

        protected FmcCaseworkCommandBase(UIApplication uiApp) : base(new FmcCaseworkHandler(), uiApp) { }

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

    /// <summary>A room's walls, doors, windows and services points, read for a casework run (read only).</summary>
    public class FmcCaseworkRoomCommand : FmcCaseworkCommandBase
    {
        public FmcCaseworkRoomCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_casework_room";
        protected override string Action => "room";
    }

    /// <summary>The planned units placed as the kit's casework family types, in one Undo (dry run rolls back; behind the lock).</summary>
    public class FmcCaseworkPlaceCommand : FmcCaseworkCommandBase
    {
        public FmcCaseworkPlaceCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_casework_place";
        protected override string Action => "place";
    }

    /// <summary>Shop-drawing views and A3 sheets, the cut-list schedule placed, the sheets exported as PDF (dry run rolls back; behind the lock).</summary>
    public class FmcCaseworkPackCommand : FmcCaseworkCommandBase
    {
        public FmcCaseworkPackCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_casework_pack";
        protected override string Action => "pack";
    }
}
