using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>
    /// Shared plumbing for the family editor commands (fmc_fam_nested, fmc_fam_hosting, fmc_fam_connector): one handler,
    /// one tool and action each. Family documents only; the server checks every change before it is sent.
    /// </summary>
    public abstract class FmcFamEditCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFamEditHandler _handler => (FmcFamEditHandler)Handler;
        protected abstract string Tool { get; }
        protected abstract string Action { get; }

        protected FmcFamEditCommandBase(UIApplication uiApp) : base(new FmcFamEditHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Tool = Tool;
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Nested instances, loaded families and their types, host parameters and associations (read only).</summary>
    public class FmcFamNestedReadCommand : FmcFamEditCommandBase
    {
        public FmcFamNestedReadCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fam_nested_read";
        protected override string Tool => "nested";
        protected override string Action => "read";
    }

    /// <summary>Swap, associate or reload nested families in one transaction (the dry run rolls back).</summary>
    public class FmcFamNestedApplyCommand : FmcFamEditCommandBase
    {
        public FmcFamNestedApplyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fam_nested_apply";
        protected override string Tool => "nested";
        protected override string Action => "apply";
    }

    /// <summary>Host, placement, work plane-based, adaptive and reference points (read only).</summary>
    public class FmcFamHostingReadCommand : FmcFamEditCommandBase
    {
        public FmcFamHostingReadCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fam_hosting_read";
        protected override string Tool => "hosting";
        protected override string Action => "read";
    }

    /// <summary>Work plane-based set, or reference points made adaptive, in one transaction (the dry run rolls back).</summary>
    public class FmcFamHostingApplyCommand : FmcFamEditCommandBase
    {
        public FmcFamHostingApplyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fam_hosting_apply";
        protected override string Tool => "hosting";
        protected override string Action => "apply";
    }

    /// <summary>Connectors with domain, system, flow, shape, sizes and associations, and the family parameters (read only).</summary>
    public class FmcFamConnectorReadCommand : FmcFamEditCommandBase
    {
        public FmcFamConnectorReadCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fam_connector_read";
        protected override string Tool => "connector";
        protected override string Action => "read";
    }

    /// <summary>A connector set or added in one transaction (the dry run rolls back).</summary>
    public class FmcFamConnectorApplyCommand : FmcFamEditCommandBase
    {
        public FmcFamConnectorApplyCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_fam_connector_apply";
        protected override string Tool => "connector";
        protected override string Action => "apply";
    }
}
