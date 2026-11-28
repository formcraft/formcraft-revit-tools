using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Memory status. No transaction.</summary>
    public class FmcMemoryCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMemoryHandler HandlerCast => (FmcMemoryHandler)Handler;

        public FmcMemoryCommand(UIApplication uiApp) : base(new FmcMemoryHandler(), uiApp) { }
        public override string CommandName => "fmc_memory";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException("fmc_memory timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_memory: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>Close spare documents or purge unused elements. One transaction for the purge.</summary>
    public class FmcMemoryApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcMemoryHandler HandlerCast => (FmcMemoryHandler)Handler;

        public FmcMemoryApplyCommand(UIApplication uiApp) : base(new FmcMemoryHandler(), uiApp) { }
        public override string CommandName => "fmc_memory_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_memory_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_memory_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
