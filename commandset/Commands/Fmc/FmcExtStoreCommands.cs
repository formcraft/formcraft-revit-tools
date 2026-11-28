using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_extstore read and audit (GAP-19): FMC_ExtStore records on elements. Read-only.</summary>
    public class FmcExtStoreReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcExtStoreReadHandler HandlerCast => (FmcExtStoreReadHandler)Handler;
        public FmcExtStoreReadCommand(UIApplication uiApp) : base(new FmcExtStoreReadHandler(), uiApp) { }
        public override string CommandName => "fmc_extstore_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000)) throw new TimeoutException("fmc_extstore_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_extstore_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>fmc_extstore write (GAP-19): one transaction, under a batch lease, behind the live-model lock.</summary>
    public class FmcExtStoreWriteCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcExtStoreWriteHandler HandlerCast => (FmcExtStoreWriteHandler)Handler;
        public FmcExtStoreWriteCommand(UIApplication uiApp) : base(new FmcExtStoreWriteHandler(), uiApp) { }
        public override string CommandName => "fmc_extstore_write";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_extstore_write timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_extstore_write: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
