using System;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Commands.ExecuteDynamicCode;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// Helpers for scripts sent with send_code_to_revit (F-035, issue #127). The script template has
    /// <c>using RevitMCPCommandSet.Bridge;</c>, so a script can write <c>FmcScript.Mm(2400)</c> or
    /// <c>FmcScript.Run(document, "Walls", () =&gt; { ... })</c>. Kit values never live here (rule 7): these are units and
    /// transaction plumbing only.
    /// </summary>
    public static class FmcScript
    {
        /// <summary>Millimetres per foot (Revit's internal length unit).</summary>
        public const double MmPerFoot = 304.8;

        /// <summary>Millimetres to Revit's internal feet.</summary>
        public static double Mm(double millimetres) => millimetres / MmPerFoot;

        /// <summary>Revit's internal feet to millimetres.</summary>
        public static double ToMm(double feet) => feet * MmPerFoot;

        /// <summary>Square metres to Revit's internal square feet.</summary>
        public static double M2(double squareMetres) => squareMetres / (MmPerFoot * MmPerFoot / 1_000_000.0);

        /// <summary>Revit's internal square feet to square metres.</summary>
        public static double ToM2(double squareFeet) => squareFeet * (MmPerFoot * MmPerFoot / 1_000_000.0);

        /// <summary>A point given in millimetres.</summary>
        public static XYZ PointMm(double x, double y, double z = 0) => new XYZ(Mm(x), Mm(y), Mm(z));

        /// <summary>A point's coordinates in millimetres, rounded to 0.1 mm, for results.</summary>
        public static double[] ToMm(XYZ p) => new[] { Math.Round(ToMm(p.X), 1), Math.Round(ToMm(p.Y), 1), Math.Round(ToMm(p.Z), 1) };

        /// <summary>Stops the script here if the job was cancelled (fmc_job cancel).</summary>
        public static void ThrowIfCancelled() => FmcAiJob.ThrowIfCancelled();

        /// <summary>
        /// Runs <paramref name="body"/> in its own transaction with the default failures handling (warnings deleted and
        /// listed in the job's result, errors roll back with their text). Checks for a cancel before it starts and before
        /// it commits. Use it with transactionMode "none". Returns the transaction's status; an exception in the body
        /// rolls back and is passed on.
        /// </summary>
        public static TransactionStatus Run(Document document, string name, Action body)
        {
            FmcAiJob.ThrowIfCancelled();
            using (var transaction = new Transaction(document, string.IsNullOrWhiteSpace(name) ? "FMC: AI script" : name))
            {
                FmcAiJob.Failures.Attach(transaction);
                transaction.Start();
                body();
                if (FmcAiJob.CancelRequested(FmcAiJob.Current))
                {
                    transaction.RollBack();
                    FmcAiJob.ThrowIfCancelled();
                }
                return transaction.Commit();
            }
        }

        /// <summary>
        /// KISIC §4.1: runs <paramref name="body"/> in its own transaction with the default failures handling. Commits; rolls
        /// back on any exception (and passes it on); a dry run rolls back after the body ran, so nothing changes but the
        /// body's answer is still returned. Revit rolling the commit back is FMC-CODE-ROLLED-BACK with its errors. Use it
        /// with transactionMode "none" (saved add-ons always do). Build the answer from plain values (ids, counts, names):
        /// after a dry run the elements made inside are gone.
        /// </summary>
        public static T Tx<T>(Document document, string name, bool dryRun, Func<T> body)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));
            if (body == null) throw new ArgumentNullException(nameof(body));
            FmcAiJob.ThrowIfCancelled();
            using (var transaction = new Transaction(document, string.IsNullOrWhiteSpace(name) ? "FMC: add-on" : name))
            {
                FmcAiJob.Failures.Attach(transaction);
                transaction.Start();
                T value;
                try
                {
                    value = body();
                }
                catch
                {
                    if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack();
                    throw;
                }
                if (dryRun)
                {
                    transaction.RollBack();
                    return value;
                }
                if (FmcAiJob.CancelRequested(FmcAiJob.Current))
                {
                    transaction.RollBack();
                    FmcAiJob.ThrowIfCancelled();
                }
                TransactionStatus status = transaction.Commit();
                if (status != TransactionStatus.Committed)
                    throw new ScriptFailure("FMC-CODE-ROLLED-BACK",
                        $"Revit rolled \"{transaction.GetName()}\" back, so nothing was changed: " +
                        (FmcAiJob.Failures.Errors.Count > 0 ? string.Join(" | ", FmcAiJob.Failures.Errors) : $"status {status}."));
                return value;
            }
        }

        /// <summary><see cref="Tx{T}"/> for a body with no answer; returns "Committed" or "RolledBack (dry run)".</summary>
        public static string Tx(Document document, string name, bool dryRun, Action body)
        {
            if (body == null) throw new ArgumentNullException(nameof(body));
            Tx<object>(document, name, dryRun, () => { body(); return null; });
            return dryRun ? "RolledBack (dry run)" : "Committed";
        }

        /// <summary>
        /// KISIC §4.3: copy options that keep the destination's types when names clash, so ElementTransformUtils.CopyElements
        /// never stops at Revit's Duplicate Types dialog. Scripts can't declare classes, so the handler lives here.
        /// </summary>
        public static CopyPasteOptions CopyOptionsUseDestinationTypes()
        {
            var options = new CopyPasteOptions();
            options.SetDuplicateTypeNamesHandler(new UseDestinationTypes());
            return options;
        }

        private sealed class UseDestinationTypes : IDuplicateTypeNamesHandler
        {
            public DuplicateTypeAction OnDuplicateTypeNamesFound(DuplicateTypeNamesHandlerArgs args) => DuplicateTypeAction.UseDestinationTypes;
        }

        /// <summary>A saved add-on's parameters (docs/ADDONS.md): parameters[0] is the JSON object; empty when not given.</summary>
        public static JObject Params(object[] parameters)
        {
            string json = parameters != null && parameters.Length > 0 ? parameters[0] as string : null;
            if (string.IsNullOrWhiteSpace(json)) return new JObject();
            try
            {
                return JObject.Parse(json);
            }
            catch (Exception ex)
            {
                throw new ScriptFailure("FMC-CODE-PARAMS", $"parameters[0] is not a JSON object: {ex.Message}");
            }
        }

        /// <summary>A saved add-on's mode: parameters[1] is "dry" or "real". Anything but "real" is a dry run.</summary>
        public static bool IsDryRun(object[] parameters) =>
            !(parameters != null && parameters.Length > 1 && string.Equals(parameters[1] as string, "real", StringComparison.OrdinalIgnoreCase));

        /// <summary>
        /// The bridge wraps every <c>new Transaction(</c>, <c>new SubTransaction(</c> and <c>new TransactionGroup(</c> in a
        /// script in this call, so whatever is left open after the run is rolled back and reported (FMC-CODE-TX-LEAK).
        /// Scripts don't need to call it.
        /// </summary>
        public static T Track<T>(T transaction) where T : class => FmcTxGuard.Track(transaction);
    }
}
