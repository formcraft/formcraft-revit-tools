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
    public class GetSelectedElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        // 执行结果
        public List<Models.Common.ElementInfo> ResultElements { get; private set; }

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
            try
            {
                using var target = FmcTarget.Resolve(app, FmcCallContext.Parameters ?? new Newtonsoft.Json.Linq.JObject(), false);
                var uiDoc = target.Ui ?? throw new InvalidOperationException($"[FMC-DOC-REQUIRED] Selection is only available when {target.Doc.Title} is the active document. Refusing to read the active document's selection.");
                var doc = target.Doc;

                // 获取当前选中的元素
                var selectedIds = uiDoc.Selection.GetElementIds();
                var selectedElements = selectedIds.Select(id => doc.GetElement(id)).ToList();

                // 应用数量限制
                if (Limit.HasValue && Limit.Value > 0)
                {
                    selectedElements = selectedElements.Take(Limit.Value).ToList();
                }

                // 转换为ElementInfo列表
                ResultElements = selectedElements.Select(element => new ElementInfo
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
            }
            catch (Exception ex)
            {
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", "Getting the selected elements failed: " + ex.Message);
                ResultElements = new List<Models.Common.ElementInfo>();
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
