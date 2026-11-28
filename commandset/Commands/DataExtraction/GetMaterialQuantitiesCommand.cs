using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.DataExtraction;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.DataExtraction
{
    public class GetMaterialQuantitiesCommand : ExternalEventCommandBase
    {
        private GetMaterialQuantitiesEventHandler _handler => (GetMaterialQuantitiesEventHandler)Handler;

        public override string CommandName => "get_material_quantities";

        public GetMaterialQuantitiesCommand(UIApplication uiApp)
            : base(new GetMaterialQuantitiesEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                // Parse parameters
                List<string> categoryFilters = parameters?["categoryFilters"]?.ToObject<List<string>>();
                bool selectedElementsOnly = parameters?["selectedElementsOnly"]?.Value<bool>() ?? false;

                // Set parameters. A named document that is not open is refused; the active document is not substituted.
                _handler.Parameters = parameters ?? new JObject();
                _handler.SetParameters(categoryFilters, selectedElementsOnly);

                // Execute and wait
                if (RaiseAndWaitForCompletion(120000)) // 120 second timeout for large projects
                {
                    if (!string.IsNullOrEmpty(_handler.Error))
                        throw new InvalidOperationException(_handler.Error);
                    return _handler.ResultInfo;
                }
                else
                {
                    throw new TimeoutException("Material quantities calculation timed out");
                }
            }
            catch (Exception ex)
            {
                throw new Exception($"Failed to get material quantities: {ex.Message}");
            }
        }
    }
}
