using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitMCPCommandSet
{
    /// <summary>
    /// undo_ai_batch's plan, with no Revit types so it is tested offline (tests/undoplan). Given the undo list (bottom first)
    /// it returns the clusters to take back, top first: the last count AI batches, or down to batch_id. One Revit undo takes
    /// a whole cluster (entries with the same id). A person's change in the way refuses the whole plan (never undo a person's
    /// work). Used by both FmcUndo.Undo (then posted) and the dry run (UB-2: returned, nothing posted).
    /// </summary>
    public static class FmcUndoPlan
    {
        public static string BatchOf(string id) => (id ?? "").Split('.')[0];

        public static List<List<T>> Build<T>(IReadOnlyList<T> undoList, Func<T, string> id, Func<T, string> kind, Func<T, string> label,
            Func<T, DateTime> at, string batchId, int count, string docTitle)
        {
            if (undoList == null || undoList.Count == 0)
                throw new InvalidOperationException("Nothing the AI did is on Revit's undo list (a sync, a close or a person's undo cleared it)");
            // clusters from the top: (id, entries)
            var clusters = new List<List<T>>();
            for (int i = undoList.Count - 1; i >= 0; i--)
            {
                if (clusters.Count > 0 && id(clusters[clusters.Count - 1][0]) == id(undoList[i])) clusters[clusters.Count - 1].Add(undoList[i]);
                else clusters.Add(new List<T> { undoList[i] });
            }
            var plan = new List<List<T>>();
            var batches = new List<string>();
            foreach (var c in clusters)
            {
                T top = c[0];
                string topBatch = BatchOf(id(top));
                if (string.IsNullOrEmpty(batchId) && !batches.Contains(topBatch) && batches.Count >= Math.Max(1, count)) break;
                if (kind(top) != "ai")
                    throw new InvalidOperationException($"A person's change is above {(string.IsNullOrEmpty(batchId) ? "the AI's last batch" : "batch " + batchId)}: \"{label(top)}\" ({at(top):HH:mm}). " +
                        "The AI never undoes a person's work: they can undo it themselves, or leave the batch and fix it with a new one.");
                plan.Add(c);
                if (!batches.Contains(topBatch)) batches.Add(topBatch);
                if (!string.IsNullOrEmpty(batchId) && id(top) == batchId) break;
            }
            if (!string.IsNullOrEmpty(batchId) && !plan.Any(c => id(c[0]) == batchId))
                throw new InvalidOperationException($"Batch {batchId} isn't on Revit's undo list for {docTitle} (see undo_ai_batch status)");
            return plan;
        }
    }
}
