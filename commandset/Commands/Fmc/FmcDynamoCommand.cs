using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// fmc_dynamo: Dynamo for Revit in this process, by late binding. Preview rolls back. Apply keeps the group.
    /// Status does not change the model. DynamoSandbox is not used.
    /// </summary>
    public class FmcDynamoCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDynamoHandler _handler => (FmcDynamoHandler)Handler;

        public FmcDynamoCommand(UIApplication uiApp) : base(new FmcDynamoHandler(), uiApp) { }
        public override string CommandName => "fmc_dynamo";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(12 * 60 * 60 * 1000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
