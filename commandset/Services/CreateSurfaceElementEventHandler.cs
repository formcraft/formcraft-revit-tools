using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPCommandSet.Services.Fmc.SystemTypes;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services
{
    public class CreateSurfaceElementEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
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
        public List<SurfaceElement> CreatedInfo { get; private set; }
        /// <summary>
        /// 执行结果（传出数据）
        /// </summary>
        public AIResult<List<long>> Result { get; private set; }
        public string _floorName = "常规 - ";
        public bool _structural = true;
        private List<string> _warnings = new List<string>();
        private JArray _items = new JArray();

        /// <summary>A per-item refusal: every item answers, none is skipped silently.</summary>
        private void Refuse(int item, string code, string reason) =>
            _items.Add(new JObject { ["item"] = item, ["ok"] = false, ["code"] = code, ["reason"] = reason });

        /// <summary>A layered type's total thickness in mm (null when it has no layers).</summary>
        private static double? LayerWidthMm(HostObjAttributes t)
        {
            try { CompoundStructure cs = t.GetCompoundStructure(); return cs == null ? (double?)null : cs.GetWidth() * 304.8; }
            catch (Exception) { return null; }
        }

        /// <summary>
        /// 设置创建的参数
        /// </summary>
        public void SetParameters(List<SurfaceElement> data)
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
                    Enum.TryParse(data.Category.Replace(".", "").Replace("BuiltInCategory", ""), true, out builtInCategory);

                    // Step1 获取标高和偏移
                    Level baseLevel = null;
                    Level topLevel = null;
                    double topOffset = -1;  // ft
                    double baseOffset = -1; // ft
                    baseLevel = doc.FindNearestLevel(data.BaseLevel / 304.8);
                    topLevel = doc.FindNearestLevel((data.BaseLevel + data.BaseOffset + data.Thickness) / 304.8);
                    if (baseLevel == null || topLevel == null)
                    {
                        Refuse(itemNo, "FMC-NO-LEVEL", "the model has no level near baseLevel");
                        continue;
                    }
                    baseOffset = (data.BaseOffset + data.BaseLevel) / 304.8 - baseLevel.Elevation;
                    topOffset = (data.BaseLevel + data.BaseOffset + data.Thickness) / 304.8 - topLevel.Elevation;

                    // Step2 获取族类型
                    FamilySymbol symbol = null;
                    FloorType floorType = null;
                    RoofType roofType = null;
                    CeilingType ceilingType = null;

                    // Review gap 11 (28 Nov): no silent first type and no ignored thickness. The typeId is used, or refused
                    // when it is missing or doesn't fit; with no typeId a floor, roof or ceiling is the one type of that thickness.
                    Element typeEle = data.TypeId != -1 && data.TypeId != 0 ? doc.GetElement(new ElementId(data.TypeId)) : null;
                    if (typeEle is FamilySymbol fsym) builtInCategory = (BuiltInCategory)fsym.Category.Id.GetIntValue();
                    else if (typeEle is FloorType) builtInCategory = BuiltInCategory.OST_Floors;
                    else if (typeEle is RoofType) builtInCategory = BuiltInCategory.OST_Roofs;
                    else if (typeEle is CeilingType) builtInCategory = BuiltInCategory.OST_Ceilings;
                    if (builtInCategory == BuiltInCategory.INVALID)
                    {
                        Refuse(itemNo, "FMC-BAD-CATEGORY", $"category {data.Category} isn't a Revit category and typeId {data.TypeId} names no type");
                        continue;
                    }
                    if (builtInCategory != BuiltInCategory.OST_Floors && builtInCategory != BuiltInCategory.OST_Roofs && builtInCategory != BuiltInCategory.OST_Ceilings)
                    {
                        // Only floors, roofs and ceilings are made below; anything else used to pass with nothing made
                        Refuse(itemNo, "FMC-BAD-CATEGORY", $"create_surface_based_element makes floors, roofs and ceilings, not {builtInCategory}");
                        continue;
                    }
                    Type cls = builtInCategory == BuiltInCategory.OST_Floors ? typeof(FloorType) : builtInCategory == BuiltInCategory.OST_Roofs ? typeof(RoofType) : typeof(CeilingType);
                    var candidates = new FilteredElementCollector(doc).OfClass(cls).OfCategory(builtInCategory).Cast<HostObjAttributes>()
                        .Select(t => new TypeEditCore.TypeCandidate { Id = t.Id.GetValue(), Name = t.Name, WidthMm = LayerWidthMm(t) }).ToList();
                    bool fits = typeEle != null && candidates.Any(c => c.Id == data.TypeId);
                    var pick = TypeEditCore.PickType(builtInCategory.ToString(), requestedTypeId, typeEle != null, fits, data.Thickness, true, candidates);
                    if (!pick.Ok) { Refuse(itemNo, pick.Code, pick.Reason); continue; }
                    Element picked = doc.GetElement(new ElementId(pick.Id.Value));
                    floorType = picked as FloorType; roofType = picked as RoofType; ceilingType = picked as CeilingType;
                    if (pick.Note != null) _warnings.Add($"item {itemNo}: {pick.Note}");

                    // Step3 批量创建楼板
                    Floor floor = null;
                    using (Transaction transaction = new Transaction(doc, "创建面状构件"))
                    {
                        transaction.Start();

                        switch (builtInCategory)
                        {
                            case BuiltInCategory.OST_Floors:
                                CurveArray curves = new CurveArray();
                                foreach (var jzLine in data.Boundary.OuterLoop)
                                {
                                    curves.Append(JZLine.ToLine(jzLine));
                                }
                                CurveLoop curveLoop = CurveLoop.Create(data.Boundary.OuterLoop.Select(l => JZLine.ToLine(l) as Curve).ToList());

                                // 多版本 - Floor.Create introduced in Revit 2022 but stable in 2023+
#if REVIT2023_OR_GREATER
                                floor = Floor.Create(doc, new List<CurveLoop> { curveLoop }, floorType.Id, baseLevel.Id);
#else
                                floor = doc.Create.NewFloor(curves, floorType, baseLevel, _structural);
#endif
                                //编辑楼板参数
                                if (floor != null)
                                {
                                    floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).Set(baseOffset);
                                    elementIds.Add(floor.Id.GetValue());
                                }
                                break;
                            case BuiltInCategory.OST_Roofs:
                                CurveArray roofCurves = new CurveArray();
                                foreach (var jzLine in data.Boundary.OuterLoop)
                                {
                                    roofCurves.Append(JZLine.ToLine(jzLine));
                                }

                                ModelCurveArray modelCurves = new ModelCurveArray();
                                FootPrintRoof roof = doc.Create.NewFootPrintRoof(roofCurves, baseLevel, roofType, out modelCurves);

                                if (roof != null)
                                {
                                    // Set all edges to non-sloped for flat roof
                                    foreach (ModelCurve mc in modelCurves)
                                    {
                                        roof.set_DefinesSlope(mc, false);
                                    }
                                    // Set the roof offset from level
                                    Parameter offsetParam = roof.get_Parameter(BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM);
                                    if (offsetParam != null)
                                    {
                                        offsetParam.Set(baseOffset);
                                    }
                                    elementIds.Add(roof.Id.GetValue());
                                }
                                break;
                            case BuiltInCategory.OST_Ceilings:
                                CurveLoop ceilingCurveLoop = CurveLoop.Create(data.Boundary.OuterLoop.Select(l => JZLine.ToLine(l) as Curve).ToList());

#if REVIT2022_OR_GREATER
                                Ceiling ceiling = Ceiling.Create(doc, new List<CurveLoop> { ceilingCurveLoop }, ceilingType.Id, baseLevel.Id);
#else
                                // Ceiling.Create API not available before Revit 2022
                                Ceiling ceiling = null;
                                _warnings.Add("Ceiling creation is not supported in Revit versions before 2022.");
#endif
                                if (ceiling != null)
                                {
                                    // Set the ceiling height offset from level
                                    Parameter ceilingOffsetParam = ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM);
                                    if (ceilingOffsetParam != null)
                                    {
                                        ceilingOffsetParam.Set(baseOffset);
                                    }
                                    elementIds.Add(ceiling.Id.GetValue());
                                }
                                break;
                            default:
                                break;
                        }

                        transaction.Commit();
                    }
                    if (elementIds.Count > madeBefore) _items.Add(new JObject { ["item"] = itemNo, ["ok"] = true, ["id"] = elementIds[elementIds.Count - 1], ["type_id"] = pick.Id });
                    else Refuse(itemNo, "FMC-NOT-MADE", "Revit made nothing for this item");
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
                    Message = $"[FMC-TOOL-FAILED] Creating surface-based elements failed: {ex.Message}",
                };
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", $"Creating surface-based elements failed: {ex.Message}");
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
            return "创建面状构件";
        }

        // CreateOrGetFloorType (never called; it set every layer to the full thickness) was removed with review gap 11:
        // a new thickness is made deliberately with modify_model duplicate_type, never as a side effect.
    }
}
