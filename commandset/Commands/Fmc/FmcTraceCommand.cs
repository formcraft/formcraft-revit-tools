using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// Systems flow tracer. Read-only: the handler collects connectors and circuits and returns.
    /// The server walks the graph. No transaction, no checkout, no save.
    /// </summary>
    public class FmcTraceCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcTraceHandler HandlerCast => (FmcTraceHandler)Handler;

        public FmcTraceCommand(UIApplication uiApp) : base(new FmcTraceHandler(), uiApp) { }
        public override string CommandName => "fmc_trace";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_trace timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_trace: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
