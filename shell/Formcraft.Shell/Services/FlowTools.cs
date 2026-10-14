using System.Collections.Generic;

namespace Formcraft.Shell.Services
{
    /// <summary>
    /// Formcraft Flow's view tools (U22): Section box, Sheet Layout (Align) and Tag Tidy run in Revit, each asking first
    /// and undone in one step; Shortcuts opens Revit's Keyboard Shortcuts. A person runs them; they aren't AI tools.
    /// </summary>
    public interface IFlowTools
    {
        void Run(string tool);
        void OpenShortcutsImport();
    }

    public sealed class MockFlowTools : IFlowTools
    {
        public List<string> Ran { get; } = new List<string>();
        public void Run(string tool) => Ran.Add(tool);
        public void OpenShortcutsImport() => Ran.Add("Shortcuts import");
    }
}
