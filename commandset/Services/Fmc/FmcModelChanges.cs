using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Bridge;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_changes model read (tool research 1-25, approved 28 Nov). Read-only, no transaction: the document's current
    /// version (DocumentVersion) and, given a base_version GUID, Document.GetChangedElements: every created, modified and
    /// deleted element id since that version, each with its category, built-in category, category type and name.
    /// Deleted ids are only tracked by Revit in workshared models; deleted_available says so. An unknown base version is
    /// reported (base_error), never thrown, so the server can still record the current version.
    /// </summary>
    public class FmcModelChangesHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft model changes (read-only)";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    DocumentVersion version = Document.GetDocumentVersion(doc);
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_workshared"] = doc.IsWorkshared;
                    Result["is_modified"] = doc.IsModified;
                    Result["version"] = new JObject
                    {
                        ["guid"] = version?.VersionGUID.ToString() ?? "",
                        ["saves"] = version?.NumberOfSaves ?? 0,
                    };
                    string baseText = (Parameters.Value<string>("base_version") ?? "").Trim();
                    if (baseText.Length == 0)
                    {
                        Result["compared"] = false;
                        return;
                    }
                    if (!Guid.TryParse(baseText, out Guid baseGuid) || baseGuid == Guid.Empty)
                    {
                        Result["compared"] = false;
                        Result["base_error"] = "base_version is not a document version GUID.";
                        return;
                    }
#if REVIT2023_OR_GREATER
                    try
                    {
                        var diff = doc.GetChangedElements(baseGuid);
                        Result["compared"] = true;
                        Result["base_version"] = baseText;
                        Result["created"] = Rows(doc, diff.GetCreatedElementIds(), true);
                        Result["modified"] = Rows(doc, diff.GetModifiedElementIds(), true);
                        bool deletedAvailable = diff.AreDeletedElementIdsAvailable;
                        Result["deleted_available"] = deletedAvailable;
                        Result["deleted"] = deletedAvailable ? Rows(doc, diff.GetDeletedElementIds(), false) : new JArray();
                    }
                    catch (Autodesk.Revit.Exceptions.ArgumentException ex)
                    {
                        Result["compared"] = false;
                        Result["base_error"] = "Revit does not know base_version " + baseText + " in this document: " + ex.Message;
                    }
#else
                    Result["compared"] = false;
                    Result["base_error"] = "Document.GetChangedElements needs Revit 2023 or later.";
#endif
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JArray Rows(Document doc, ICollection<ElementId> ids, bool look)
        {
            var rows = new JArray();
            foreach (ElementId id in ids ?? new List<ElementId>())
            {
                var row = new JObject { ["id"] = id.Value };
                if (look)
                {
                    Element element = null;
                    try { element = doc.GetElement(id); } catch (Exception) { element = null; }
                    if (element == null) row["missing"] = true;
                    else
                    {
                        Category category = element.Category;
                        row["unique_id"] = element.UniqueId ?? "";
                        row["category"] = category?.Name ?? "";
                        row["bic"] = category != null ? category.BuiltInCategory.ToString() : "";
                        row["category_type"] = category != null ? category.CategoryType.ToString() : "";
                        row["class"] = element.GetType().Name;
                        row["name"] = SafeName(element);
                        row["is_type"] = element is ElementType;
                    }
                }
                rows.Add(row);
            }
            return rows;
        }

        private static string SafeName(Element element)
        {
            try { return element.Name ?? ""; } catch (Exception) { return ""; }
        }
    }
}
