using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Interfaces;
using LevelCreationInfo = RevitMCPCommandSet.Models.Architecture.LevelInfo;

namespace RevitMCPCommandSet.Services.Architecture
{
    /// <summary>
    /// Event handler for creating levels in Revit
    /// </summary>
    public class CreateLevelEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private UIApplication _uiApp;
        private Document _doc => FmcCallContext.Document(_uiApp);

        /// <summary>
        /// Event wait object for synchronization
        /// </summary>
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        /// <summary>
        /// Level creation data (input)
        /// </summary>
        public List<LevelCreationInfo> LevelData { get; private set; }

        /// <summary>
        /// Execution result (output)
        /// </summary>
        public AIItemsResult<List<LevelResultInfo>> Result { get; private set; }

        /// <summary>error (default): an existing or repeated name refuses the whole call. reuse: the old rule, the existing level is returned.</summary>
        public string OnDuplicate { get; set; } = "error";

        /// <summary>
        /// Set the level creation parameters
        /// </summary>
        public void SetParameters(List<LevelCreationInfo> data)
        {
            LevelData = data;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication uiapp)
        {
            // F-032: an AI job (default failures handling, the save reminder kept from blocking). commandset/Bridge/FmcAiJob.cs
            RevitMCPCommandSet.Bridge.FmcAiJob.Enter(uiapp, "");
            _uiApp = uiapp;

            try
            {
                var createdLevels = new List<LevelResultInfo>();
                var warnings = new List<string>();

                // Get all existing level names to check for duplicates
                var existingLevels = new FilteredElementCollector(_doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .ToList();

                HashSet<string> existingLevelNames = new HashSet<string>(
                    existingLevels.Select(l => l.Name),
                    StringComparer.OrdinalIgnoreCase);

                var items = new List<Dictionary<string, object>>();
                bool reuse = string.Equals(OnDuplicate, "reuse", StringComparison.OrdinalIgnoreCase);
                var requested = LevelData.Select(l => l.Name ?? "").ToList();
                var clashes = FmcPlacementCore.Duplicates(requested, reuse ? Enumerable.Empty<string>() : existingLevelNames);
                if (clashes.Count > 0)
                {
                    var byIndex = clashes.ToDictionary(c => c.Key, c => c.Value);
                    for (int i = 0; i < requested.Count; i++)
                        items.Add(byIndex.TryGetValue(i, out string why)
                            ? FmcPlacementCore.Item(i, "failed", null, "FMC-LEVEL-DUPLICATE", why == "exists" ? "A level with this name exists." : "The name is repeated in the request.", requested[i])
                            : FmcPlacementCore.Item(i, "failed", null, "FMC-DATUM-BLOCKED", "Not made: another level in the call has a duplicate name.", requested[i]));
                    Result = new AIItemsResult<List<LevelResultInfo>>
                    {
                        Success = false,
                        Message = $"[FMC-LEVEL-DUPLICATE] {string.Join(", ", clashes.Select(c => requested[c.Key]))}: the name exists or repeats. No level was made.",
                        Response = new List<LevelResultInfo>(),
                        Items = items,
                    };
                    return;
                }
                int index = -1;

                foreach (var levelInfo in LevelData)
                {
                    index++;
                    using (Transaction tx = new Transaction(_doc, "Create Level"))
                    {
                        tx.Start();

                        try
                        {
                            // Check if level with same name already exists
                            if (existingLevelNames.Contains(levelInfo.Name))
                            {
                                // Find existing level and return its info
                                var existingLevel = existingLevels.FirstOrDefault(
                                    l => l.Name.Equals(levelInfo.Name, StringComparison.OrdinalIgnoreCase));

                                if (existingLevel != null)
                                {
                                    warnings.Add($"Level '{levelInfo.Name}' already exists at elevation {existingLevel.Elevation * 304.8:F0}mm");

                                    createdLevels.Add(new LevelResultInfo
                                    {
                                        Id = existingLevel.Id.GetValue(),
                                        UniqueId = existingLevel.UniqueId,
                                        Name = existingLevel.Name,
                                        Elevation = existingLevel.Elevation * 304.8, // Convert to mm
                                        AlreadyExisted = true
                                    });
                                    items.Add(FmcPlacementCore.Item(index, "reused", existingLevel.Id.GetValue(), "FMC-LEVEL-REUSED", "The level exists and was kept (on_duplicate reuse).", existingLevel.Name));

                                    tx.RollBack();
                                    continue;
                                }
                            }

                            // Convert elevation from mm to feet
                            double elevationInFeet = levelInfo.Elevation / 304.8;

                            // Create the level
                            Level newLevel = Level.Create(_doc, elevationInFeet);

                            if (newLevel != null)
                            {
                                // Set the level name
                                if (!string.IsNullOrEmpty(levelInfo.Name))
                                {
                                    newLevel.Name = levelInfo.Name;
                                }

                                // Set building story parameter if specified
                                Parameter buildingStoryParam = newLevel.get_Parameter(BuiltInParameter.LEVEL_IS_BUILDING_STORY);
                                if (buildingStoryParam != null && !buildingStoryParam.IsReadOnly)
                                {
                                    buildingStoryParam.Set(levelInfo.IsBuildingStory ? 1 : 0);
                                }

                                // Create floor plan view if requested
                                string floorPlanViewName = null;
                                if (levelInfo.CreateFloorPlan)
                                {
                                    var floorPlanType = new FilteredElementCollector(_doc)
                                        .OfClass(typeof(ViewFamilyType))
                                        .Cast<ViewFamilyType>()
                                        .FirstOrDefault(vft => vft.ViewFamily == ViewFamily.FloorPlan);

                                    if (floorPlanType != null)
                                    {
                                        var floorPlanView = ViewPlan.Create(_doc, floorPlanType.Id, newLevel.Id);
                                        if (floorPlanView != null)
                                        {
                                            floorPlanViewName = floorPlanView.Name;
                                        }
                                    }
                                    else
                                    {
                                        warnings.Add($"Could not find Floor Plan view family type for level '{levelInfo.Name}'");
                                    }
                                }

                                // Create ceiling plan view if requested
                                string ceilingPlanViewName = null;
                                if (levelInfo.CreateCeilingPlan)
                                {
                                    var ceilingPlanType = new FilteredElementCollector(_doc)
                                        .OfClass(typeof(ViewFamilyType))
                                        .Cast<ViewFamilyType>()
                                        .FirstOrDefault(vft => vft.ViewFamily == ViewFamily.CeilingPlan);

                                    if (ceilingPlanType != null)
                                    {
                                        var ceilingPlanView = ViewPlan.Create(_doc, ceilingPlanType.Id, newLevel.Id);
                                        if (ceilingPlanView != null)
                                        {
                                            ceilingPlanViewName = ceilingPlanView.Name;
                                        }
                                    }
                                    else
                                    {
                                        warnings.Add($"Could not find Ceiling Plan view family type for level '{levelInfo.Name}'");
                                    }
                                }

                                tx.Commit();

                                // Add to existing names set
                                existingLevelNames.Add(newLevel.Name);
                                // The server sends internal elevations. If the API measured from elsewhere, say so.
                                double madeMm = newLevel.ProjectElevation * 304.8;
                                string drift = Math.Abs(madeMm - levelInfo.Elevation) > 1.0 ? $"Made at {madeMm:F1} mm internal, asked {levelInfo.Elevation:F1} mm." : null;
                                items.Add(FmcPlacementCore.Item(index, "created", newLevel.Id.GetValue(), drift != null ? "FMC-LEVEL-ELEVATION-DRIFT" : null, drift, newLevel.Name));

                                createdLevels.Add(new LevelResultInfo
                                {
                                    Id = newLevel.Id.GetValue(),
                                    UniqueId = newLevel.UniqueId,
                                    Name = newLevel.Name,
                                    Elevation = levelInfo.Elevation,
                                    FloorPlanViewName = floorPlanViewName,
                                    CeilingPlanViewName = ceilingPlanViewName,
                                    AlreadyExisted = false
                                });
                            }
                            else
                            {
                                tx.RollBack();
                                warnings.Add($"Failed to create level '{levelInfo.Name}'");
                                items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-LEVEL-NOT-CREATED", "Revit did not create the level.", levelInfo.Name));
                            }
                        }
                        catch (Exception ex)
                        {
                            if (tx.HasStarted() && !tx.HasEnded()) tx.RollBack();
                            warnings.Add($"Error creating level '{levelInfo.Name}': {ex.Message}");
                            items.Add(FmcPlacementCore.Item(index, "failed", null, "FMC-TOOL-FAILED", ex.Message, levelInfo.Name));
                        }
                    }
                }

                string message;
                int newCount = createdLevels.Count(l => !l.AlreadyExisted);
                int existingCount = createdLevels.Count(l => l.AlreadyExisted);

                if (newCount > 0 && existingCount > 0)
                {
                    message = $"Created {newCount} new level(s), {existingCount} already existed";
                }
                else if (existingCount > 0)
                {
                    message = $"All {existingCount} level(s) already existed";
                }
                else
                {
                    message = $"Successfully created {newCount} level(s)";
                }

                if (warnings.Count > 0)
                {
                    message += "\n\n⚠ Warnings:\n  • " + string.Join("\n  • ", warnings);
                }

                Result = new AIItemsResult<List<LevelResultInfo>>
                {
                    Success = true,
                    Message = message,
                    Response = createdLevels,
                    Items = items,
                };
            }
            catch (Exception ex)
            {
                // Items stay empty: the server reports every level it sent as unknown, not as created.
                Result = new AIItemsResult<List<LevelResultInfo>>
                {
                    Success = false,
                    Message = $"Error creating levels: {ex.Message}",
                };
            }
            finally
            {
                _resetEvent.Set(); // Signal that the operation is complete
            }
        }

        /// <summary>
        /// Wait for the operation to complete
        /// </summary>
        /// <param name="timeoutMilliseconds">Timeout in milliseconds</param>
        /// <returns>True if completed before timeout</returns>
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
        return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        /// <summary>
        /// IExternalEventHandler.GetName implementation
        /// </summary>
        public string GetName()
        {
            return "Create Level";
        }
    }

    /// <summary>
    /// Result information for a created level
    /// </summary>
    public class LevelResultInfo
    {
        public long Id { get; set; }
        public string UniqueId { get; set; }
        public string Name { get; set; }
        public double Elevation { get; set; }
        public string FloorPlanViewName { get; set; }
        public string CeilingPlanViewName { get; set; }
        public bool AlreadyExisted { get; set; }
    }
}
