using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>One external event per call for the site and analysis tools. Reads have no transaction; *_apply is one transaction.</summary>
    public abstract class FmcSiteCommandBase : ExternalEventCommandBase
    {
        private readonly object _lock = new object();
        protected FmcSiteCommandBase(FmcSiteHandlerBase handler, UIApplication uiApp) : base(handler, uiApp) { }
        private FmcSiteHandlerBase Site => (FmcSiteHandlerBase)Handler;
        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                Site.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException(CommandName + " timed out");
                if (!string.IsNullOrEmpty(Site.Error)) throw new Exception(CommandName + ": " + Site.Error);
                return Site.Result;
            }
        }
    }

    public class FmcSunCommand : FmcSiteCommandBase
    {
        public FmcSunCommand(UIApplication uiApp) : base(new FmcSunHandler(), uiApp) { }
        public override string CommandName => "fmc_sun";
    }

    public class FmcSunApplyCommand : FmcSiteCommandBase
    {
        public FmcSunApplyCommand(UIApplication uiApp) : base(new FmcSunApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_sun_apply";
    }

    public class FmcAvfCommand : FmcSiteCommandBase
    {
        public FmcAvfCommand(UIApplication uiApp) : base(new FmcAvfHandler(), uiApp) { }
        public override string CommandName => "fmc_avf";
    }

    public class FmcAvfApplyCommand : FmcSiteCommandBase
    {
        public FmcAvfApplyCommand(UIApplication uiApp) : base(new FmcAvfApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_avf_apply";
    }

    public class FmcSurveyCommand : FmcSiteCommandBase
    {
        public FmcSurveyCommand(UIApplication uiApp) : base(new FmcSurveyHandler(), uiApp) { }
        public override string CommandName => "fmc_survey";
    }

    public class FmcSurveyApplyCommand : FmcSiteCommandBase
    {
        public FmcSurveyApplyCommand(UIApplication uiApp) : base(new FmcSurveyApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_survey_apply";
    }
}
