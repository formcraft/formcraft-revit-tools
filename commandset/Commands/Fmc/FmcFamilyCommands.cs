using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft family builder commands.</summary>
    public abstract class FmcFamilyCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFamilyEventHandler _handler => (FmcFamilyEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcFamilyCommandBase(UIApplication uiApp) : base(new FmcFamilyEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                int waitMs = WaitMs(_handler.Parameters);
                if (!RaiseAndWaitForCompletion(waitMs))
                    throw new TimeoutException($"{CommandName} timed out after {waitMs / 1000} s (Revit's API thread didn't run or finish it; " +
                                               "another command may still hold it)");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }

        /// <summary>How long to wait for Revit's API thread. A batch of 25 families can take several minutes.</summary>
        protected virtual int WaitMs(JObject parameters) => 60000 + 60000 * ((parameters["families"] as JArray)?.Count ?? 1);
    }

    /// <summary>Builds data-shell families from resolved plans (paths already checked by the MCP server).</summary>
    public class FmcBuildFamiliesCommand : FmcFamilyCommandBase
    {
        public FmcBuildFamiliesCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_build_families";
        protected override string Action => "build";
    }

    /// <summary>Loads staged families into the active chain-test project, places and flexes them, checks connectors and parameters.</summary>
    public class FmcLoadTestFamiliesCommand : FmcFamilyCommandBase
    {
        public FmcLoadTestFamiliesCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_load_test_families";
        protected override string Action => "load_test";
    }

    /// <summary>F-061: Gate A's host test, in a new project that is never saved: place on a wall face or ceiling, move the host, check it follows.</summary>
    public class FmcFamilyHostTestCommand : FmcFamilyCommandBase
    {
        public FmcFamilyHostTestCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_family_host_test";
        protected override string Action => "host_test";

        /// <summary>F-064 long-job route: the server waits while this job's heartbeats come, up to its ceiling (max_wait_ms,
        /// 15 min by default), so Revit waits as long, plus 30 s so the server's own message says what happened.</summary>
        protected override int WaitMs(JObject parameters)
        {
            long ms = parameters.Value<long?>("max_wait_ms") ?? 15 * 60 * 1000;
            return (int)Math.Min(Math.Max(ms, 120000), 60 * 60 * 1000) + 30000;
        }
    }
}
