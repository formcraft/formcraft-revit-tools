using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Doors, windows, rooms, sheets, viewports and grids with their current numbers. Read-only: no transaction.</summary>
    public class FmcNumberingCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcNumberingHandler HandlerCast => (FmcNumberingHandler)Handler;
        public FmcNumberingCommand(UIApplication uiApp) : base(new FmcNumberingHandler(), uiApp) { }
        public override string CommandName => "fmc_numbering";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_numbering timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_numbering: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>One transaction for a numbering plan, all or nothing. Reads and the dry run stay on fmc_numbering.</summary>
    public class FmcNumberingApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcNumberingApplyHandler HandlerCast => (FmcNumberingApplyHandler)Handler;
        public FmcNumberingApplyCommand(UIApplication uiApp) : base(new FmcNumberingApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_numbering_apply";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_numbering_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_numbering_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}