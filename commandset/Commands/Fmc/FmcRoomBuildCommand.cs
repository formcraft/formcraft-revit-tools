using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>A planned room built in the active model, replacing what its tree node built before (T1).</summary>
    public class FmcRoomBuildCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcRoomBuildHandler _handler => (FmcRoomBuildHandler)Handler;

        public FmcRoomBuildCommand(UIApplication uiApp) : base(new FmcRoomBuildHandler(), uiApp) { }
        public override string CommandName => "fmc_room_build";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
