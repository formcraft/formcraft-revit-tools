using System;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// F75 (docs/handoff/KISIC_GAP_SCRIPTS.md §4.3): the dialogs answered by rule, only in a Revit the unattended test runner
    /// started (FMC_UNATTENDED_TEST=1 on that process; a person's Revit never has it) and only while an AI job runs.
    /// <para>The list is short on purpose. Duplicate Types (copy/paste of types that already exist) is answered OK, which
    /// keeps the destination's types. Warnings never reach a dialog during a job: <see cref="FmcFailures"/> deletes and lists
    /// them. Anything about saving, synchronising, recovery, a crash or an error is never answered: the runner records it as
    /// a finding naming the dialog and cancels the step.</para>
    /// </summary>
    public static class DialogRules
    {
        /// <summary>True in a Revit started by the unattended test runner.</summary>
        public static readonly bool Unattended = Flag("FMC_UNATTENDED_TEST");

        /// <summary>IDOK, the result Revit takes for OK (TaskDialogResult.Ok has the same value).</summary>
        public const int Ok = 1;

        /// <summary>
        /// The answer for a dialog, or null when no rule answers it (a person must). <paramref name="rule"/> says which rule
        /// answered, for the job record.
        /// </summary>
        public static int? Answer(string dialogId, string message, out string rule)
        {
            rule = "";
            string id = (dialogId ?? "").ToLowerInvariant();
            string text = (message ?? "").ToLowerInvariant();
            if (Never(id, text)) return null;
            if (id == "dialog_revit_pastesimilarsymbolspaste" || text.Contains("duplicate types") ||
                (text.Contains("following types already exist") && text.Contains("destination")))
            {
                rule = "Duplicate Types: OK, the destination's types are used";
                return Ok;
            }
            return null;
        }

        /// <summary>Saving, synchronising, recovery, crashes and errors are never answered by a tool (Manual rule).</summary>
        public static bool Never(string id, string text)
        {
            string[] words = { "save", "sync", "recover", "crash", "fatal", "error", "corrupt", "central", "relinquish", "upgrade" };
            foreach (string w in words) if (id.Contains(w) || text.Contains(w)) return true;
            return false;
        }

        private static bool Flag(string name)
        {
            try { return Environment.GetEnvironmentVariable(name) == "1"; }
            catch (Exception) { return false; }
        }
    }
}
