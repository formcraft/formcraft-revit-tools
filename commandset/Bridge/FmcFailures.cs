using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// The default failures preprocessor for every transaction an AI tool opens (F-032, issue #124). Warnings are deleted
    /// and kept, so they go back in the tool's result instead of stopping Revit at a dialog. Errors (and document
    /// corruption) roll the transaction back with their text, again without a dialog. Nothing is resolved silently: an
    /// error is never "fixed" by Revit's default resolution, it is reported and the transaction leaves no change.
    /// <para>Use it on a transaction you open: <c>new FmcFailures().Attach(transaction)</c>, or
    /// <c>FmcAiJob.Failures.Attach(transaction)</c> to collect into the running AI job's result. Scripts sent with
    /// send_code_to_revit can use it too (the template has <c>using RevitMCPCommandSet.Bridge;</c>), for example for
    /// <c>StairsEditScope.Commit(new FmcFailures())</c>.</para>
    /// </summary>
    public sealed class FmcFailures : IFailuresPreprocessor
    {
        /// <summary>Warnings Revit raised and this preprocessor deleted, in order, with the failing element ids.</summary>
        public List<string> Warnings { get; } = new List<string>();

        /// <summary>Errors that rolled a transaction back, with the failing element ids.</summary>
        public List<string> Errors { get; } = new List<string>();

        /// <summary>True once an error made this preprocessor roll a transaction back.</summary>
        public bool RolledBack { get; private set; }

        public void Clear()
        {
            Warnings.Clear();
            Errors.Clear();
            RolledBack = false;
        }

        /// <summary>Sets this preprocessor on a transaction (before Start) and clears Revit's failures after a rollback.</summary>
        public FmcFailures Attach(Transaction transaction)
        {
            FailureHandlingOptions options = transaction.GetFailureHandlingOptions();
            options.SetFailuresPreprocessor(this);
            options.SetClearAfterRollback(true);
            transaction.SetFailureHandlingOptions(options);
            return this;
        }

        public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor) => Process(failuresAccessor);

        /// <summary>Deletes warnings (kept in <see cref="Warnings"/>); any error rolls back (kept in <see cref="Errors"/>).</summary>
        public FailureProcessingResult Process(FailuresAccessor accessor)
        {
            bool error = false;
            foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
            {
                string text = Describe(failure);
                FailureSeverity severity = failure.GetSeverity();
                if (severity == FailureSeverity.Warning)
                {
                    Warnings.Add(text);
                    accessor.DeleteWarning(failure);
                }
                else if (severity == FailureSeverity.Error || severity == FailureSeverity.DocumentCorruption)
                {
                    Errors.Add(text);
                    error = true;
                }
            }
            if (!error) return FailureProcessingResult.Continue;

            RolledBack = true;
            try
            {
                FailureHandlingOptions options = accessor.GetFailureHandlingOptions();
                options.SetClearAfterRollback(true);
                accessor.SetFailureHandlingOptions(options);
            }
            catch (Exception)
            {
                // The rollback still happens; Revit may only post its own "rolled back" notice.
            }
            return FailureProcessingResult.ProceedWithRollBack;
        }

        /// <summary>A rollback cancels the job's transaction (used when a person cancels a running AI job).</summary>
        public FailureProcessingResult RollBackForCancel(FailuresAccessor accessor, string why)
        {
            Errors.Add(why);
            RolledBack = true;
            try
            {
                FailureHandlingOptions options = accessor.GetFailureHandlingOptions();
                options.SetClearAfterRollback(true);
                accessor.SetFailureHandlingOptions(options);
            }
            catch (Exception) { }
            return FailureProcessingResult.ProceedWithRollBack;
        }

        private static string Describe(FailureMessageAccessor failure)
        {
            string text = failure.GetDescriptionText() ?? "";
            try
            {
                ICollection<ElementId> ids = failure.GetFailingElementIds();
                if (ids != null && ids.Count > 0)
                    text += $" (elements {string.Join(", ", ids.Take(10).Select(i => i.ToString()))}{(ids.Count > 10 ? $" and {ids.Count - 10} more" : "")})";
            }
            catch (Exception) { /* the description is enough */ }
            return text;
        }
    }
}
