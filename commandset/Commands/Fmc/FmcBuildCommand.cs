using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Build (U26): quantities by kit code, status and package counts, unmapped elements (read-only).</summary>
    public class FmcBuildFactsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcBuildEventHandler _handler => (FmcBuildEventHandler)Handler;

        public FmcBuildFactsCommand(UIApplication uiApp) : base(new FmcBuildEventHandler(), uiApp) { }

        public override string CommandName => "fmc_build_facts";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
