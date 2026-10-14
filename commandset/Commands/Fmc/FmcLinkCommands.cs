using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft link commands (U20 Links).</summary>
    public abstract class FmcLinkCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcLinkEventHandler _handler => (FmcLinkEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcLinkCommandBase(UIApplication uiApp) : base(new FmcLinkEventHandler(), uiApp) { }

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

    /// <summary>Coordinates, every Revit link and the worksets (read-only).</summary>
    public class FmcLinkFactsCommand : FmcLinkCommandBase
    {
        public FmcLinkFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_link_facts";
        protected override string Action => "facts";
    }

    /// <summary>Links models by shared coordinates, on Z_Links_&lt;Role&gt; when it exists (behind the lock).</summary>
    public class FmcLinkAddCommand : FmcLinkCommandBase
    {
        public FmcLinkAddCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_link_add";
        protected override string Action => "add";
    }

    /// <summary>Pins the given links (behind the lock).</summary>
    public class FmcLinkPinCommand : FmcLinkCommandBase
    {
        public FmcLinkPinCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_link_pin";
        protected override string Action => "pin";
    }
}
