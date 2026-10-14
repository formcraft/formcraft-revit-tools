using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using TouchKit.UI;

namespace TouchKit.Commands
{
    /// <summary>Ribbon button: opens the Touch Probe diagnostics window.</summary>
    [Transaction(TransactionMode.ReadOnly)]
    public sealed class ShowProbeCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            App? app = App.Current;
            if (app is null)
            {
                message = "Formcraft Flow touch did not start. Check the Revit journal for load errors.";
                return Result.Failed;
            }

            // Refresh view positions right away so the first touches are attributed correctly.
            app.Views.Refresh(commandData.Application);

            ProbeWindow.ShowSingleton(app.RevitWindow, app.Hook, app.Log, app.Views, app.DescribeEnvironment);
            return Result.Succeeded;
        }
    }
}
