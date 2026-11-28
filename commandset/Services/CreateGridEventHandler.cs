using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Architecture;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services
{
    public class CreateGridEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private UIApplication uiApp;
        private Document doc => FmcCallContext.Document(uiApp);

        /// <summary>
        /// Event synchronization object
        /// </summary>
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        /// <summary>
        /// Grid creation parameters
        /// </summary>
        public GridCreationInfo Parameters { get; private set; }

        /// <summary>
        /// Execution result
        /// </summary>
        public AIItemsResult<List<GridCreationResult>> Result { get; private set; }

        /// <summary>
        /// Set parameters for grid creation
        /// </summary>
        public void SetParameters(GridCreationInfo parameters)
        {
            Parameters = parameters;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication uiapp)
        {
            // F-032: an AI job (default failures handling, the save reminder kept from blocking). commandset/Bridge/FmcAiJob.cs
            RevitMCPCommandSet.Bridge.FmcAiJob.Enter(uiapp, "");
            uiApp = uiapp;

            try
            {
                // Validate parameters
                if (!Parameters.Validate(out string validationError))
                {
                    Result = new AIItemsResult<List<GridCreationResult>>
                    {
                        Success = false,
                        Message = $"Validation failed: {validationError}",
                        Response = null
                    };
                    return;
                }
                var items = new List<Dictionary<string, object>>();

                List<GridCreationResult> createdGrids = new List<GridCreationResult>();

                // Get existing grid names for duplicate checking
                var existingGridNames = new FilteredElementCollector(doc)
                    .OfClass(typeof(Grid))
                    .Cast<Grid>()
                    .Select(g => g.Name)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);

                // No silent renames (tool research create_grid gap 5): with onDuplicate error, an existing or repeated
                // name refuses the whole set before any grid is made, and every grid gets a row saying why.
                bool rename = string.Equals(Parameters.OnDuplicate, "rename", StringComparison.OrdinalIgnoreCase);
                var allLabels = FmcPlacementCore.GridLabels(Parameters.XCount, Parameters.XStartLabel, Parameters.XNamingStyle)
                    .Concat(FmcPlacementCore.GridLabels(Parameters.YCount, Parameters.YStartLabel, Parameters.YNamingStyle)).ToList();
                var clashes = FmcPlacementCore.Duplicates(allLabels, existingGridNames);
                if (!rename && clashes.Count > 0)
                {
                    var byIndex = clashes.ToDictionary(c => c.Key, c => c.Value);
                    for (int i = 0; i < allLabels.Count; i++)
                        items.Add(byIndex.TryGetValue(i, out string why)
                            ? FmcPlacementCore.Item(i, "failed", null, "FMC-GRID-DUPLICATE", why == "exists" ? "A grid with this name exists." : "The name is repeated in the request.", allLabels[i])
                            : FmcPlacementCore.Item(i, "failed", null, "FMC-DATUM-BLOCKED", "Not made: another grid in the set has a duplicate name.", allLabels[i]));
                    Result = new AIItemsResult<List<GridCreationResult>>
                    {
                        Success = false,
                        Message = $"[FMC-GRID-DUPLICATE] {clashes.Count} grid name(s) exist or repeat: {string.Join(", ", clashes.Select(c => allLabels[c.Key]))}. No grid was made.",
                        Response = new List<GridCreationResult>(),
                        Items = items,
                    };
                    return;
                }

                using (Transaction trans = new Transaction(doc, "Create Grid System"))
                {
                    trans.Start();

                    // Create X-axis grids (vertical lines, parallel to Y-axis)
                    List<double> xPositions = GeneratePositions(
                        Parameters.XCount,
                        Parameters.XSpacing,
                        Parameters.XStartPosition
                    );

                    List<string> xLabels = FmcPlacementCore.GridLabels(
                        Parameters.XCount,
                        Parameters.XStartLabel,
                        Parameters.XNamingStyle
                    );

                    for (int i = 0; i < xPositions.Count; i++)
                    {
                        double xPos = xPositions[i];
                        string label = xLabels[i];

                        // Handle duplicate names with auto-increment
                        string uniqueLabel = GetUniqueGridName(label, existingGridNames);
                        existingGridNames.Add(uniqueLabel);

                        // X-axis grids run parallel to Y-axis (vertical lines)
                        XYZ startPoint = new XYZ(
                            xPos / 304.8,  // mm to ft
                            Parameters.YExtentMin / 304.8,
                            Parameters.Elevation / 304.8
                        );

                        XYZ endPoint = new XYZ(
                            xPos / 304.8,
                            Parameters.YExtentMax / 304.8,
                            Parameters.Elevation / 304.8
                        );

                        Line gridLine = Line.CreateBound(startPoint, endPoint);
                        Grid grid = Grid.Create(doc, gridLine);
                        grid.Name = uniqueLabel;

#if REVIT2024_OR_GREATER
                        long gridId = grid.Id.Value;
#else
                        long gridId = grid.Id.IntegerValue;
#endif

                        createdGrids.Add(new GridCreationResult
                        {
                            ElementId = gridId,
                            Name = uniqueLabel,
                            OriginalName = label,
                            WasRenamed = label != uniqueLabel,
                            Axis = "X",
                            Position = xPos
                        });
                    }

                    // Create Y-axis grids (horizontal lines, parallel to X-axis)
                    List<double> yPositions = GeneratePositions(
                        Parameters.YCount,
                        Parameters.YSpacing,
                        Parameters.YStartPosition
                    );

                    List<string> yLabels = FmcPlacementCore.GridLabels(
                        Parameters.YCount,
                        Parameters.YStartLabel,
                        Parameters.YNamingStyle
                    );

                    for (int i = 0; i < yPositions.Count; i++)
                    {
                        double yPos = yPositions[i];
                        string label = yLabels[i];

                        // Handle duplicate names with auto-increment
                        string uniqueLabel = GetUniqueGridName(label, existingGridNames);
                        existingGridNames.Add(uniqueLabel);

                        // Y-axis grids run parallel to X-axis (horizontal lines)
                        XYZ startPoint = new XYZ(
                            Parameters.XExtentMin / 304.8,  // mm to ft
                            yPos / 304.8,
                            Parameters.Elevation / 304.8
                        );

                        XYZ endPoint = new XYZ(
                            Parameters.XExtentMax / 304.8,
                            yPos / 304.8,
                            Parameters.Elevation / 304.8
                        );

                        Line gridLine = Line.CreateBound(startPoint, endPoint);
                        Grid grid = Grid.Create(doc, gridLine);
                        grid.Name = uniqueLabel;

#if REVIT2024_OR_GREATER
                        long gridId = grid.Id.Value;
#else
                        long gridId = grid.Id.IntegerValue;
#endif

                        createdGrids.Add(new GridCreationResult
                        {
                            ElementId = gridId,
                            Name = uniqueLabel,
                            OriginalName = label,
                            WasRenamed = label != uniqueLabel,
                            Axis = "Y",
                            Position = yPos
                        });
                    }

                    trans.Commit();
                }
                for (int i = 0; i < createdGrids.Count; i++)
                {
                    GridCreationResult g = createdGrids[i];
                    items.Add(FmcPlacementCore.Item(i, "created", g.ElementId, g.WasRenamed ? "FMC-GRID-RENAMED" : null,
                        g.WasRenamed ? $"Renamed from {g.OriginalName} (on_duplicate rename)." : null, g.Name));
                }

                int renamedCount = createdGrids.Count(g => g.WasRenamed);
                string message = $"Successfully created {createdGrids.Count} grids " +
                                 $"({Parameters.XCount} X-axis + {Parameters.YCount} Y-axis)";

                if (renamedCount > 0)
                {
                    message += $". {renamedCount} grid(s) were renamed to avoid duplicates.";
                }

                Result = new AIItemsResult<List<GridCreationResult>>
                {
                    Success = true,
                    Message = message,
                    Response = createdGrids,
                    Items = items,
                };
            }
            catch (Exception ex)
            {
                // One transaction for the set: a failure rolls every grid back, so every grid is failed.
                Result = new AIItemsResult<List<GridCreationResult>>
                {
                    Success = false,
                    Message = $"Failed to create grids: {ex.Message}",
                    Response = null,
                    Items = Enumerable.Range(0, Math.Max(0, (Parameters?.XCount ?? 0) + (Parameters?.YCount ?? 0)))
                        .Select(i => FmcPlacementCore.Item(i, "failed", null, "FMC-TOOL-FAILED", ex.Message)).ToList(),
                };
                RevitMCPCommandSet.Bridge.FmcAiJob.Notice("Error", $"Failed to create grids: {ex.Message}");
            }
            finally
            {
                _resetEvent.Set(); // Signal completion
            }
        }

        /// <summary>
        /// Generate positions based on count, spacing, and start position
        /// </summary>
        private List<double> GeneratePositions(int count, double spacing, double startPosition)
        {
            List<double> positions = new List<double>();
            for (int i = 0; i < count; i++)
            {
                positions.Add(startPosition + (i * spacing));
            }
            return positions;
        }

        /// <summary>
        /// Get unique grid name by auto-incrementing if duplicate exists
        /// </summary>
        private string GetUniqueGridName(string baseName, HashSet<string> existingNames)
        {
            string candidateName = baseName;
            int counter = 1;

            while (existingNames.Contains(candidateName))
            {
                candidateName = $"{baseName}{counter}";
                counter++;
            }

            return candidateName;
        }

        /// <summary>
        /// Wait for grid creation to complete
        /// </summary>
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
        return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        /// <summary>
        /// Get handler name
        /// </summary>
        public string GetName()
        {
            return "Create Grid System";
        }
    }

    /// <summary>
    /// Result model for individual grid creation
    /// </summary>
    public class GridCreationResult
    {
        [Newtonsoft.Json.JsonProperty("elementId")]
        public long ElementId { get; set; }

        [Newtonsoft.Json.JsonProperty("name")]
        public string Name { get; set; }

        [Newtonsoft.Json.JsonProperty("originalName")]
        public string OriginalName { get; set; }

        [Newtonsoft.Json.JsonProperty("wasRenamed")]
        public bool WasRenamed { get; set; }

        [Newtonsoft.Json.JsonProperty("axis")]
        public string Axis { get; set; }

        [Newtonsoft.Json.JsonProperty("position")]
        public double Position { get; set; }
    }
}
