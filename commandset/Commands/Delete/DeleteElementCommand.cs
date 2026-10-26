using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Delete
{
    public class DeleteElementCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private DeleteElementEventHandler _handler => (DeleteElementEventHandler)Handler;

        public override string CommandName => "delete_element";

        public DeleteElementCommand(UIApplication uiApp)
            : base(new DeleteElementEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                try
                {
                    // 解析数组参数
                    var elementIds = parameters?["elementIds"]?.ToObject<string[]>();
                    if (elementIds == null || elementIds.Length == 0)
                    {
                        throw new ArgumentException("Give at least one element id");
                    }

                    // 设置要删除的元素ID数组
                    _handler.ElementIds = elementIds;

                    // 触发外部事件并等待完成
                    if (RaiseAndWaitForCompletion(300000)) // owner 26 Oct: big batches take Revit over 10 s; wait up to 5 min
                    {
                        if (_handler.IsSuccess)
                        {
                            return new { deleted = true, count = _handler.DeletedCount };
                        }
                        else
                        {
                            throw new Exception("[FMC-TOOL-FAILED] Deleting the elements failed");
                        }
                    }
                    else
                    {
                        throw new TimeoutException("[FMC-BRIDGE-TIMEOUT] Deleting the elements timed out");
                    }
                }
                catch (Exception ex)
                {
                    throw new Exception($"[FMC-TOOL-FAILED] Deleting the elements failed: {ex.Message}");
                }
            }
        }
    }
}
