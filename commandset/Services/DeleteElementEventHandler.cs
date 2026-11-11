using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services
{
    public class DeleteElementEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        // 执行结果
        public bool IsSuccess { get; private set; }

        // 成功删除的元素数量
        public int DeletedCount { get; private set; }
        // 状态同步对象
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        // 要删除的元素ID数组
        public string[] ElementIds { get; set; }
        public JObject Parameters { get; set; } = new JObject();
        public string Error { get; private set; }
        // 实现IWaitableExternalEventHandler接口
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
        return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }
        public void Execute(UIApplication app)
        {
            Error = null;
            try
            {
                // FmcTarget.Resolve starts the AI job (F-032) and refuses a named document that is not open.
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                var doc = target.Doc;
                DeletedCount = 0;
                if (ElementIds == null || ElementIds.Length == 0)
                {
                    IsSuccess = false;
                    return;
                }
                // 创建待删除元素ID集合
                List<ElementId> elementIdsToDelete = new List<ElementId>();
                List<string> invalidIds = new List<string>();
                foreach (var idStr in ElementIds)
                {
                    if (long.TryParse(idStr, out long elementIdValue))
                    {
                        var elementId = new ElementId(elementIdValue);
                        // 检查元素是否存在
                        if (doc.GetElement(elementId) != null)
                        {
                            elementIdsToDelete.Add(elementId);
                        }
                    }
                    else
                    {
                        invalidIds.Add(idStr);
                    }
                }
                if (invalidIds.Count > 0)
                {
                    RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Warning", $"These ids are invalid or the elements don't exist: {string.Join(", ", invalidIds)}");
                }
                // 如果有可删除的元素，则执行删除
                if (elementIdsToDelete.Count > 0)
                {
                    using (var transaction = new Transaction(doc, "Delete Elements"))
                    {
                        transaction.Start();

                        // 批量删除元素
                        ICollection<ElementId> deletedIds = doc.Delete(elementIdsToDelete);
                        DeletedCount = deletedIds.Count;

                        transaction.Commit();
                    }
                    IsSuccess = true;
                }
                else
                {
                    RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", "No valid elements to delete");
                    IsSuccess = false;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", "Deleting elements failed: " + ex.Message);
                IsSuccess = false;
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }
        public string GetName()
        {
            return "删除元素";
        }
    }
}
