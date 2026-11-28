using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Models.DataExtraction;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.DataExtraction
{
    public class GetMaterialQuantitiesEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private List<string> _categoryFilters;
        private bool _selectedElementsOnly;

        public GetMaterialQuantitiesResult ResultInfo { get; private set; }
        public JObject Parameters { get; set; } = new JObject();
        public string Error { get; private set; }
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public void SetParameters(List<string> categoryFilters = null, bool selectedElementsOnly = false)
        {
            _categoryFilters = categoryFilters;
            _selectedElementsOnly = selectedElementsOnly;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
        return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Error = null;
            ResultInfo = null;
            try
            {
                // MQ-3: refuse unknown category names before reading anything. A requested filter is never
                // dropped, so a typo such as "Walls" can no longer quantify the whole project.
                List<string> categoriesApplied = null;
                List<BuiltInCategory> builtInCategories = null;
                if (_categoryFilters != null && _categoryFilters.Count > 0)
                {
                    var split = FmcReadShape.RequireKnownNames<BuiltInCategory>("get_material_quantities", _categoryFilters);
                    categoriesApplied = split.Applied;
                    builtInCategories = split.Parsed;
                }

                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                var doc = target.Doc;

                // Dictionary to accumulate material quantities
                var materialData = new Dictionary<ElementId, MaterialQuantityModel>();

                // Get elements to analyze
                ICollection<Element> elements;
                if (_selectedElementsOnly)
                {
                    var uiDoc = target.RequireUi("Material quantities of the selection");
                    var selectedIds = uiDoc.Selection.GetElementIds();
                    elements = selectedIds.Select(id => doc.GetElement(id)).Where(e => e != null).ToList();
                    // Category filters also narrow a selection takeoff (they were ignored here before).
                    if (builtInCategories != null)
                    {
                        var wanted = new HashSet<BuiltInCategory>(builtInCategories);
#if REVIT2024_OR_GREATER
                        elements = elements.Where(e => e.Category != null && wanted.Contains((BuiltInCategory)e.Category.Id.Value)).ToList();
#else
                        elements = elements.Where(e => e.Category != null && wanted.Contains((BuiltInCategory)e.Category.Id.IntegerValue)).ToList();
#endif
                    }
                }
                else
                {
                    var collector = new FilteredElementCollector(doc)
                        .WhereElementIsNotElementType();

                    // Apply the (already validated) category filter
                    if (builtInCategories != null)
                    {
                        collector = collector.WherePasses(new ElementMulticategoryFilter(builtInCategories));
                    }

                    elements = collector.ToElements();
                }

                // Process each element
                foreach (Element element in elements)
                {
                    // Get all material ids in the element
                    var materialIds = element.GetMaterialIds(false);

                    foreach (ElementId matId in materialIds)
                    {
                        Material material = doc.GetElement(matId) as Material;
                        if (material == null) continue;

                        // Initialize material data if not exists
                        if (!materialData.ContainsKey(matId))
                        {
                            materialData[matId] = new MaterialQuantityModel
                            {
#if REVIT2024_OR_GREATER
                                MaterialId = matId.Value,
#else
                                MaterialId = matId.IntegerValue,
#endif
                                MaterialName = material.Name,
                                MaterialClass = material.MaterialClass
                            };
                        }

                        // Get material area and volume for this element
                        double area = element.GetMaterialArea(matId, false);
                        double volume = element.GetMaterialVolume(matId);

                        materialData[matId].Area += area;
                        materialData[matId].Volume += volume;

#if REVIT2024_OR_GREATER
                        if (!materialData[matId].ElementIds.Contains(element.Id.Value))
                        {
                            materialData[matId].ElementIds.Add(element.Id.Value);
#else
                        if (!materialData[matId].ElementIds.Contains(element.Id.IntegerValue))
                        {
                            materialData[matId].ElementIds.Add(element.Id.IntegerValue);
#endif
                            materialData[matId].ElementCount++;
                        }
                    }
                }

                var materials = materialData.Values.ToList();
                double totalArea = materials.Sum(m => m.Area);
                double totalVolume = materials.Sum(m => m.Volume);

                ResultInfo = new GetMaterialQuantitiesResult
                {
                    TotalMaterials = materials.Count,
                    TotalArea = totalArea,
                    TotalVolume = totalVolume,
                    Materials = materials,
                    Success = true,
                    CategoriesApplied = categoriesApplied,
                    Message = $"Successfully calculated quantities for {materials.Count} materials"
                };
            }
            catch (Exception ex)
            {
                Error = ex.Message;
                ResultInfo = new GetMaterialQuantitiesResult
                {
                    Success = false,
                    Message = $"Error calculating material quantities: {ex.Message}"
                };
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        public string GetName()
        {
            return "Get Material Quantities";
        }
    }
}
