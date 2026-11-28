using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services
{
    public class GetCurrentViewInfoEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        // 执行结果
        public CurrentViewInfo ResultInfo { get; private set; }
        public string Error { get; private set; }

        // VI-4: verbose adds crop, template, phase, discipline, level and view filters.
        public bool Verbose { get; set; }

        // 状态同步对象
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        // 实现IWaitableExternalEventHandler接口
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            ResultInfo = null;
            Error = null;
            try
            {
                var doc = FmcCallContext.Document(app);
                var activeView = doc.ActiveView;

                var info = Verbose ? new CurrentViewInfoVerbose() : new CurrentViewInfo();
                ResultInfo = info;
                if (info is CurrentViewInfoVerbose v)
                    FillVerbose(doc, activeView, v);
                {
                    var r = info;
                    r.Id = IdOf(activeView.Id);
                    r.UniqueId = activeView.UniqueId;
                    r.Name = activeView.Name;
                    r.ViewType = activeView.ViewType.ToString();
                    r.IsTemplate = activeView.IsTemplate;
                    r.Scale = activeView.Scale;
                    r.DetailLevel = activeView.DetailLevel.ToString();
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
                ResultInfo = null;
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", "Getting the view information failed");
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        private static long IdOf(ElementId id)
        {
#if REVIT2024_OR_GREATER
            return id.Value;
#else
            return id.IntegerValue;
#endif
        }

        private static long? IdOrNull(ElementId id) => id == null || id == ElementId.InvalidElementId ? (long?)null : IdOf(id);

        // Each property is read on its own: a view type that does not support one leaves it null, never fails the call.
        private static void FillVerbose(Document doc, View view, CurrentViewInfoVerbose v)
        {
            T Try<T>(Func<T> f) { try { return f(); } catch { return default(T); } }

            v.Title = Try(() => view.Title);
            v.CropBoxActive = Try(() => (bool?)view.CropBoxActive);
            v.CropBoxVisible = Try(() => (bool?)view.CropBoxVisible);
            var templateId = Try(() => view.ViewTemplateId);
            v.ViewTemplateId = IdOrNull(templateId);
            if (v.ViewTemplateId != null) v.ViewTemplateName = Try(() => doc.GetElement(templateId)?.Name);
            var phaseParam = Try(() => view.get_Parameter(BuiltInParameter.VIEW_PHASE));
            var phaseId = Try(() => phaseParam?.AsElementId());
            v.PhaseId = IdOrNull(phaseId);
            if (v.PhaseId != null) v.PhaseName = Try(() => doc.GetElement(phaseId)?.Name);
            v.PhaseFilter = Try(() => view.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER)?.AsValueString());
            v.Discipline = Try(() => view.HasViewDiscipline() ? view.Discipline.ToString() : null);
            var level = Try(() => view.GenLevel);
            if (level != null) { v.GenLevelId = IdOf(level.Id); v.GenLevelName = level.Name; }
            v.DisplayStyle = Try(() => view.DisplayStyle.ToString());
            v.Filters = Try(() =>
            {
                if (!view.AreGraphicsOverridesAllowed()) return null;
                var list = new List<ViewFilterRef>();
                foreach (var fid in view.GetFilters())
                {
                    list.Add(new ViewFilterRef
                    {
                        Id = IdOf(fid),
                        Name = Try(() => doc.GetElement(fid)?.Name),
                        Visible = Try(() => (bool?)view.GetFilterVisibility(fid)),
                        Enabled = Try(() => (bool?)view.GetIsFilterEnabled(fid)),
                    });
                }
                return list;
            });
        }

        public string GetName()
        {
            return "获取当前视图信息";
        }
    }
}
