using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace RevitMCPCommandSet.Commands
{
    public class OperateElementCommand : ExternalEventCommandBase
    {
        private OperateElementEventHandler _handler => (OperateElementEventHandler)Handler;

        /// <summary>
        /// 命令名称
        /// </summary>
        public override string CommandName => "operate_element";

        /// <summary>
        /// 构造函数
        /// </summary>
        /// <param name="uiApp">Revit UIApplication</param>
        public OperateElementCommand(UIApplication uiApp)
            : base(new OperateElementEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                OperationSetting data = new OperationSetting();
                // 解析参数
                data = parameters["data"].ToObject<OperationSetting>();
                if (data == null)
                    throw new ArgumentNullException(nameof(data), "No data was sent");

                // 设置点状构件体参数
                _handler.SetParameters(data);

                // 触发外部事件并等待完成
                if (RaiseAndWaitForCompletion(300000)) // owner 26 Oct: big batches take Revit over 10 s; wait up to 5 min
                {
                    return _handler.Result;
                }
                else
                {
                    throw new TimeoutException("[FMC-BRIDGE-TIMEOUT] Operating on the elements timed out");
                }
            }
            catch (Exception ex)
            {
                throw new Exception($"[FMC-TOOL-FAILED] Operating on the elements failed: {ex.Message}");
            }
        }
    }
}
