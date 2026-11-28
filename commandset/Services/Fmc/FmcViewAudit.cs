using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_view_audit read: every view with its template, sheet, discipline, detail level, crop, scope box, view range and
    /// link overrides; every template with its non-controlled parameters; every filter with its users. No transaction.
    /// </summary>
    public class FmcViewAuditReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private static readonly HashSet<ViewType> Skip = new HashSet<ViewType> { ViewType.ProjectBrowser, ViewType.SystemBrowser, ViewType.Internal, ViewType.Undefined };
        private static readonly HashSet<ViewType> TakesTemplate = new HashSet<ViewType>
        {
            ViewType.FloorPlan, ViewType.CeilingPlan, ViewType.EngineeringPlan, ViewType.AreaPlan, ViewType.Section, ViewType.Elevation,
            ViewType.Detail, ViewType.ThreeD, ViewType.DraftingView, ViewType.Schedule, ViewType.Rendering, ViewType.Walkthrough,
        };

        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft view audit read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_view_audit needs document. Refusing to use the active document.");
                int max = Parameters.Value<int?>("max_views") ?? 20000;
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var sheetOf = new Dictionary<long, string>();
                    foreach (Viewport vp in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
                        sheetOf[vp.ViewId.Value] = (doc.GetElement(vp.SheetId) as ViewSheet)?.SheetNumber ?? "";
                    foreach (ScheduleSheetInstance si in new FilteredElementCollector(doc).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>())
                        sheetOf[si.ScheduleId.Value] = (doc.GetElement(si.OwnerViewId) as ViewSheet)?.SheetNumber ?? "";
                    var links = new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>().ToList();

                    var all = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !Skip.Contains(v.ViewType)).ToList();
                    var templateUsers = new Dictionary<long, int>();
                    var filterUsers = new Dictionary<long, int>();
                    var views = new JArray();
                    bool capped = false;
                    foreach (View v in all)
                    {
                        foreach (ElementId f in FiltersOf(v)) filterUsers[f.Value] = (filterUsers.TryGetValue(f.Value, out int n) ? n : 0) + 1;
                        if (v.IsTemplate) continue;
                        if (v is ViewSchedule vs && vs.IsTitleblockRevisionSchedule) continue;
                        ElementId tid = v.ViewTemplateId;
                        if (tid != null && tid != ElementId.InvalidElementId) templateUsers[tid.Value] = (templateUsers.TryGetValue(tid.Value, out int u) ? u : 0) + 1;
                        if (views.Count >= max) { capped = true; continue; }
                        var row = new JObject
                        {
                            ["id"] = FmcGap.Id(v.Id),
                            ["name"] = v.Name ?? "",
                            ["view_type"] = v.ViewType.ToString(),
                            ["template_capable"] = TakesTemplate.Contains(v.ViewType),
                            ["template"] = FmcGap.NameOf(doc, tid),
                            ["template_id"] = tid == null ? "-1" : tid.Value.ToString(),
                            ["on_sheet"] = v.ViewType == ViewType.DrawingSheet || sheetOf.ContainsKey(v.Id.Value),
                            ["sheet"] = sheetOf.TryGetValue(v.Id.Value, out string sheet) ? sheet : "",
                            ["discipline"] = Try(() => v.Discipline.ToString()),
                            ["detail_level"] = Try(() => v.DetailLevel.ToString()),
                            ["crop_active"] = TryBool(() => v.CropBoxActive),
                            ["crop_visible"] = TryBool(() => v.CropBoxVisible),
                            ["scope_box"] = FmcGap.NameOf(doc, v.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST_CROP)?.AsElementId()),
                            ["filters"] = new JArray(FiltersOf(v).Select(f => FmcGap.NameOf(doc, f))),
                        };
                        if (v is ViewPlan plan) row["view_range"] = Range(doc, plan);
                        var overrides = LinkOverrides(doc, v, links);
                        if (overrides != null) row["link_overrides"] = overrides;
                        views.Add(row);
                    }

                    var templates = new JArray();
                    foreach (View t in all.Where(v => v.IsTemplate))
                    {
                        var non = new JArray();
                        int controlled = 0;
                        try { foreach (ElementId pid in t.GetNonControlledTemplateParameterIds()) non.Add(ParamName(doc, pid)); } catch (Exception) { /* not a template that lists parameters */ }
                        try { controlled = t.GetTemplateParameterIds().Count - non.Count; } catch (Exception) { /* not published */ }
                        templates.Add(new JObject
                        {
                            ["id"] = FmcGap.Id(t.Id),
                            ["name"] = t.Name ?? "",
                            ["view_type"] = t.ViewType.ToString(),
                            ["users"] = templateUsers.TryGetValue(t.Id.Value, out int u) ? u : 0,
                            ["controlled"] = controlled,
                            ["non_controlled"] = non,
                            ["filters"] = new JArray(FiltersOf(t).Select(f => FmcGap.NameOf(doc, f))),
                        });
                    }

                    var filters = new JArray();
                    foreach (FilterElement f in new FilteredElementCollector(doc).OfClass(typeof(FilterElement)).Cast<FilterElement>())
                        filters.Add(new JObject { ["id"] = FmcGap.Id(f.Id), ["name"] = f.Name ?? "", ["kind"] = f.GetType().Name, ["used_by"] = filterUsers.TryGetValue(f.Id.Value, out int n) ? n : 0 });

                    var boxes = new JArray();
                    foreach (Element b in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_VolumeOfInterest).WhereElementIsNotElementType())
                        boxes.Add(new JObject { ["id"] = FmcGap.Id(b.Id), ["name"] = b.Name ?? "" });

                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["views"] = views,
                        ["templates"] = templates,
                        ["filters"] = filters,
                        ["scope_boxes"] = boxes,
                        ["capped"] = capped,
#if REVIT2024_OR_GREATER
                        ["link_overrides_supported"] = true,
#else
                        ["link_overrides_supported"] = false,
#endif
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static IEnumerable<ElementId> FiltersOf(View v)
        {
            try { return v.GetFilters(); } catch (Exception) { return new List<ElementId>(); }
        }

        private static string Try(Func<string> get) { try { return get() ?? ""; } catch (Exception) { return ""; } }

        private static JToken TryBool(Func<bool> get) { try { return new JValue(get()); } catch (Exception) { return JValue.CreateNull(); } }

        private static string ParamName(Document doc, ElementId pid)
        {
            if (pid.Value < 0)
            {
                try { return LabelUtils.GetLabelFor((BuiltInParameter)pid.Value); } catch (Exception) { return pid.Value.ToString(); }
            }
            Element e = doc.GetElement(pid);
            if (e is ParameterElement pe) return pe.GetDefinition()?.Name ?? pe.Name ?? pid.Value.ToString();
            return e?.Name ?? pid.Value.ToString();
        }

        private static JObject Range(Document doc, ViewPlan plan)
        {
            var row = new JObject();
            try
            {
                PlanViewRange r = plan.GetViewRange();
                var planes = new (string key, PlanViewPlane plane)[] { ("top", PlanViewPlane.TopClipPlane), ("cut", PlanViewPlane.CutPlane), ("bottom", PlanViewPlane.BottomClipPlane), ("depth", PlanViewPlane.ViewDepthPlane) };
                foreach (var (key, plane) in planes)
                {
                    ElementId level = r.GetLevelId(plane);
                    string name = level == PlanViewRange.Current ? "Associated level"
                        : level == PlanViewRange.LevelAbove ? "Level above"
                        : level == PlanViewRange.LevelBelow ? "Level below"
                        : level == PlanViewRange.Unlimited ? "Unlimited"
                        : FmcGap.NameOf(doc, level);
                    row[key] = new JObject { ["level"] = name, ["offset_mm"] = Math.Round(r.GetOffset(plane) * FmcGap.FtToMm, 1) };
                }
            }
            catch (Exception ex) { row["error"] = ex.Message; }
            return row;
        }

        private static JArray LinkOverrides(Document doc, View v, List<RevitLinkInstance> links)
        {
#if REVIT2024_OR_GREATER
            if (links.Count == 0 || v.ViewType == ViewType.Schedule || v.ViewType == ViewType.DrawingSheet || v.ViewType == ViewType.Legend) return null;
            var list = new JArray();
            foreach (RevitLinkInstance link in links)
            {
                try
                {
                    RevitLinkGraphicsSettings s = v.GetLinkOverrides(link.Id);
                    list.Add(new JObject { ["link"] = link.Name ?? "", ["mode"] = s == null ? "ByHostView" : s.LinkVisibilityType.ToString() });
                }
                catch (Exception) { /* this view type has no link graphics */ }
            }
            return list.Count > 0 ? list : null;
#else
            return null;
#endif
        }
    }

    /// <summary>
    /// fmc_view_audit fixes: one transaction, one subtransaction per fix, by element id from the dry run. A fix that Revit
    /// refuses (for example a setting the template controls) is rolled back alone and reported. Nothing is deleted.
    /// </summary>
    public class FmcViewAuditApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft view audit fixes";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_view_audit_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    FmcGap.RefuseWrite(doc, Parameters, "fmc_view_audit");
                    var applied = new JArray();
                    var failed = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft view audit fixes"))
                    {
                        transaction.Start();
                        try
                        {
                            foreach (JObject op in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                using (var sub = new SubTransaction(doc))
                                {
                                    sub.Start();
                                    try
                                    {
                                        One(doc, op);
                                        sub.Commit();
                                        applied.Add(op);
                                    }
                                    catch (Exception ex)
                                    {
                                        if (sub.HasStarted() && !sub.HasEnded()) sub.RollBack();
                                        var row = (JObject)op.DeepClone();
                                        row["reason"] = ex.Message;
                                        failed.Add(row);
                                    }
                                }
                            }
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject
                    {
                        ["ok"] = failed.Count == 0,
                        ["applied"] = applied,
                        ["failed"] = failed,
                        ["deleted"] = 0,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static View ViewById(Document doc, string id, string name, bool template)
        {
            View v = doc.GetElement(FmcGap.IdOf(id)) as View;
            if (v == null || v.IsTemplate != template) throw new InvalidOperationException($"[FMC-VIEWAUDIT-NOT-FOUND] {(template ? "Template" : "View")} {name} (id {id}) is gone.");
            if (!string.Equals(v.Name, name, StringComparison.Ordinal)) throw new InvalidOperationException($"[FMC-VIEWAUDIT-CHANGED] Id {id} is now named {v.Name}, not {name}. Run the dry run again.");
            return v;
        }

        private static void One(Document doc, JObject op)
        {
            string kind = op.Value<string>("op") ?? "";
            if (kind == "control_template_params")
            {
                View t = ViewById(doc, op.Value<string>("template_id"), op.Value<string>("template"), true);
                var names = new HashSet<string>((op["parameters"] as JArray ?? new JArray()).Select(p => p.ToString()), StringComparer.OrdinalIgnoreCase);
                var keep = new List<ElementId>();
                foreach (ElementId pid in t.GetNonControlledTemplateParameterIds())
                {
                    string label = pid.Value < 0 ? SafeLabel(pid) : (doc.GetElement(pid) is ParameterElement pe ? pe.GetDefinition()?.Name ?? pe.Name : doc.GetElement(pid)?.Name) ?? pid.Value.ToString();
                    if (!names.Contains(label)) keep.Add(pid);
                }
                t.SetNonControlledTemplateParameterIds(keep);
                return;
            }
            View v = ViewById(doc, op.Value<string>("view_id"), op.Value<string>("view"), false);
            switch (kind)
            {
                case "assign_template":
                    ElementId tid = FmcGap.IdOf(op.Value<string>("template_id"));
                    if (!v.IsValidViewTemplate(tid)) throw new InvalidOperationException("[FMC-VIEWAUDIT-TEMPLATE-TYPE] Revit says this template does not fit this view.");
                    v.ViewTemplateId = tid;
                    break;
                case "set_detail_level":
                    v.DetailLevel = (ViewDetailLevel)Enum.Parse(typeof(ViewDetailLevel), op.Value<string>("value"));
                    break;
                case "set_discipline":
                    v.Discipline = (ViewDiscipline)Enum.Parse(typeof(ViewDiscipline), op.Value<string>("value"));
                    break;
                case "set_crop":
                    var crop = op["value"] as JObject ?? new JObject();
                    if (crop["crop_active"]?.Type == JTokenType.Boolean) v.CropBoxActive = crop.Value<bool>("crop_active");
                    if (crop["crop_visible"]?.Type == JTokenType.Boolean) v.CropBoxVisible = crop.Value<bool>("crop_visible");
                    break;
                case "set_scope_box":
                    var box = op["value"] as JObject ?? new JObject();
                    Parameter p = v.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST_CROP);
                    if (p == null || p.IsReadOnly) throw new InvalidOperationException("[FMC-VIEWAUDIT-READONLY] Scope box is not editable on this view (a template may control it).");
                    ElementId bid = FmcGap.IdOf(box.Value<string>("scope_box_id"));
                    p.Set(bid.Value < 0 ? ElementId.InvalidElementId : bid);
                    break;
                default:
                    throw new InvalidOperationException("[FMC-VIEWAUDIT-OP] Unknown fix " + kind + ".");
            }
        }

        private static string SafeLabel(ElementId pid)
        {
            try { return LabelUtils.GetLabelFor((BuiltInParameter)pid.Value); } catch (Exception) { return pid.Value.ToString(); }
        }
    }
}
