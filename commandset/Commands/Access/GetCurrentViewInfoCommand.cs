using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace RevitMCPCommandSet.Commands.Access
{
    public class GetCurrentViewInfoCommand : ExternalEventCommandBase
    {
        private GetCurrentViewInfoEventHandler _handler => (GetCurrentViewInfoEventHandler)Handler;

        public override string CommandName => "get_current_view_info";

        public GetCurrentViewInfoCommand(UIApplication uiApp)
            : base(new GetCurrentViewInfoEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            FmcCallContext.Begin(parameters);
            // 触发外部事件并等待完成
            if (RaiseAndWaitForCompletion(10000)) // 10秒超时
            {
                if (!string.IsNullOrEmpty(_handler.Error)) throw new InvalidOperationException(_handler.Error.StartsWith("[FMC-") ? _handler.Error : "[FMC-TOOL-FAILED] Reading the view information failed: " + _handler.Error);
                if (_handler.ResultInfo == null) throw new InvalidOperationException("[FMC-TOOL-FAILED] Reading the view information returned nothing");
                return _handler.ResultInfo;
            }
            else
            {
                throw new TimeoutException("[FMC-BRIDGE-TIMEOUT] Reading the view information timed out");
            }
        }
    }
}
