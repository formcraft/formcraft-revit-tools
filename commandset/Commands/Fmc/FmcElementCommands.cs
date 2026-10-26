using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Marked elements' facts for a ticket's fix plan (R3/R6); read-only.</summary>
    public class FmcElementFactsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcElementFactsHandler _handler => (FmcElementFactsHandler)Handler;

        public FmcElementFactsCommand(UIApplication uiApp) : base(new FmcElementFactsHandler(), uiApp) { }
        public override string CommandName => "fmc_element_facts";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A ticket's planned fix applied in one transaction, after a person's yes (R6); behind the lock.</summary>
    public class FmcElementApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcElementApplyHandler _handler => (FmcElementApplyHandler)Handler;

        public FmcElementApplyCommand(UIApplication uiApp) : base(new FmcElementApplyHandler(), uiApp) { }
        public override string CommandName => "fmc_element_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Revit's design option sets and options, and the active one (O3); read-only.</summary>
    public class FmcDesignOptionsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcDesignOptionsHandler _handler => (FmcDesignOptionsHandler)Handler;

        public FmcDesignOptionsCommand(UIApplication uiApp) : base(new FmcDesignOptionsHandler(), uiApp) { }
        public override string CommandName => "fmc_design_options";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A schedule set made or updated in the active template or WIP model (F60); behind the lock.</summary>
    public class FmcSchedulesApplyCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcSchedulesHandler _handler => (FmcSchedulesHandler)Handler;

        public FmcSchedulesApplyCommand(UIApplication uiApp) : base(new FmcSchedulesHandler(), uiApp) { }
        public override string CommandName => "fmc_schedules_apply";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A list of model edits as one approved batch and one Undo (owner 26 Oct); behind the lock.</summary>
    public class FmcModelEditCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcModelEditHandler _handler => (FmcModelEditHandler)Handler;

        public FmcModelEditCommand(UIApplication uiApp) : base(new FmcModelEditHandler(), uiApp) { }
        public override string CommandName => "fmc_model_edit";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Elements' exact geometry in mm (owner 26 Oct); read-only.</summary>
    public class FmcElementGeometryCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcElementGeometryHandler _handler => (FmcElementGeometryHandler)Handler;

        public FmcElementGeometryCommand(UIApplication uiApp) : base(new FmcElementGeometryHandler(), uiApp) { }
        public override string CommandName => "fmc_element_geometry";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Starts one of Revit's built-in commands by name (owner 26 Oct); behind the lock (it may act on the selection).</summary>
    public class FmcPostCommandCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPostCommandHandler _handler => (FmcPostCommandHandler)Handler;

        public FmcPostCommandCommand(UIApplication uiApp) : base(new FmcPostCommandHandler(), uiApp) { }
        public override string CommandName => "fmc_post_command";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Revit's built-in commands and whether each can start now (owner 26 Oct); read-only.</summary>
    public class FmcListCommandsCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcPostCommandHandler _handler => (FmcPostCommandHandler)Handler;

        public FmcListCommandsCommand(UIApplication uiApp) : base(new FmcPostCommandHandler(), uiApp) { }
        public override string CommandName => "fmc_list_commands";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = new JObject { ["list"] = true };
                if (!RaiseAndWaitForCompletion(60000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A new family from a template, saved and opened in the Family Editor (owner 26 Oct).</summary>
    public class FmcFamilyNewCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcFamilyNewHandler _handler => (FmcFamilyNewHandler)Handler;

        public FmcFamilyNewCommand(UIApplication uiApp) : base(new FmcFamilyNewHandler(), uiApp) { }
        public override string CommandName => "fmc_family_new";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>What Revit does with files: save, open, export, link, import, sync (owner 26 Oct); behind the lock.</summary>
    public class FmcRevitFileCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcRevitFileHandler _handler => (FmcRevitFileHandler)Handler;

        public FmcRevitFileCommand(UIApplication uiApp) : base(new FmcRevitFileHandler(), uiApp) { }
        public override string CommandName => "fmc_revit_file";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(1800000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>A picture of a view or of elements, highlighted, for the AI to see (owner 26 Oct); read-only, rolled back.</summary>
    public class FmcViewImageCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcViewImageHandler _handler => (FmcViewImageHandler)Handler;

        public FmcViewImageCommand(UIApplication uiApp) : base(new FmcViewImageHandler(), uiApp) { }
        public override string CommandName => "fmc_view_image";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }

    /// <summary>Read-only model checks with ids, places and a sentence each (owner 26 Oct).</summary>
    public class FmcModelCheckCommand : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcModelCheckHandler _handler => (FmcModelCheckHandler)Handler;

        public FmcModelCheckCommand(UIApplication uiApp) : base(new FmcModelCheckHandler(), uiApp) { }
        public override string CommandName => "fmc_model_check";

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(300000)) throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(_handler.Error)) throw new Exception($"{CommandName}: {_handler.Error}");
                return _handler.Result;
            }
        }
    }
}
