using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Interfaces;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace RevitMCPCommandSet.Services
{
    /// <summary>GSE-3 reply: which document was read, how many were selected, and whether the cap hid some.</summary>
    public class SelectedElementsResult
    {
        [Newtonsoft.Json.JsonProperty("document")]
        public string Document { get; set; }
        [Newtonsoft.Json.JsonProperty("count")]
        public int Count { get; set; }
        [Newtonsoft.Json.JsonProperty("limit")]
        public int Limit { get; set; }
        [Newtonsoft.Json.JsonProperty("truncated")]
        public bool Truncated { get; set; }
        [Newtonsoft.Json.JsonProperty("elements")]
        public List<Models.Common.ElementInfo> Elements { get; set; } = new List<Models.Common.ElementInfo>();
    }

    public class GetSelectedElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        // 执行结果
        public SelectedElementsResult Result { get; private set; }
        public string Error { get; private set; }

        // 状态同步对象
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        // 限制返回的元素数量
        public int? Limit { get; set; }

        // 实现IWaitableExternalEventHandler接口
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = null;
            Error = null;
            try
            {
                using var target = FmcTarget.Resolve(app, FmcCallContext.Parameters ?? new Newtonsoft.Json.Linq.JObject(), false);
                var uiDoc = target.Ui ?? throw new InvalidOperationException($"[FMC-DOC-REQUIRED] Selection is only available when {target.Doc.Title} is the active document. Refusing to read the active document's selection.");
                var doc = target.Doc;

                // 获取当前选中的元素
                var selectedIds = uiDoc.Selection.GetElementIds();
                var selectedElements = selectedIds.Select(id => doc.GetElement(id)).Where(e => e != null).ToList();

                // GSE-3: count is the whole selection; truncated says when the cap hid the rest.
                var page = FmcReadShape.Cap(selectedElements, Limit, 100);

                // 转换为ElementInfo列表
                var infos = page.Items.Select(element => new ElementInfo
                {
#if REVIT2024_OR_GREATER
                    Id = element.Id.Value,
#else
                    Id = element.Id.IntegerValue,
#endif
                    UniqueId = element.UniqueId,
                    Name = element.Name,
                    Category = element.Category?.Name
                }).ToList();

                Result = new SelectedElementsResult
                {
                    Document = doc.Title,
                    Count = page.Count,
                    Limit = page.Limit,
                    Truncated = page.Truncated,
                    Elements = infos,
                };
            }
            catch (Exception ex)
            {
                // GSE-1/GSE-3: FMC-DOC-REQUIRED and other failures are errors, never a successful empty list.
                Error = ex.Message;
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", "Getting the selected elements failed: " + ex.Message);
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        public string GetName()
        {
            return "获取选中元素";
        }
    }
}
