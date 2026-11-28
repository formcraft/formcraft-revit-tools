using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPCommandSet.Services.Fmc.SystemTypes;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services
{
    public class CreateLineElementEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private UIApplication uiApp;
        private Document doc => FmcCallContext.Document(uiApp);
        private Autodesk.Revit.ApplicationServices.Application app => uiApp.Application;
        /// <summary>
        /// 事件等待对象
        /// </summary>
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        /// <summary>
        /// 创建数据（传入数据）
        /// </summary>
        public List<LineElement> CreatedInfo { get; private set; }
        /// <summary>
        /// 执行结果（传出数据）
        /// </summary>
        public AIResult<List<long>> Result { get; private set; }
        private List<string> _warnings = new List<string>();
        private JArray _items = new JArray();

        /// <summary>A per-item refusal: every item answers, none is skipped silently.</summary>
        private void Refuse(int item, string code, string reason) =>
            _items.Add(new JObject { ["item"] = item, ["ok"] = false, ["code"] = code, ["reason"] = reason });

        public string _wallName = "常规 - ";
        public string _ductName = "矩形风管 - ";

        /// <summary>
        /// 设置创建的参数
        /// </summary>
        public void SetParameters(List<LineElement> data)
        {
            CreatedInfo = data;
            _resetEvent.Reset();
        }
        public void Execute(UIApplication uiapp)
        {
            // F-032: an AI job (default failures handling, the save reminder kept from blocking). commandset/Bridge/FmcAiJob.cs
            RevitMCPCommandSet.Bridge.FmcAiJob.Enter(uiapp, "");
            uiApp = uiapp;

            try
            {
                var elementIds = new List<long>();
                _warnings.Clear();
                _items = new JArray();
                int itemNo = 0;
                foreach (var data in CreatedInfo)
                {
                    itemNo++;
                    long requestedTypeId = data.TypeId;
                    int madeBefore = elementIds.Count;

                    // Step0 获取构件类型
                    BuiltInCategory builtInCategory = BuiltInCategory.INVALID;
                    Enum.TryParse(data.Category.Replace(".", ""), true, out builtInCategory);

                    // Step1 获取标高和偏移
                    Level baseLevel = null;
                    Level topLevel = null;
                    double topOffset = -1;  // ft
                    double baseOffset = -1; // ft
                    baseLevel = doc.FindNearestLevel(data.BaseLevel / 304.8);
                    topLevel = doc.FindNearestLevel((data.BaseLevel + data.BaseOffset + data.Height) / 304.8);
                    if (baseLevel == null || topLevel == null)
                    {
                        Refuse(itemNo, "FMC-NO-LEVEL", "the model has no level near baseLevel");
                        continue;
                    }
                    baseOffset = (data.BaseOffset + data.BaseLevel) / 304.8 - baseLevel.Elevation;
                    topOffset = (data.BaseLevel + data.BaseOffset + data.Height) / 304.8 - topLevel.Elevation;

                    // Step2 获取族类型
                    FamilySymbol symbol = null;
                    WallType wallType = null;
                    DuctType ductType = null;

                    // Review gap 11 (28 Nov): no silent first type and no ignored thickness. The typeId is used, or refused
                    // when it is missing or doesn't fit; with no typeId a wall is the one wall type of that thickness.
                    Element typeEle = data.TypeId != -1 && data.TypeId != 0 ? doc.GetElement(new ElementId(data.TypeId)) : null;
                    if (typeEle is FamilySymbol fsym) builtInCategory = (BuiltInCategory)fsym.Category.Id.GetIntValue();
                    else if (typeEle is WallType) builtInCategory = BuiltInCategory.OST_Walls;
                    else if (typeEle is DuctType) builtInCategory = BuiltInCategory.OST_DuctCurves;
                    if (builtInCategory == BuiltInCategory.INVALID)
                    {
                        Refuse(itemNo, "FMC-BAD-CATEGORY", $"category {data.Category} isn't a Revit category and typeId {data.TypeId} names no type");
                        continue;
                    }
                    var candidates = new List<TypeEditCore.TypeCandidate>();
                    bool layered = builtInCategory == BuiltInCategory.OST_Walls;
                    if (layered)
                        candidates = new FilteredElementCollector(doc).OfClass(typeof(WallType)).Cast<WallType>()
                            .Where(w => w.Kind == WallKind.Basic)
                            .Select(w => new TypeEditCore.TypeCandidate { Id = w.Id.GetValue(), Name = w.Name, WidthMm = w.Width * 304.8 }).ToList();
                    else if (builtInCategory == BuiltInCategory.OST_DuctCurves)
                        candidates = new FilteredElementCollector(doc).OfClass(typeof(DuctType)).Cast<DuctType>()
                            .Select(d => new TypeEditCore.TypeCandidate { Id = d.Id.GetValue(), Name = d.Name }).ToList();
                    else
                        candidates = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(builtInCategory).Cast<FamilySymbol>()
                            .Select(f => new TypeEditCore.TypeCandidate { Id = f.Id.GetValue(), Name = $"{f.FamilyName} : {f.Name}" }).ToList();
                    bool fits = typeEle != null && candidates.Any(c => c.Id == data.TypeId) || typeEle is WallType;
                    var pick = TypeEditCore.PickType(builtInCategory.ToString(), requestedTypeId, typeEle != null, fits, data.Thickness, layered, candidates);
                    if (!pick.Ok) { Refuse(itemNo, pick.Code, pick.Reason); continue; }
                    Element picked = doc.GetElement(new ElementId(pick.Id.Value));
                    wallType = picked as WallType; ductType = picked as DuctType; symbol = picked as FamilySymbol;
                    if (pick.Note != null) _warnings.Add($"item {itemNo}: {pick.Note}");

                    using (Transaction transaction = new Transaction(doc, "创建点状构件"))
                    {
                        transaction.Start();
                        switch (builtInCategory)
                        {
                            case BuiltInCategory.OST_Walls:
                                Wall wall = null;
                                wall = Wall.Create
                                (
                                  doc,
                                  JZLine.ToLine(data.LocationLine),
                                  wallType.Id,
                                  baseLevel.Id,
                                  data.Height / 304.8,
                                  baseOffset,
                                  false,
                                  false
                                );
                                if (wall != null)
                                {
                                    elementIds.Add(wall.Id.GetValue());
                                }
                                break;
                            case BuiltInCategory.OST_DuctCurves:
                                Duct duct = null;
                                // 获取MEP系统类型（必需）
                                MEPSystemType mepSystemType = new FilteredElementCollector(doc)
                                    .OfClass(typeof(MEPSystemType))
                                    .Cast<MEPSystemType>()
                                    .FirstOrDefault(m => m.SystemClassification == MEPSystemClassification.SupplyAir);

                                if (mepSystemType != null)
                                {
                                    duct = Duct.Create(
                                        doc,
                                        mepSystemType.Id,
                                        ductType.Id,
                                        baseLevel.Id,
                                        JZLine.ToLine(data.LocationLine).GetEndPoint(0),
                                        JZLine.ToLine(data.LocationLine).GetEndPoint(1)
                                    );

                                    if (duct != null)
                                    {
                                        // 设置高度偏移
                                        Parameter offsetParam = duct.get_Parameter(BuiltInParameter.RBS_OFFSET_PARAM);
                                        if (offsetParam != null)
                                            offsetParam.Set(baseOffset);
                                        elementIds.Add(duct.Id.GetValue());
                                    }
                                }
                                break;
                            default:
                                if (!symbol.IsActive)
                                    symbol.Activate();

                                // 调用FamilyInstance通用创建方法
                                var instance = doc.CreateInstance(symbol, null, JZLine.ToLine(data.LocationLine), baseLevel, topLevel, baseOffset, topOffset);
                                if (instance != null)
                                {
                                    elementIds.Add(instance.Id.GetValue());
                                }
                                break;
                        }
                        //doc.Refresh();
                        transaction.Commit();
                    }
                    if (elementIds.Count > madeBefore) _items.Add(new JObject { ["item"] = itemNo, ["ok"] = true, ["id"] = elementIds[elementIds.Count - 1], ["type_id"] = pick.Id });
                    else Refuse(itemNo, "FMC-NOT-MADE", builtInCategory == BuiltInCategory.OST_DuctCurves ? "no supply air system type in this model, so no duct was made" : "Revit made nothing for this item");
                }
                int refused = _items.Count(x => !x.Value<bool>("ok"));
                string message = $"Created {elementIds.Count} of {CreatedInfo.Count} element(s)" + (refused > 0 ? $"; {refused} refused, nothing made for them: " +
                    string.Join(" | ", _items.Where(x => !x.Value<bool>("ok")).Select(x => $"item {x["item"]} [{x["code"]}] {x["reason"]}")) : ".");
                if (_warnings.Count > 0)
                {
                    message += "\n\n⚠ Warnings:\n  • " + string.Join("\n  • ", _warnings);
                }
                Result = new ItemsResult<List<long>>
                {
                    Success = refused == 0,
                    Message = message,
                    Response = elementIds,
                    Items = _items,
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<List<long>>
                {
                    Success = false,
                    Message = $"[FMC-TOOL-FAILED] Creating line-based elements failed: {ex.Message}",
                };
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", $"Creating line-based elements failed: {ex.Message}");
            }
            finally
            {
                _resetEvent.Set(); // 通知等待线程操作已完成
            }
        }

        /// <summary>
        /// 等待创建完成
        /// </summary>
        /// <param name="timeoutMilliseconds">超时时间（毫秒）</param>
        /// <returns>操作是否在超时前完成</returns>
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        /// <summary>
        /// IExternalEventHandler.GetName 实现
        /// </summary>
        public string GetName()
        {
            return "创建线状构件";
        }

        // The CreateOrGetWallType / CreateOrGetDuctType helpers (never called) were removed with review gap 11:
        // a new thickness is made deliberately with modify_model duplicate_type, never as a side effect of creating a wall.
    }
}
