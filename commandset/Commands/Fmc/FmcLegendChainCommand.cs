using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>F-064 #6: a role's chain-test project with every staged family placed, tagged, scheduled and on a sheet (fmc_legend chain).</summary>
    public class FmcLegendChainCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcLegendChainEventHandler _handler => (FmcLegendChainEventHandler)Handler;

        public FmcLegendChainCommand(UIApplication uiApp) : base(new FmcLegendChainEventHandler(), uiApp) { }

        public override string CommandName => "fmc_legend_chain";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(FmcRecipeBatchCommand.MaxWaitMs))
                    throw new TimeoutException("fmc_legend_chain didn't finish");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception("fmc_legend_chain: " + _handler.Error);
                return _handler.Result;
            }
        }
    }
}
