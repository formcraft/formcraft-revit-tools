using System.Linq;
using System.Reflection;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Runs an fmc_ui action on the Revit main thread (U11). The pane lives in the add-in (RevitMCPPlugin), which this
    /// assembly doesn't reference, so the handler finds revit_mcp_plugin.Shell.UiBridgeHost among the loaded assemblies
    /// and passes JSON both ways. It reads and steers the pane only; the model is never touched.
    /// </summary>
    public class FmcUiEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const string HostType = "revit_mcp_plugin.Shell.UiBridgeHost";
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JToken Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                var host = AppDomain.CurrentDomain.GetAssemblies()
                    .Select(a => a.GetType(HostType, false))
                    .FirstOrDefault(t => t != null);
                var run = host?.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
                if (run == null)
                {
                    Error = "The Formcraft pane isn't in this Revit (RevitMCPPlugin with the Formcraft pane, U10 or later).";
                    return;
                }
                var json = (string)run.Invoke(null, new object[] { Action, Parameters.ToString() });
                Result = JToken.Parse(json);
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                Error = ex.InnerException.Message;
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC pane bridge";
    }
}
