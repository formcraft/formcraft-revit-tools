using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_exports run (GAP-04): IFC4/DWG/NWC/gbXML into the server's arrival folder, or a check only. The model is not changed.</summary>
    public class FmcExportsRunCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcExportsHandler HandlerCast => (FmcExportsHandler)Handler;
        public FmcExportsRunCommand(UIApplication uiApp) : base(new FmcExportsHandler(), uiApp) { }
        public override string CommandName => "fmc_exports_run";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(1800000)) throw new TimeoutException("fmc_exports_run timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_exports_run: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
