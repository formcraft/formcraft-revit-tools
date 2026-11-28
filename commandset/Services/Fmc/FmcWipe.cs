using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_wipe (GAP-02): a project model's clutter by category (unused view templates and filters, unplaced views and
    /// schedules, imported CAD, orphan tags, and Revit 2024+'s purgeable elements). The scan never writes. Apply checks
    /// each id again, skips elements another user owns, and deletes in one transaction "Formcraft: wipe".
    /// Not a family or material purge.
    /// </summary>
    public static class FmcWipeCore
    {
        private static readonly HashSet<ViewType> PlacedTypes = new HashSet<ViewType>
        {
            ViewType.FloorPlan, ViewType.CeilingPlan, ViewType.Elevation, ViewType.Section, ViewType.ThreeD,
            ViewType.Detail, ViewType.DraftingView, ViewType.AreaPlan, ViewType.EngineeringPlan, ViewType.Legend,
        };

        /// <summary>Element ids per category, with the element. activeViewId is never listed.</summary>
        public static Dictionary<string, List<Element>> Scan(Document doc, ISet<string> categories, ElementId activeViewId, JArray problems)
        {
            var found = new Dictionary<string, List<Element>>();
            List<View> views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().ToList();

            if (categories.Contains("unused_view_templates"))
            {
                var used = new HashSet<ElementId>(views.Where(v => !v.IsTemplate).Select(v => v.ViewTemplateId));
                foreach (ViewFamilyType t in new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>())
                    used.Add(t.DefaultTemplateId);
                found["unused_view_templates"] = views.Where(v => v.IsTemplate && !used.Contains(v.Id)).Cast<Element>().ToList();
            }
            if (categories.Contains("unused_filters"))
            {
                var used = new HashSet<ElementId>();
                foreach (View v in views)
                {
                    try { if (v.AreGraphicsOverridesAllowed()) foreach (ElementId f in v.GetFilters()) used.Add(f); }
                    catch (Autodesk.Revit.Exceptions.InvalidOperationException) { }
                }
                found["unused_filters"] = new FilteredElementCollector(doc).OfClass(typeof(FilterElement))
                    .Where(f => !used.Contains(f.Id)).ToList();
            }
            if (categories.Contains("unplaced_views"))
            {
                var placed = new HashSet<ElementId>(new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>().Select(p => p.ViewId));
                found["unplaced_views"] = views.Where(v => !v.IsTemplate && PlacedTypes.Contains(v.ViewType) && !placed.Contains(v.Id)
                    && v.Id != activeViewId && v.GetDependentViewIds().Count == 0).Cast<Element>().ToList();
            }
            if (categories.Contains("unplaced_schedules"))
            {
                var placed = new HashSet<ElementId>(new FilteredElementCollector(doc).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>().Select(s => s.ScheduleId));
                found["unplaced_schedules"] = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                    .Where(s => !s.IsTemplate && !s.IsTitleblockRevisionSchedule && !s.IsInternalKeynoteSchedule && !placed.Contains(s.Id) && s.Id != activeViewId)
                    .Cast<Element>().ToList();
            }
            if (categories.Contains("cad_imports"))
                found["cad_imports"] = new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)).Cast<ImportInstance>()
                    .Where(i => !i.IsLinked).Cast<Element>().ToList();
            if (categories.Contains("orphan_tags"))
                found["orphan_tags"] = new FilteredElementCollector(doc).OfClass(typeof(IndependentTag)).Cast<IndependentTag>()
                    .Where(t => t.IsOrphaned).Cast<Element>().ToList();
            if (categories.Contains("purgeable"))
            {
#if REVIT2024_OR_GREATER
                found["purgeable"] = doc.GetUnusedElements(new HashSet<ElementId>()).Select(id => doc.GetElement(id)).Where(e => e != null).ToList();
#else
                problems.Add("purgeable needs Revit 2024 or later");
                found["purgeable"] = new List<Element>();
#endif
            }
            return found;
        }

        public static string Kind(Element e) => e is View v ? v.ViewType.ToString() : e.GetType().Name;
    }

    /// <summary>The wipe scan: counts and ids per category. No transaction.</summary>
    public class FmcWipeScanHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft wipe scan";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_wipe needs document.");
                var cats = new HashSet<string>((Parameters["categories"] as JArray ?? new JArray()).Select(c => c.ToString()));
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-WIPE-FAMILY] fmc_wipe is for project models; use fmc_fam_purge for families.");
                    ElementId active = app.ActiveUIDocument?.Document?.Equals(doc) == true ? app.ActiveUIDocument.ActiveView?.Id ?? ElementId.InvalidElementId : ElementId.InvalidElementId;
                    var problems = new JArray();
                    var rows = new JArray();
                    foreach (var kv in FmcWipeCore.Scan(doc, cats, active, problems))
                        foreach (Element e in kv.Value)
                        {
                            var row = new JObject { ["id"] = e.Id.GetValue().ToString(), ["category"] = kv.Key, ["name"] = e.Name ?? "", ["kind"] = FmcWipeCore.Kind(e) };
                            FmcExtStoreSchema.Checkout(doc, e.Id, row);
                            rows.Add(row);
                        }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["rows"] = rows,
                        ["problems"] = problems,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>The wipe: each id checked again, other users' elements skipped, one transaction.</summary>
    public class FmcWipeApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft wipe";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_wipe needs document.");
                if ((Parameters.Value<string>("batch_lease") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-BATCH-LOCKED] fmc_wipe deletes only under a batch lease.");
                bool dry = Parameters.Value<bool?>("dry_run") == true;
                JArray items = Parameters["items"] as JArray ?? new JArray();
                var cats = new HashSet<string>(items.OfType<JObject>().Select(i => i.Value<string>("category") ?? ""));
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsReadOnly) throw new InvalidOperationException("[FMC-WIPE-READONLY] The document is read-only.");
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-WIPE-FAMILY] fmc_wipe is for project models.");
                    ElementId active = app.ActiveUIDocument?.Document?.Equals(doc) == true ? app.ActiveUIDocument.ActiveView?.Id ?? ElementId.InvalidElementId : ElementId.InvalidElementId;
                    var problems = new JArray();
                    Dictionary<string, List<Element>> now = FmcWipeCore.Scan(doc, cats, active, problems);
                    var still = now.ToDictionary(kv => kv.Key, kv => new HashSet<long>(kv.Value.Select(e => e.Id.GetValue())));
                    var deleted = new JArray();
                    var skipped = new JArray();
                    var requested = new HashSet<long>();
                    var cascade = new JArray();
                    using (var t = new Transaction(doc, "Formcraft: wipe"))
                    {
                        t.Start();
                        foreach (JObject item in items.OfType<JObject>())
                        {
                            string id = item.Value<string>("id") ?? "";
                            string cat = item.Value<string>("category") ?? "";
                            void skip(string reason) => skipped.Add(new JObject { ["id"] = id, ["category"] = cat, ["reason"] = reason });
                            ElementId eid = FmcExtStoreSchema.ToId(id);
                            if (eid == ElementId.InvalidElementId || !long.TryParse(id, out long n)) { skip("not an element id"); continue; }
                            requested.Add(n);
                            if (doc.GetElement(eid) == null) { skip("already gone (deleted with another element)"); continue; }
                            if (!still.TryGetValue(cat, out HashSet<long> set) || !set.Contains(n)) { skip("no longer " + cat); continue; }
                            if (doc.IsWorkshared && WorksharingUtils.GetCheckoutStatus(doc, eid, out string owner) == CheckoutStatus.OwnedByOtherUser)
                            { skip("owned by " + owner); continue; }
                            try
                            {
                                ICollection<ElementId> gone = doc.Delete(eid);
                                deleted.Add(id);
                                foreach (ElementId g in gone) { long gv = g.GetValue(); if (gv != n) cascade.Add(gv.ToString()); }
                            }
                            catch (Exception ex) { skip("Revit refused: " + ex.Message); }
                        }
                        if (dry) t.RollBack(); else t.Commit();
                    }
                    Result = new JObject
                    {
                        ["dry_run"] = dry,
                        ["transaction"] = "Formcraft: wipe",
                        ["title"] = doc.Title ?? "",
                        ["deleted"] = deleted,
                        ["cascade_ids"] = cascade,
                        ["cascade_count"] = cascade.Count,
                        ["skipped"] = skipped,
                        ["problems"] = problems,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
