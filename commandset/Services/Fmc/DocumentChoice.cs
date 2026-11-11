using System;
using System.Collections.Generic;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Which open document a call may use when several are open. No Revit types: the rule is tested on its own.
    /// Several documents and no name is a refusal. The active document is not a guess.
    /// </summary>
    public static class DocumentChoice
    {
        public static void RequireNamed(string key, IReadOnlyList<string> openLabels)
        {
            if (!string.IsNullOrWhiteSpace(key)) return;
            int count = openLabels == null ? 0 : openLabels.Count;
            if (count > 1)
                throw new InvalidOperationException(count + " documents are open (" + string.Join("; ", openLabels) + "). Pass document with a title or a full path. Refusing to use the active document.");
            if (count == 0)
                throw new InvalidOperationException("No document is open in Revit. Pass document with a file path.");
        }
    }
}
