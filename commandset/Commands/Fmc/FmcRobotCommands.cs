using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Robot track's Revit commands.</summary>
    public abstract class FmcRobotCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcRobotEventHandler _handler => (FmcRobotEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcRobotCommandBase(UIApplication uiApp) : base(new FmcRobotEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>The analytical model for Robot: members, ends, types, sizes, materials and grades (read-only).</summary>
    public class FmcAnalyticalExportCommand : FmcRobotCommandBase
    {
        public FmcAnalyticalExportCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_analytical_export";
        protected override string Action => "export";
    }

    /// <summary>Robot's results into the kit's FMC_FEA_ fields; never the approval (behind the lock).</summary>
    public class FmcFeaWriteCommand : FmcRobotCommandBase
    {
        public FmcFeaWriteCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fea_write";
        protected override string Action => "write";
    }
}
