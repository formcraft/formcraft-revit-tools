using System;
using Autodesk.Revit.DB;

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
    }
}
