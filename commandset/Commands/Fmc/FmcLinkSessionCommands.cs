using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for closed-file transmission, unload and the published link copy.</summary>
    public abstract class FmcLinkSessionCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcLinkSessionHandler _handler => (FmcLinkSessionHandler)Handler;
        protected abstract string Action { get; }

        protected FmcLinkSessionCommandBase(UIApplication uiApp) : base(new FmcLinkSessionHandler(), uiApp) { }

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

    /// <summary>Reads or writes TransmissionData on a closed .rvt. The file is not opened.</summary>
    public class FmcLinkTransmissionCommand : FmcLinkSessionCommandBase
    {
        public FmcLinkTransmissionCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_link_transmission";
        protected override string Action => "transmission";
    }

    /// <summary>Detach-saves a byte copy into a non-workshared published link file. The source is not opened.</summary>
    public class FmcLinkPublishCommand : FmcLinkSessionCommandBase
    {
        public FmcLinkPublishCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_link_publish";
        protected override string Action => "publish";
    }

    /// <summary>Unloads one Revit link type. No transaction. Instances stay.</summary>
    public class FmcLinkUnloadCommand : FmcLinkSessionCommandBase
    {
        public FmcLinkUnloadCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_link_unload";
        protected override string Action => "unload";
    }
}
