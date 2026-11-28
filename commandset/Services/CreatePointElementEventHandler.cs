using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services
{
    public class CreatePointElementEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
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
        public List<PointElement> CreatedInfo { get; private set; }
        /// <summary>
        /// 执行结果（传出数据）
        /// </summary>
        public AIItemsResult<List<long>> Result { get; private set; }

        /// <summary>error (default): an instance of the same type within 10 mm of the point is not placed again.</summary>
        public string OnDuplicate { get; set; } = "error";
        private List<string> _warnings = new List<string>();

        /// <summary>
        /// 设置创建的参数
        /// </summary>
        public void SetParameters(List<PointElement> data)
        {
            CreatedInfo = data;
            _resetEvent.Reset();
        }
        public void Execute(UIApplication uiapp)
        {
            // F-032: an AI job (default failures handling, the save reminder kept from blocking). commandset/Bridge/FmcAiJob.cs
            RevitMCPCommandSet.Bridge.FmcAiJob.Enter(uiapp, "");
            uiApp = uiapp;
            // One row per item (tool research create_point_based_element gaps 13, 14, 16): created with its id or
            // failed with a code. A null instance rolls back instead of committing, and nothing is skipped silently.
            var items = new List<Dictionary<string, object>>();
            int index = -1;

            try
            {
                var elementIds = new List<long>();
                _warnings.Clear();
                foreach (var data in CreatedInfo)
                {
                    index++;
                    long requestedTypeId = data.TypeId;

                    // Step0 获取构件类型
                    BuiltInCategory builtInCategory = BuiltInCategory.INVALID;
                    Enum.TryParse(data.Category.Replace(".", ""), true, out builtInCategory);

                    // Step1 获取标高和偏移
                    Level baseLevel = null;
                    Level topLevel = null;
                    double topOffset = -1;  // ft
                    double baseOffset = -1; // ft
                    baseLevel = doc.FindNearestLevel(data.BaseLevel / 304.8);
                    if (baseLevel == null)
                    {
                        items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-PLACE-NO-LEVEL", "The model has no level near baseLevel."));
                        continue;
                    }
                    baseOffset = (data.BaseOffset + data.BaseLevel) / 304.8 - baseLevel.Elevation;
                    topLevel = doc.FindNearestLevel((data.BaseLevel + data.BaseOffset + data.Height) / 304.8);
                    topOffset = topLevel == null ? 0 : (data.BaseLevel + data.BaseOffset + data.Height) / 304.8 - topLevel.Elevation;

                    // Step2 获取族类型
                    FamilySymbol symbol = null;
                    if (data.TypeId != -1 && data.TypeId != 0)
                    {
                        ElementId typeELeId = new ElementId(data.TypeId);
                        if (typeELeId != null)
                        {
                            Element typeEle = doc.GetElement(typeELeId);
                            if (typeEle != null && typeEle is FamilySymbol)
                            {
                                symbol = typeEle as FamilySymbol;
                                // 获取symbol的Category对象并转换为BuiltInCategory枚举
                                builtInCategory = (BuiltInCategory)symbol.Category.Id.GetIntValue();
                            }
                        }
                    }
                    if (builtInCategory == BuiltInCategory.INVALID)
                    {
                        items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-PLACE-NO-TYPE", $"typeId {requestedTypeId} is not a family type in this model, and no category was given."));
                        continue;
                    }
                    if (symbol == null)
                    {
                        symbol = new FilteredElementCollector(doc)
                            .OfClass(typeof(FamilySymbol))
                            .OfCategory(builtInCategory)
                            .Cast<FamilySymbol>()
                            .FirstOrDefault(fs => fs.IsActive); // 获取激活的类型作为默认类型
                        if (symbol == null)
                        {
                            symbol = new FilteredElementCollector(doc)
                            .OfClass(typeof(FamilySymbol))
                            .OfCategory(builtInCategory)
                            .Cast<FamilySymbol>()
                            .FirstOrDefault();
                        }
                        if (symbol == null)
                        {
                            _warnings.Add($"No family types available for category {builtInCategory}.");
                            items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-PLACE-NO-TYPE", $"No family types available for category {builtInCategory}."));
                            continue;
                        }
                        if (requestedTypeId != -1 && requestedTypeId != 0)
                        {
                            _warnings.Add($"Requested typeId {requestedTypeId} not found. Defaulted to '{symbol.FamilyName}: {symbol.Name}' (ID: {symbol.Id.GetValue()})");
                        }
                    }
                    if (symbol == null)
                    {
                        items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-PLACE-NO-TYPE", "No family type was found."));
                        continue;
                    }

                    // No silent duplicates: an instance of this type already at this point is an error, not a second copy.
                    if (!string.Equals(OnDuplicate, "allow", StringComparison.OrdinalIgnoreCase) && data.LocationPoint != null)
                    {
                        XYZ want = JZPoint.ToXYZ(data.LocationPoint);
                        FamilyInstance twin = new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>()
                            .FirstOrDefault(fi => fi.Symbol != null && fi.Symbol.Id == symbol.Id && fi.Location is LocationPoint lp
                                && FmcPlacementCore.SamePoint(lp.Point.X * 304.8, lp.Point.Y * 304.8, lp.Point.Z * 304.8, want.X * 304.8, want.Y * 304.8, want.Z * 304.8, 10.0));
                        if (twin != null)
                        {
                            items.Add(FmcPlacementCore.Item(index, "failed", twin.Id.GetValue(), "FMC-PLACE-DUPLICATE", "An instance of this type already stands at this point (within 10 mm). Nothing was placed on top of it."));
                            continue;
                        }
                    }

                    // Step3 调用通用方法创建族实例
                    using (Transaction transaction = new Transaction(doc, "创建点状构件"))
                    {
                        transaction.Start();

                        if (!symbol.IsActive)
                            symbol.Activate();

                        // Resolve explicit host wall if provided
                        Element explicitHost = null;
                        if (data.HostWallId > 0)
                        {
                            ElementId hostId = new ElementId(data.HostWallId);
                            Element hostElem = doc.GetElement(hostId);
                            if (hostElem is Wall)
                            {
                                explicitHost = hostElem;
                            }
                            else
                            {
                                // Research gap 16: a named host that is not a wall is an error, not a guess.
                                transaction.RollBack();
                                items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-PLACE-HOST", $"hostWallId {data.HostWallId} is not a wall. Nothing was placed."));
                                continue;
                            }
                        }

                        var instance = doc.CreateInstance(
                            symbol,
                            JZPoint.ToXYZ(data.LocationPoint),
                            null,           // locationLine
                            baseLevel,
                            topLevel,
                            baseOffset,
                            topOffset,
                            null,           // faceDirection
                            null,           // handDirection
                            null,           // view
                            explicitHost,   // explicit host wall
                            true);          // snap to host center

                        if (instance != null)
                        {
                            // Handle orientation for doors and windows
                            if (builtInCategory == BuiltInCategory.OST_Doors ||
                                builtInCategory == BuiltInCategory.OST_Windows)
                            {
                                doc.Regenerate();

                                bool shouldFlip = data.FacingFlipped;

                                // Auto-detect facing based on which side of the wall
                                // the original (pre-snap) placement point was on
                                if (!shouldFlip)
                                {
                                    Wall hostWall = instance.Host as Wall;
                                    if (hostWall != null)
                                    {
                                        LocationCurve locCurve = hostWall.Location as LocationCurve;
                                        if (locCurve != null)
                                        {
                                            XYZ originalPt = JZPoint.ToXYZ(data.LocationPoint);
                                            XYZ wallStart = locCurve.Curve.GetEndPoint(0);
                                            XYZ wallEnd = locCurve.Curve.GetEndPoint(1);
                                            XYZ wallDir = new XYZ(wallEnd.X - wallStart.X, wallEnd.Y - wallStart.Y, 0).Normalize();
                                            XYZ wallNormal = wallDir.CrossProduct(XYZ.BasisZ).Normalize();

                                            IntersectionResult ir = locCurve.Curve.Project(originalPt);
                                            if (ir != null)
                                            {
                                                XYZ centerPt = ir.XYZPoint;
                                                double side = (originalPt - centerPt).DotProduct(wallNormal);

                                                // If the point is on the negative-normal side but
                                                // instance faces positive-normal (or vice versa), flip
                                                double facingDot = instance.FacingOrientation.DotProduct(wallNormal);
                                                if ((side < -1e-10 && facingDot > 0) ||
                                                    (side > 1e-10 && facingDot < 0))
                                                {
                                                    shouldFlip = true;
                                                }
                                            }
                                        }
                                    }
                                }

                                if (shouldFlip)
                                {
                                    instance.flipFacing();
                                    doc.Regenerate();
                                }
                            }

                            // Handle rotation for non-hosted elements (furniture, generic models)
                            if (data.Rotation != 0 &&
                                builtInCategory != BuiltInCategory.OST_Doors &&
                                builtInCategory != BuiltInCategory.OST_Windows)
                            {
                                XYZ origin = JZPoint.ToXYZ(data.LocationPoint);
                                Line rotationAxis = Line.CreateBound(origin, origin + XYZ.BasisZ);
                                double angleRadians = data.Rotation * Math.PI / 180.0;
                                ElementTransformUtils.RotateElement(doc, instance.Id, rotationAxis, angleRadians);
                            }

                            elementIds.Add(instance.Id.GetValue());
                            transaction.Commit();
                            items.Add(FmcPlacementCore.Item(index, "created", instance.Id.GetValue()));
                        }
                        else
                        {
                            transaction.RollBack();
                            items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-PLACE-NOT-CREATED", "Revit did not create the instance (no host found, or the point is not valid for this family)."));
                        }
                    }
                }
                int failedCount = items.Count(row => (string)row["status"] == "failed");
                string message = failedCount == 0
                    ? $"Successfully created {elementIds.Count} element(s)."
                    : $"Created {elementIds.Count} of {CreatedInfo.Count} element(s); {failedCount} failed (see Items).";
                if (_warnings.Count > 0)
                {
                    message += "\n\n⚠ Warnings:\n  • " + string.Join("\n  • ", _warnings);
                }
                Result = new AIItemsResult<List<long>>
                {
                    Success = failedCount == 0,
                    Message = message,
                    Response = elementIds,
                    Items = items,
                };
            }
            catch (Exception ex)
            {
                // Rows for the item that threw and for those not reached; the ones already made keep their created row.
                for (int i = Math.Max(index, 0); i < (CreatedInfo?.Count ?? 0); i++)
                    if (!items.Any(row => (int)row["index"] == i))
                        items.Add(FmcPlacementCore.Item(i, "failed", null, "FMC-TOOL-FAILED", i == index ? ex.Message : "Not attempted: an earlier item failed."));
                Result = new AIItemsResult<List<long>>
                {
                    Success = false,
                    Message = $"[FMC-TOOL-FAILED] Creating point-based elements failed: {ex.Message}",
                    Items = items,
                };
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", $"Creating point-based elements failed: {ex.Message}");
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
            return "创建点状构件";
        }

    }
}
