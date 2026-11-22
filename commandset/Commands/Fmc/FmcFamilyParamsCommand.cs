using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Parameters on a family loaded in the project. The family file is closed without saving.</summary>
    public class FmcFamilyParamsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFamilyParamsHandler HandlerCast => (FmcFamilyParamsHandler)Handler;

        public FmcFamilyParamsCommand(UIApplication uiApp) : base(new FmcFamilyParamsHandler(), uiApp) { }
        public override string CommandName => "fmc_family_params";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(180000))
                    throw new TimeoutException("fmc_family_params timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_family_params: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>Adds a parameter or label on the loaded family, or binds a project parameter. The kit file is not saved.</summary>
    public class FmcFamilyParamsApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFamilyParamsApplyHandler HandlerCast => (FmcFamilyParamsApplyHandler)Handler;

        public FmcFamilyParamsApplyCommand(UIApplication uiApp) : base(new FmcFamilyParamsApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_family_params_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000))
                    throw new TimeoutException("fmc_family_params_apply timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception("fmc_family_params_apply: " + HandlerCast.Error);
                return HandlerCast.Result;
            }
        }
    }
}
