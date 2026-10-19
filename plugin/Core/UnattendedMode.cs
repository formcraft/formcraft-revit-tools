using System;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// F75: a Revit started by the unattended test runner (fmc_testrun). The runner sets these variables on the Revit it
    /// launches, so they belong to that one process: a person's own Revit never has them.
    /// <list type="bullet">
    /// <item>FMC_UNATTENDED_TEST=1: the AI connection starts with Revit whatever start_with_revit says, the registry entry
    /// says "unattended" (the runner talks only to such a Revit), and the command set answers its short list of safe
    /// dialogs by rule (commandset/Bridge/FmcAiJob.cs).</item>
    /// <item>FMC_NO_KEEP_AWAKE=1 (implied by the first): Revit never tells Windows the system is in use, so a test run
    /// never keeps the PC awake (F-064's keep-awake is for a person's long jobs only).</item>
    /// </list>
    /// </summary>
    public static class UnattendedMode
    {
        public const string Variable = "FMC_UNATTENDED_TEST";
        public const string NoKeepAwakeVariable = "FMC_NO_KEEP_AWAKE";

        public static bool On => Flag(Variable);

        public static bool NoKeepAwake => On || Flag(NoKeepAwakeVariable);

        private static bool Flag(string name)
        {
            try { return Environment.GetEnvironmentVariable(name) == "1"; }
            catch (Exception) { return false; }
        }
    }
}
