using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_pointcloud_read: element meshes in metres and the linked point clouds, for the deviation report. Read-only.</summary>
    public class FmcPointCloudReadCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPointCloudHandler HandlerCast => (FmcPointCloudHandler)Handler;
        public FmcPointCloudReadCommand(UIApplication uiApp) : base(new FmcPointCloudHandler(), uiApp) { }
        public override string CommandName => "fmc_pointcloud_read";
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException("fmc_pointcloud_read timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error)) throw new Exception("fmc_pointcloud_read: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
