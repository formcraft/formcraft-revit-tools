using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands
{
    public class CreateLineElementCommand : ExternalEventCommandBase
    {
        private CreateLineElementEventHandler _handler => (CreateLineElementEventHandler)Handler;

        /// <summary>
        /// 命令名称
        /// </summary>
        public override string CommandName => "create_line_based_element";

        /// <summary>
        /// 构造函数
        /// </summary>
        /// <param name="uiApp">Revit UIApplication</param>
        public CreateLineElementCommand(UIApplication uiApp)
            : base(new CreateLineElementEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                List<LineElement> data = new List<LineElement>();
                // 解析参数
                data = parameters["data"].ToObject<List<LineElement>>();
                if (data == null)
                    throw new ArgumentNullException(nameof(data), "No data was sent");

                // 设置线状构件体参数
                _handler.SetParameters(data);

                // 触发外部事件并等待完成
                if (RaiseAndWaitForCompletion(10000))
                {
                    return _handler.Result;
                }
                else
                {
                    throw new TimeoutException("[FMC-BRIDGE-TIMEOUT] Creating line-based elements timed out");
                }
            }
            catch (Exception ex)
            {
                throw new Exception($"[FMC-TOOL-FAILED] Creating line-based elements failed: {ex.Message}");
            }
        }
    }
}
