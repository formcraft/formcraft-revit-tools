using System.IO;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Shared pieces for the gap-analysis tools (fmc_transfer, fmc_cad_audit, fmc_carbon, fmc_view_audit).</summary>
    internal static class FmcGap
    {
        public const double FtToMm = 304.8;
        public const double Ft3ToM3 = 0.028316846592;
        public const double Ft2ToM2 = 0.09290304;

        /// <summary>A second open document by title (with or without .rvt) or full path. Never the active document by default.</summary>
        public static Document FindOpen(UIApplication app, string key, string role)
        {
            key = (key ?? "").Trim();
            if (key.Length == 0) throw new InvalidOperationException($"[FMC-DOC-REQUIRED] {role} needs a document title or full path.");
            var found = new List<Document>();
            foreach (Document d in app.Application.Documents)
            {
                if (d.IsLinked) continue;
                string title = d.Title ?? "";
                string bare = Path.GetFileNameWithoutExtension(title);
                string path = d.PathName ?? "";
                if (string.Equals(title, key, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(bare, Path.GetFileNameWithoutExtension(key), StringComparison.OrdinalIgnoreCase) && !key.Contains("\\")
                    || (path.Length > 0 && string.Equals(path, key, StringComparison.OrdinalIgnoreCase)))
                    found.Add(d);
            }
            if (found.Count > 1) throw new InvalidOperationException($"[FMC-DOC-AMBIGUOUS] {role} \"{key}\" matches {found.Count} open documents. Pass the full path.");
            if (found.Count == 0) throw new InvalidOperationException($"[FMC-DOC-NOT-FOUND] {role} \"{key}\" is not open. It is not opened by this tool.");
            return found[0];
        }

        /// <summary>The checks every gap-tool write makes on the document it changes.</summary>
        public static void RefuseWrite(Document doc, JObject parameters, string tool)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException($"HEBERT HOSTELS is not written by {tool}.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException($"A central model is not written by {tool}.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException($"{tool} writes project documents only.");
            if (doc.IsReadOnly) throw new InvalidOperationException($"{doc.Title} is read-only.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        public static string Id(ElementId id) => id == null ? "" : id.Value.ToString();

        public static ElementId IdOf(string text)
        {
            return long.TryParse((text ?? "").Trim(), out long value) ? new ElementId(value) : ElementId.InvalidElementId;
        }

        public static string NameOf(Document doc, ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId) return "";
            try { return doc.GetElement(id)?.Name ?? ""; } catch (Exception) { return ""; }
        }
    }

    /// <summary>Copying between documents keeps the target's types when names clash.</summary>
    internal sealed class FmcUseDestinationTypes : IDuplicateTypeNamesHandler
    {
        public DuplicateTypeAction OnDuplicateTypeNamesFound(DuplicateTypeNamesHandlerArgs args) => DuplicateTypeAction.UseDestinationTypes;
    }
}
