using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>A ticket's place in Revit: its elements selected and shown, your own review view on its camera and box (R4).</summary>
    public class FmcReviewShowCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcReviewShowHandler _handler => (FmcReviewShowHandler)Handler;

        public FmcReviewShowCommand(UIApplication uiApp) : base(new FmcReviewShowHandler(), uiApp) { }
        public override string CommandName => "fmc_review_show";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
