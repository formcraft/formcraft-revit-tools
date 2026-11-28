using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_warnings: Revit's warnings with failure id, severity, level, workset and owner per element (read-only).</summary>
    public class FmcWarningsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcWarningsHandler HandlerCast => (FmcWarningsHandler)Handler;
        public FmcWarningsCommand(UIApplication uiApp) : base(new FmcWarningsHandler(), uiApp) { }
        public override string CommandName => "fmc_warnings";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_warnings timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_warnings: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}