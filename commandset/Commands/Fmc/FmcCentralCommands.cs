using Autodesk.Revit.UI;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>fmc_central step 1: build and save a central in the server's local temp folder (Services/Fmc/FmcCentral.cs).</summary>
    public class FmcCentralBuildCommand : FmcFileCommandBase
    {
        public FmcCentralBuildCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_central_build";
        protected override string Action => "central_build";
        protected override int TimeoutMs => 900000;
    }

    /// <summary>fmc_central step 2: read-only checks, throwaway local with all worksets, one sync, local discarded.</summary>
    public class FmcCentralSelfTestCommand : FmcFileCommandBase
    {
        public FmcCentralSelfTestCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_central_selftest";
        protected override string Action => "central_selftest";
        protected override int TimeoutMs => 900000;
    }

    /// <summary>fmc_central step 3: the tested temp central saved as a central at the share path. Never overwrites.</summary>
    public class FmcCentralPromoteCommand : FmcFileCommandBase
    {
        public FmcCentralPromoteCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_central_promote";
        protected override string Action => "central_promote";
        protected override int TimeoutMs => 900000;
    }
}
