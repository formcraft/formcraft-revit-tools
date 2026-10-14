using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft template commands (U14).</summary>
    public abstract class FmcTemplateCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcTemplateEventHandler _handler => (FmcTemplateEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcTemplateCommandBase(UIApplication uiApp) : base(new FmcTemplateEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                // Opening a large template in the background can take a few minutes.
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error))
                    throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Reads a template for the audit: shared parameters, styles, view templates, filters, size, unused families, warnings.</summary>
    public class FmcTemplateAuditCommand : FmcTemplateCommandBase
    {
        public FmcTemplateAuditCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_template_audit";
        protected override string Action => "audit";
    }

    /// <summary>Brand pack fonts on a staging template's text and dimension types (dry run unless dry_run is false).</summary>
    public class FmcTemplateBrandCommand : FmcTemplateCommandBase
    {
        public FmcTemplateBrandCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_template_brand";
        protected override string Action => "brand";
    }

    /// <summary>Templates as data (Phase 1): makes a new template in staging from a seed template.</summary>
    public class FmcTemplateCreateCommand : FmcTemplateCommandBase
    {
        public FmcTemplateCreateCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_template_create";
        protected override string Action => "create";
    }

    /// <summary>Templates as data (Phase 1): applies one layer of the base recipe to a template in staging.</summary>
    public class FmcTemplateBuildCommand : FmcTemplateCommandBase
    {
        public FmcTemplateBuildCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_template_build";
        protected override string Action => "build";
    }

    /// <summary>Templates as data (Phase 1): the names a template holds, to compare with the recipe (read-only).</summary>
    public class FmcTemplateNamesCommand : FmcTemplateCommandBase
    {
        public FmcTemplateNamesCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_template_names";
        protected override string Action => "names";
    }
}
