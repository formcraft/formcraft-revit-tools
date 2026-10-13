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
            Shell.ShellHost.Register(application);
            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
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
