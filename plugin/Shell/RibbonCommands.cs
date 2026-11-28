using System;
using System.Collections.Generic;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Formcraft.Shell.Services;
using revit_mcp_plugin.Core;
using revit_mcp_plugin.Fmc;

// Generated from shell/Formcraft.Shell/Services/sections.json (parts) and the four modules' two small buttons.
// Revit gives an external command no hint of which button ran it, so each ribbon button has its own small class.

namespace revit_mcp_plugin.Shell
{
    /// <summary>Shows or hides the Formcraft pane.</summary>
    [Transaction(TransactionMode.Manual)]
    public class TogglePaneCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            ShellHost.TogglePane(commandData.Application);
            return Result.Succeeded;
        }
    }

    /// <summary>Switches the AI connection on or off in one click (Core › Connect AI), like the original MCP switch.</summary>
    [Transaction(TransactionMode.Manual)]
    public class ConnectAiCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            // The AI connection doesn't need a licence or the pane: one click, like the original MCP switch.
            FormcraftBrowser.ToggleService(commandData.Application);
            RibbonBuilder.ShowConnection(SocketService.Instance.IsRunning);
            return Result.Succeeded;
        }
    }

    /// <summary>The General AI switch (Core › AI switch): the same as the switch at the top of the pane.</summary>
    [Transaction(TransactionMode.Manual)]
    public class AiSwitchCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            // The pane's command runs the server call off Revit's thread; the button's label follows at idle.
            ShellHost.Pane?.ToggleAiCommand.Execute(null);
            return Result.Succeeded;
        }
    }

    /// <summary>Opens the Log file window (Core › Log file).</summary>
    [Transaction(TransactionMode.Manual)]
    public class LogFileCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            ShellHost.OpenLog();
            return Result.Succeeded;
        }
    }

    public abstract class PartCommand : IExternalCommand
    {
        private readonly string _part;
        protected PartCommand(string part) { _part = part; }

        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            RibbonBuilder.TogglePart(_part);
            return Result.Succeeded;
        }
    }

    public abstract class SmallCommand : IExternalCommand
    {
        private readonly FmcModule _module;
        private readonly int _slot;
        protected SmallCommand(FmcModule module, int slot) { _module = module; _slot = slot; }

        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            RibbonBuilder.RunSmall(commandData.Application, _module, _slot);
            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.Manual)] public class TogglePart_ManageSetup : PartCommand { public TogglePart_ManageSetup() : base("manage.setup") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ManageDrawings : PartCommand { public TogglePart_ManageDrawings() : base("manage.drawings") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ManageTeam : PartCommand { public TogglePart_ManageTeam() : base("manage.team") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ManageCheck : PartCommand { public TogglePart_ManageCheck() : base("manage.check") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_FlowTouch : PartCommand { public TogglePart_FlowTouch() : base("flow.touch") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_FlowSheetlayout : PartCommand { public TogglePart_FlowSheetlayout() : base("flow.sheetlayout") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_FlowTags : PartCommand { public TogglePart_FlowTags() : base("flow.tags") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_Flow3d : PartCommand { public TogglePart_Flow3d() : base("flow.3d") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ModelSystems : PartCommand { public TogglePart_ModelSystems() : base("model.systems") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ModelStructural : PartCommand { public TogglePart_ModelStructural() : base("model.structural") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ModelQuantities : PartCommand { public TogglePart_ModelQuantities() : base("model.quantities") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ModelCasework : PartCommand { public TogglePart_ModelCasework() : base("model.casework") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_ModelCeilings : PartCommand { public TogglePart_ModelCeilings() : base("model.ceilings") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_BuildViews : PartCommand { public TogglePart_BuildViews() : base("build.views") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_BuildBoq : PartCommand { public TogglePart_BuildBoq() : base("build.boq") { } }
    [Transaction(TransactionMode.Manual)] public class TogglePart_BuildPackage : PartCommand { public TogglePart_BuildPackage() : base("build.package") { } }

    [Transaction(TransactionMode.Manual)] public class Small_Manage_1 : SmallCommand { public Small_Manage_1() : base(FmcModule.Manage, 1) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Manage_2 : SmallCommand { public Small_Manage_2() : base(FmcModule.Manage, 2) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Flow_1 : SmallCommand { public Small_Flow_1() : base(FmcModule.Flow, 1) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Flow_2 : SmallCommand { public Small_Flow_2() : base(FmcModule.Flow, 2) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Model_1 : SmallCommand { public Small_Model_1() : base(FmcModule.Model, 1) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Model_2 : SmallCommand { public Small_Model_2() : base(FmcModule.Model, 2) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Build_1 : SmallCommand { public Small_Build_1() : base(FmcModule.Build, 1) { } }
    [Transaction(TransactionMode.Manual)] public class Small_Build_2 : SmallCommand { public Small_Build_2() : base(FmcModule.Build, 2) { } }

    public static class PartCommands
    {
        private static readonly Dictionary<string, Type> Map = new Dictionary<string, Type>
        {
            ["manage.setup"] = typeof(TogglePart_ManageSetup),
            ["manage.drawings"] = typeof(TogglePart_ManageDrawings),
            ["manage.team"] = typeof(TogglePart_ManageTeam),
            ["manage.check"] = typeof(TogglePart_ManageCheck),
            ["flow.touch"] = typeof(TogglePart_FlowTouch),
            ["flow.sheetlayout"] = typeof(TogglePart_FlowSheetlayout),
            ["flow.tags"] = typeof(TogglePart_FlowTags),
            ["flow.3d"] = typeof(TogglePart_Flow3d),
            ["model.systems"] = typeof(TogglePart_ModelSystems),
            ["model.structural"] = typeof(TogglePart_ModelStructural),
            ["model.quantities"] = typeof(TogglePart_ModelQuantities),
            ["model.casework"] = typeof(TogglePart_ModelCasework),
            ["model.ceilings"] = typeof(TogglePart_ModelCeilings),
            ["build.views"] = typeof(TogglePart_BuildViews),
            ["build.boq"] = typeof(TogglePart_BuildBoq),
            ["build.package"] = typeof(TogglePart_BuildPackage),
        };

        public static Type For(string part) => Map[part];
    }

    public static class SmallCommands
    {
        public static Type For(FmcModule module, int slot) =>
            Type.GetType("revit_mcp_plugin.Shell.Small_" + module + "_" + slot, throwOnError: true);
    }
}
