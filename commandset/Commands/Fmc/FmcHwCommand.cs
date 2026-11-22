using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// fmc_hw: graphics settings, a memory summary, and closing spare views.
    /// It does not move the model onto the GPU. The Revit API runs on this thread, on the CPU.
    /// </summary>
    public class FmcHwCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcHwHandler HandlerCast => (FmcHwHandler)Handler;

        public FmcHwCommand(UIApplication uiApp) : base(new FmcHwHandler(), uiApp) { }
        public override string CommandName => "fmc_hw";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException("fmc_hw timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_hw: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
