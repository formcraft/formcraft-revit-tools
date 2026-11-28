using System.IO;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// GAP-14 read only: imported and linked CAD, import line-style categories, CAD inside loadable families and raster
    /// images. No transaction and nothing is deleted. A family is opened with EditFamily, read, and closed unsaved.
    /// </summary>
    public class FmcCadAuditHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft CAD audit";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_cad_audit needs document. Refusing to use the active document.");
                bool scanFamilies = Parameters.Value<bool?>("scan_families") ?? true;
                int maxFamilies = Parameters.Value<int?>("max_families") ?? 300;
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var imports = new JArray();
                    var usedCats = new HashSet<long>();
                    foreach (ImportInstance inst in new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)).Cast<ImportInstance>())
                    {
                        if (inst.Category != null) usedCats.Add(inst.Category.Id.Value);
                        var row = new JObject
                        {
                            ["id"] = FmcGap.Id(inst.Id),
                            ["name"] = inst.Category?.Name ?? FmcGap.NameOf(doc, inst.GetTypeId()),
                            ["type_id"] = FmcGap.Id(inst.GetTypeId()),
                            ["is_linked"] = inst.IsLinked,
                            ["view_specific"] = inst.ViewSpecific,
                            ["owner_view"] = inst.ViewSpecific ? FmcGap.NameOf(doc, inst.OwnerViewId) : "",
                            ["pinned"] = inst.Pinned,
                        };
                        if (inst.IsLinked && doc.GetElement(inst.GetTypeId()) is CADLinkType linkType)
                        {
                            try
                            {
                                if (linkType.IsExternalFileReference())
                                {
                                    ExternalFileReference efr = linkType.GetExternalFileReference();
                                    row["link_path"] = ModelPathUtils.ConvertModelPathToUserVisiblePath(efr.GetAbsolutePath());
                                    row["link_status"] = efr.GetLinkedFileStatus().ToString();
                                }
                            }
                            catch (Exception ex) { row["link_status"] = "Unknown: " + ex.Message; }
                        }
                        imports.Add(row);
                    }

                    var categories = new JArray();
                    foreach (Category c in doc.Settings.Categories)
                    {
                        if (c == null || c.CategoryType != CategoryType.Import) continue;
                        categories.Add(new JObject { ["name"] = c.Name ?? "", ["subcategories"] = c.SubCategories?.Size ?? 0, ["used"] = usedCats.Contains(c.Id.Value) });
                    }

                    var families = new JArray();
                    int scanned = 0, skipped = 0;
                    if (scanFamilies)
                    {
                        foreach (Family family in new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>())
                        {
                            if (family.IsInPlace || !family.IsEditable) continue;
                            if (scanned >= maxFamilies) { skipped++; continue; }
                            scanned++;
                            Document fd = null;
                            try
                            {
                                fd = doc.EditFamily(family);
                                var inFamily = new FilteredElementCollector(fd).OfClass(typeof(ImportInstance)).Cast<ImportInstance>().ToList();
                                if (inFamily.Count == 0) continue;
                                families.Add(new JObject
                                {
                                    ["name"] = family.Name ?? "",
                                    ["category"] = family.FamilyCategory?.Name ?? "",
                                    ["imports"] = inFamily.Count(i => !i.IsLinked),
                                    ["linked"] = inFamily.Count(i => i.IsLinked),
                                    ["names"] = new JArray(inFamily.Select(i => i.Category?.Name ?? "").Where(n => n.Length > 0).Distinct()),
                                });
                            }
                            catch (Exception ex)
                            {
                                families.Add(new JObject { ["name"] = family.Name ?? "", ["imports"] = 0, ["linked"] = 0, ["error"] = ex.Message });
                            }
                            finally
                            {
                                if (fd != null) { try { fd.Close(false); } catch (Exception) { /* Revit closes it with the session */ } }
                            }
                        }
                    }

                    var images = new JArray();
                    var placed = new Dictionary<long, List<string>>();
                    foreach (ImageInstance ii in new FilteredElementCollector(doc).OfClass(typeof(ImageInstance)).Cast<ImageInstance>())
                    {
                        long typeId = ii.GetTypeId().Value;
                        if (!placed.TryGetValue(typeId, out var views)) placed[typeId] = views = new List<string>();
                        views.Add(FmcGap.NameOf(doc, ii.OwnerViewId));
                    }
                    foreach (ImageType it in new FilteredElementCollector(doc).OfClass(typeof(ImageType)).Cast<ImageType>())
                    {
                        string path = "";
                        string source = "";
                        try { path = it.Path ?? ""; } catch (Exception) { /* not published for this image */ }
                        try { source = it.Source.ToString(); } catch (Exception) { /* not published for this image */ }
                        placed.TryGetValue(it.Id.Value, out var views);
                        images.Add(new JObject
                        {
                            ["id"] = FmcGap.Id(it.Id),
                            ["name"] = it.Name ?? "",
                            ["path"] = path,
                            ["source"] = source,
                            ["instances"] = views?.Count ?? 0,
                            ["views"] = new JArray((views ?? new List<string>()).Distinct().Take(20)),
                            ["file_found"] = path.Length == 0 ? JValue.CreateNull() : new JValue(File.Exists(path)),
                        });
                    }

                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["imports"] = imports,
                        ["import_categories"] = categories,
                        ["families"] = families,
                        ["families_scanned"] = scanned,
                        ["families_skipped"] = skipped,
                        ["images"] = images,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
