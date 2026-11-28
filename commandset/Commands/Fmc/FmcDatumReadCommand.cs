using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_datum_read: the read behind the grid, level, dimension and placement dry runs. No transaction.</summary>
    public class FmcDatumReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDatumReadHandler HandlerCast => (FmcDatumReadHandler)Handler;
        public FmcDatumReadCommand(UIApplication uiApp) : base(new FmcDatumReadHandler(), uiApp) { }
        public override string CommandName => "fmc_datum_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                FmcCallContext.Begin(parameters);
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException("fmc_datum_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_datum_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
