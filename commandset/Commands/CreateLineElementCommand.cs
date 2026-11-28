using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services;
using RevitMCPCommandSet.Services.Fmc;
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

                // The category rule (FmcLineCategory): the server decides the role and says so in _category_admin; absent means not admin.
                bool admin = parameters["_category_admin"]?.Type == JTokenType.Boolean && parameters["_category_admin"].Value<bool>();
                foreach (var item in data)
                {
                    string refused = FmcLineCategory.Refusal(item.Category, admin);
                    if (refused != null) throw new InvalidOperationException(refused);
                }

                // 设置线状构件体参数
                FmcCallContext.Begin(parameters);
                _handler.CategoryAdmin = admin;
                _handler.SetParameters(data);

                // 触发外部事件并等待完成
                if (RaiseAndWaitForCompletion(300000)) // owner 26 Oct: big batches take Revit over 10 s; wait up to 5 min
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
                // A coded category refusal keeps its code first
                if (ex.Message.StartsWith("[FMC-LINE-CATEGORY-")) throw new Exception(ex.Message);
                throw new Exception($"[FMC-TOOL-FAILED] Creating line-based elements failed: {ex.Message}");
            }
        }
    }
}
