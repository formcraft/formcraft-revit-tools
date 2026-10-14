using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>The AI-assisted modeller: each element type's category, before AI places anything (read-only).</summary>
    public class FmcTypeFactsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcAiEventHandler _handler => (FmcAiEventHandler)Handler;

        public FmcTypeFactsCommand(UIApplication uiApp) : base(new FmcAiEventHandler(), uiApp) { }

        public override string CommandName => "fmc_type_facts";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = "types";
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
