using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Access
{
    public class GetCurrentViewElementsCommand : ExternalEventCommandBase
    {
        private GetCurrentViewElementsEventHandler _handler => (GetCurrentViewElementsEventHandler)Handler;

        public override string CommandName => "get_current_view_elements";

        public GetCurrentViewElementsCommand(UIApplication uiApp)
            : base(new GetCurrentViewElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                FmcCallContext.Begin(parameters);
                // 解析参数
                List<string> modelCategoryList = parameters?["modelCategoryList"]?.ToObject<List<string>>() ?? new List<string>();
                List<string> annotationCategoryList = parameters?["annotationCategoryList"]?.ToObject<List<string>>() ?? new List<string>();
                bool includeHidden = parameters?["includeHidden"]?.Value<bool>() ?? false;
                int limit = parameters?["limit"]?.Value<int>() ?? 100;

                // 设置查询参数
                _handler.SetQueryParameters(modelCategoryList, annotationCategoryList, includeHidden, limit);

                // 触发外部事件并等待完成
                if (RaiseAndWaitForCompletion(60000)) // 60秒超时
                {
                    if (!string.IsNullOrEmpty(_handler.Error)) throw new InvalidOperationException(_handler.Error);
                    if (_handler.ResultInfo == null) throw new InvalidOperationException("the read returned nothing");
                    return _handler.ResultInfo;
                }
                else
                {
                    throw new TimeoutException("[FMC-BRIDGE-TIMEOUT] Reading the view's elements timed out");
                }
            }
            catch (Exception ex)
            {
                // A coded refusal (FMC-DOC-NOT-FOUND, FMC-VIEW-NONE) keeps its code as the first thing in the message
                if (ex.Message.StartsWith("[FMC-") && !ex.Message.StartsWith("[FMC-BRIDGE-TIMEOUT]")) throw new Exception(ex.Message);
                throw new Exception($"[FMC-TOOL-FAILED] Reading the view's elements failed: {ex.Message}");
            }
        }
    }
}
