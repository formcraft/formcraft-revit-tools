using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>F-063: builds many checked recipes in one Revit job (fmc_recipe batch). Writes only to the family staging root.</summary>
    public class FmcRecipeBatchCommand : ExternalEventCommandBase
    {
        /// <summary>A whole pack can take hours: wait up to 12 h for the batch (FMC_SEND_CODE_MAX_MS overrides, as for send_code).</summary>
        public static readonly int MaxWaitMs = int.TryParse(Environment.GetEnvironmentVariable("FMC_SEND_CODE_MAX_MS"), out int v) && v > 0 ? v : 12 * 60 * 60 * 1000;

        private static readonly object _lock = new object();
        private FmcRecipeBatchEventHandler _handler => (FmcRecipeBatchEventHandler)Handler;

        public FmcRecipeBatchCommand(UIApplication uiApp) : base(new FmcRecipeBatchEventHandler(), uiApp) { }

        public override string CommandName => "fmc_recipe_batch";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(MaxWaitMs))
                    throw new TimeoutException($"fmc_recipe_batch didn't finish in {MaxWaitMs / 3600000.0:0.#} h; what was built is in the results file");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception("fmc_recipe_batch: " + _handler.Error);
                return _handler.Result;
            }
        }
    }
}
