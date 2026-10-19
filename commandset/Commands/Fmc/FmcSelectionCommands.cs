using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the hub's selection and search commands (X1, X3). None of them changes the model.</summary>
    public abstract class FmcSelectionCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSelectionEventHandler _handler => (FmcSelectionEventHandler)Handler;
        protected abstract string Action { get; }

        protected FmcSelectionCommandBase(UIApplication uiApp) : base(new FmcSelectionEventHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Action = Action;
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>The current selection: UniqueIds, element ids, categories, the model, and elements picked in links (read-only).</summary>
    public class FmcSelectionGetCommand : FmcSelectionCommandBase
    {
        public FmcSelectionGetCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_selection_get";
        protected override string Action => "get";
    }

    /// <summary>Selects elements by UniqueId or element id and zooms to them; the view changes, the model never does.</summary>
    public class FmcSelectionShowCommand : FmcSelectionCommandBase
    {
        public FmcSelectionShowCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_selection_show";
        protected override string Action => "show";
    }

    /// <summary>Elements by mark, number or name, and what touches them (read-only).</summary>
    public class FmcFindElementsCommand : FmcSelectionCommandBase
    {
        public FmcFindElementsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_find_elements";
        protected override string Action => "find";
    }
}
