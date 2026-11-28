using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_handover_read (NBRB / DITACO handover package, L011-F24): the document, its project information and the
    /// named parameters on the elements of the named categories. Read-only: no transaction, nothing saved. The server
    /// writes the zip, so this handler never touches a file.
    /// </summary>
    public class FmcHandoverHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft handover read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_handover needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    List<string> categories = FmcPhaseIds.Strings(Parameters["categories"] as JArray);
                    List<string> names = FmcPhaseIds.Strings(Parameters["parameters"] as JArray);
                    int max = Math.Max(1, Math.Min(200000, Parameters.Value<int?>("max_elements") ?? 20000));
                    var counts = new JObject();
                    var unknown = new JArray();
                    JArray rows = Rows(doc, categories, names, max, counts, unknown, out bool truncated);
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_family"] = doc.IsFamilyDocument,
                        ["is_workshared"] = doc.IsWorkshared,
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["is_modified"] = doc.IsModified,
                        ["is_cloud"] = IsCloud(doc),
                        ["revit_version"] = app.Application.VersionNumber ?? "",
                        ["project_info"] = ProjectInfo(doc),
                        ["counts"] = counts,
                        ["unknown_categories"] = unknown,
                        ["elements"] = rows,
                        ["truncated"] = truncated,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static bool IsCloud(Document doc)
        {
            try { return doc.IsModelInCloud; } catch (Exception) { return false; }
        }

        private static JArray ProjectInfo(Document doc)
        {
            var rows = new JArray();
            ProjectInfo info = doc.ProjectInformation;
            if (info == null) return rows;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Parameter p in info.Parameters)
            {
                string name = p?.Definition?.Name ?? "";
                if (name.Length == 0 || !seen.Add(name)) continue;
                rows.Add(new JObject { ["name"] = name, ["value"] = Value(p) });
            }
            return rows;
        }

        private static JArray Rows(Document doc, List<string> categories, List<string> names, int max, JObject counts, JArray unknown, out bool truncated)
        {
            truncated = false;
            var rows = new JArray();
            foreach (string name in categories)
            {
                if (!Enum.TryParse(name, true, out BuiltInCategory bic)) { unknown.Add(name); continue; }
                int count = 0;
                IList<Element> found;
                try { found = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().ToElements(); }
                catch (Exception) { unknown.Add(name); continue; }
                foreach (Element e in found)
                {
                    if (e == null || e.Category == null) continue;
                    if (e.ViewSpecific) continue;
                    count++;
                    if (rows.Count >= max) { truncated = true; continue; }
                    Element type = doc.GetElement(e.GetTypeId());
                    var values = new JObject();
                    var sources = new JObject();
                    foreach (string param in names)
                    {
                        Parameter p = e.LookupParameter(param);
                        string from = "instance";
                        if (p == null && type != null) { p = type.LookupParameter(param); from = "type"; }
                        if (p == null) continue;
                        values[param] = Value(p);
                        sources[param] = from;
                    }
                    string level = "";
                    if (e.LevelId != null && e.LevelId != ElementId.InvalidElementId) level = doc.GetElement(e.LevelId)?.Name ?? "";
                    rows.Add(new JObject
                    {
                        ["id"] = e.Id.Value.ToString(),
                        ["unique_id"] = e.UniqueId ?? "",
                        ["category"] = bic.ToString(),
                        ["category_name"] = e.Category.Name ?? "",
                        ["family"] = (type as ElementType)?.FamilyName ?? "",
                        ["type"] = type?.Name ?? "",
                        ["level"] = level,
                        ["values"] = values,
                        ["sources"] = sources,
                    });
                }
                counts[bic.ToString()] = count;
            }
            return rows;
        }

        private static string Value(Parameter p)
        {
            if (p == null || !p.HasValue) return "";
            try
            {
                switch (p.StorageType)
                {
                    case StorageType.String: return p.AsString() ?? "";
                    case StorageType.ElementId: return p.AsValueString() ?? "";
                    default: return p.AsValueString() ?? p.AsString() ?? "";
                }
            }
            catch (Exception) { return ""; }
        }
    }
}
