using System.Linq;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using TouchKit.Input;
using TouchKit.UI;

namespace TouchKit.Commands
{
    /// <summary>Ribbon: master switch for touch everywhere.</summary>
    [Transaction(TransactionMode.ReadOnly)]
    public sealed class ToggleTouchMasterCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            App? app = App.Current;
            if (app is null || !app.TouchAvailable) { message = "Formcraft Flow touch did not start. Open the touch probe (Settings › Flow › Touch) and save a report for details."; return Result.Failed; }
            app.SetMaster(!app.Takeover.MasterOn);
            return Result.Succeeded;
        }
    }

    /// <summary>Ribbon (or keyboard shortcut): switch touch on/off for the active view.</summary>
    [Transaction(TransactionMode.ReadOnly)]
    public sealed class ToggleActiveViewTouchCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            App? app = App.Current;
            if (app is null || !app.TouchAvailable) { message = "Formcraft Flow touch did not start. Open the touch probe (Settings › Flow › Touch) and save a report for details."; return Result.Failed; }

            UIDocument? uiDoc = commandData.Application.ActiveUIDocument;
            if (uiDoc is null) { message = "Open a view first."; return Result.Cancelled; }

            app.Views.Refresh(commandData.Application);
            app.Takeover.UpdateProject(uiDoc.Document);

            long activeId = uiDoc.ActiveView.Id.Value;
            ViewRegion? region = app.Views.Regions.FirstOrDefault(r => r.ViewId == activeId);
            if (region is null) { message = "Couldn't find the active view on screen."; return Result.Cancelled; }

            app.ToggleView(region);
            return Result.Succeeded;
        }
    }

    /// <summary>Ribbon: open the settings window.</summary>
    [Transaction(TransactionMode.ReadOnly)]
    public sealed class ShowSettingsCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            App? app = App.Current;
            if (app is null) { message = "Formcraft Flow touch did not start correctly."; return Result.Failed; }
            SettingsWindow.ShowSingleton(app.RevitWindow, () => app.Settings, app.ReplaceSettings, app.OnSettingsChanged);
            return Result.Succeeded;
        }
    }
}
