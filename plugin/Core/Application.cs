using System;
using Autodesk.Revit.UI;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Core
{
    public class Application : IExternalApplication
    {
        public Result OnStartup(UIControlledApplication application)
        {
            // Formcraft: one pane and one ribbon tab. The Connect page (Claude service, health, probe, families, files,
            // activity, guard) is set up first; the Formcraft pane hosts it, with the Core and module panels.
            FormcraftBrowser.Register(application);
#if REVIT2025_OR_GREATER
            // Formcraft Flow's touch (formerly the TouchKit add-in): gestures, per-view touch, on-view feedback (U22).
            try { Shell.ShellHost.Touch = TouchKit.App.Start(application); }
            catch (Exception) { /* touch is optional; Settings › Flow says it didn't start */ }
#endif
            Shell.ShellHost.Register(application);
            // Keep FMC data filled (docs/LIVE_DATA.md): registered for every model as optional; it only acts in project
            // models whose BIM Manager switched it on (LiveDataSwitch), checked inside the updater.
            try
            {
                LiveDataUpdater.Register(application, () =>
                    Shell.ShellHost.Settings?.Get(global::Formcraft.Shell.Services.SettingKeys.KitFolder)
                    ?? global::Formcraft.Shell.ViewModels.WelcomeViewModel.DefaultKitFolder);
            }
            catch (Exception) { /* the add-in works without it; Settings › Manage shows the switch either way */ }
            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
#if REVIT2025_OR_GREATER
            try { Shell.ShellHost.Touch?.Stop(application); } catch { }
#endif
            try
            {
                if (SocketService.Instance.IsRunning)
                {
                    SocketService.Instance.Stop();
                }
            }
            catch { }

            return Result.Succeeded;
        }
    }
}
