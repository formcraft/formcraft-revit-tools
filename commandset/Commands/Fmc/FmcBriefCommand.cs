using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Start from brief (U23): levels, Project Information, unplaced rooms and families on a new model (behind the lock).</summary>
    public class FmcBriefApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcBriefEventHandler _handler => (FmcBriefEventHandler)Handler;

        public FmcBriefApplyCommand(UIApplication uiApp) : base(new FmcBriefEventHandler(), uiApp) { }

        public override string CommandName => "fmc_brief_apply";

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
