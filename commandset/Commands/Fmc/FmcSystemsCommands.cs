using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the Formcraft systems checks (U25, read-only).</summary>
    public abstract class FmcSystemsCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSystemsEventHandler _handler => (FmcSystemsEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcSystemsCommandBase(UIApplication uiApp) : base(new FmcSystemsEventHandler(), uiApp) { }

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

    /// <summary>Boards, their loads, circuits and feeders; devices on no circuit (read-only).</summary>
    public class FmcElectricalFactsCommand : FmcSystemsCommandBase
    {
        public FmcElectricalFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_electrical_facts";
        protected override string Action => "electrical";
    }

    /// <summary>Analytical model, supports, kit fields, load cases and analysis results (read-only).</summary>
    public class FmcStructuralFactsCommand : FmcSystemsCommandBase
    {
        public FmcStructuralFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_structural_facts";
        protected override string Action => "structural";
    }

    /// <summary>E1: rooms, plumbing fixtures, pipe systems, tanks, fire devices, LP parts and circuits for the MEP calcs (read-only, no transaction).</summary>
    public class FmcMepFactsCommand : FmcSystemsCommandBase
    {
        public FmcMepFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_mep_facts";
        protected override string Action => "mep";
    }

    /// <summary>KISIC 4.4: chosen devices grouped into circuits on a named board, the kit's distribution system set on the
    /// board if it has none; one Undo, never sizes (rule 5). The dry run is the real run rolled back; behind the lock.</summary>
    public class FmcCircuitsCreateCommand : FmcSystemsCommandBase
    {
        public FmcCircuitsCreateCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_circuits_create";
        protected override string Action => "create_circuits";
    }
}
