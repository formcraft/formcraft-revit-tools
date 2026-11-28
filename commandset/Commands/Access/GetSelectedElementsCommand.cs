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
    public class GetSelectedElementsCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private GetSelectedElementsEventHandler _handler => (GetSelectedElementsEventHandler)Handler;

        public override string CommandName => "get_selected_elements";

        public GetSelectedElementsCommand(UIApplication uiApp)
            : base(new GetSelectedElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                try
                {
                    FmcCallContext.Begin(parameters);
                    // 解析参数
                    int? limit = parameters?["limit"]?.Value<int>();

                    // 设置数量限制
                    _handler.Limit = limit;

                    // 触发外部事件并等待完成
                    if (RaiseAndWaitForCompletion(15000))
                    {
                        if (!string.IsNullOrEmpty(_handler.Error))
                            throw new InvalidOperationException(_handler.Error);
                        return _handler.Result;
                    }
                    else
                    {
                        throw new TimeoutException("[FMC-BRIDGE-TIMEOUT] Reading the selection timed out");
                    }
                }
                catch (Exception ex)
                {
                    throw new Exception($"[FMC-TOOL-FAILED] Reading the selection failed: {ex.Message}");
                }
            }
        }
    }
}
