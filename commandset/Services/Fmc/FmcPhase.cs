using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One read for fmc_phase. The server decides the findings. This handler returns ids and phase fields,
    /// not a geometry dump and not an image. It does not start a transaction and does not change the active view.
    /// </summary>
    public class FmcPhaseHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft phases";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-PHASE] fmc_phase runs on a project model.");
                    string scope = (Parameters.Value<string>("scope") ?? "phases").Trim().ToLowerInvariant();
                    var ids = FmcPhaseIds.Longs(Parameters["ids"] as JArray);
                    Result = Collect(doc, scope, ids, FmcPhaseIds.Strings(Parameters["titleblock_params"] as JArray));
                    Result["read_only"] = true;
                    Result["saved"] = false;
                    Result["is_central"] = FmcPhaseIds.IsCentral(doc);
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["active_unchanged"] = true;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        private static JObject Collect(Document doc, string scope, List<long> ids, List<string> titleParams)
        {
            var body = new JObject
            {
                ["phases"] = Phases(doc),
                ["filters"] = Filters(doc),
                ["revisions"] = Revisions(doc),
            };
            if (scope == "phases") return body;
            body["views"] = Views(doc);
            if (scope == "audit") body["elements"] = AuditElements(doc);
            else if (scope == "batch") body["elements"] = NamedElements(doc, ids);
            else if (scope == "compare")
            {
                JArray rows = CompareElements(doc, out bool partial, out int total);
                body["elements"] = rows;
                body["partial"] = partial;
                body["element_total"] = total;
            }
            else if (scope == "cloud")
            {
                body["extents"] = Extents(doc, ids);
            }
            else if (scope == "issue")
            {
                body["sheets"] = Sheets(doc, titleParams);
                body["sheet_sets"] = SheetSets(doc);
            }
            return body;
        }

        private static JArray Phases(Document doc)
        {
            var rows = new JArray();
            PhaseArray phases = doc.Phases;
            for (int i = 0; i < phases.Size; i++)
            {
                Phase phase = phases.get_Item(i);
                rows.Add(new JObject { ["id"] = phase.Id.Value.ToString(), ["name"] = phase.Name ?? "", ["sequence"] = i + 1 });
            }
            return rows;
        }

        private static JArray Filters(Document doc)
        {
            var rows = new JArray();
            foreach (PhaseFilter filter in new FilteredElementCollector(doc).OfClass(typeof(PhaseFilter)).Cast<PhaseFilter>())
                rows.Add(new JObject { ["id"] = filter.Id.Value.ToString(), ["name"] = filter.Name ?? "" });
            return rows;
        }

        private static JArray Revisions(Document doc)
        {
            var rows = new JArray();
            foreach (ElementId id in Revision.GetAllRevisionIds(doc))
            {
                if (doc.GetElement(id) is not Revision revision) continue;
                rows.Add(new JObject
                {
                    ["id"] = id.Value.ToString(),
                    ["sequence"] = revision.SequenceNumber,
                    ["description"] = revision.Description ?? "",
                    ["issued"] = revision.Issued,
                    ["date"] = revision.RevisionDate ?? "",
                    ["issued_by"] = revision.IssuedBy ?? "",
                    ["issued_to"] = revision.IssuedTo ?? "",
                });
            }
            return rows;
        }

        private static JArray Views(Document doc)
        {
            var onSheet = new Dictionary<long, long>();
            var sheetNumber = new Dictionary<long, string>();
            foreach (Viewport viewport in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
            {
                onSheet[viewport.ViewId.Value] = viewport.SheetId.Value;
                if (doc.GetElement(viewport.SheetId) is ViewSheet sheet) sheetNumber[viewport.ViewId.Value] = sheet.SheetNumber ?? "";
            }
            var rows = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                if (view.IsTemplate) continue;
                if (view.ViewType == ViewType.ProjectBrowser || view.ViewType == ViewType.SystemBrowser || view.ViewType == ViewType.Internal) continue;
                Parameter phase = view.get_Parameter(BuiltInParameter.VIEW_PHASE);
                Parameter filter = view.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER);
                string phaseId = phase != null && phase.AsElementId() != null && phase.AsElementId() != ElementId.InvalidElementId ? phase.AsElementId().Value.ToString() : "";
                string filterId = filter != null && filter.AsElementId() != null && filter.AsElementId() != ElementId.InvalidElementId ? filter.AsElementId().Value.ToString() : "";
                string phaseName = phaseId.Length == 0 ? "" : (doc.GetElement(phase.AsElementId())?.Name ?? "");
                string filterName = filterId.Length == 0 ? "" : (doc.GetElement(filter.AsElementId())?.Name ?? "");
                onSheet.TryGetValue(view.Id.Value, out long sheetId);
                sheetNumber.TryGetValue(view.Id.Value, out string number);
                rows.Add(new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["view_type"] = view.ViewType.ToString(),
                    ["phase_id"] = phaseId,
                    ["phase_name"] = phaseName,
                    ["filter_id"] = filterId,
                    ["filter_name"] = filterName,
                    ["sheet_id"] = sheetId == 0 ? "" : sheetId.ToString(),
                    ["sheet_number"] = number ?? "",
                    ["is_template"] = view.IsTemplate,
                });
            }
            return rows;
        }

        private static JArray AuditElements(Document doc)
        {
            var rows = new JArray();
            foreach (Element element in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (!Interesting(element)) continue;
                rows.Add(ElementRow(doc, element));
                if (rows.Count >= 8000) break;
            }
            return rows;
        }

        private static bool Interesting(Element element)
        {
            if (element?.Category == null) return false;
            long category = element.Category.Id.Value;
            if (category == (long)BuiltInCategory.OST_Rooms || category == (long)BuiltInCategory.OST_MEPSpaces) return true;
            if (element is FamilyInstance instance)
            {
                try { if (instance.Host != null) return true; } catch (Exception) { /* no host */ }
            }
            try
            {
                if (element.DemolishedPhaseId != null && element.DemolishedPhaseId != ElementId.InvalidElementId) return true;
            }
            catch (Exception) { /* this category has no phase */ }
            return false;
        }

        private static JArray NamedElements(Document doc, List<long> ids)
        {
            var rows = new JArray();
            foreach (long id in ids.Distinct().Take(50))
            {
                Element element = doc.GetElement(new ElementId(id));
                if (element == null) continue;
                rows.Add(ElementRow(doc, element));
            }
            return rows;
        }

        private static JArray CompareElements(Document doc, out bool partial, out int total)
        {
            var rows = new JArray();
            total = 0;
            foreach (Element element in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                Parameter created = null;
                try { created = element.get_Parameter(BuiltInParameter.PHASE_CREATED); } catch (Exception) { created = null; }
                if (created == null) continue;
                total++;
                if (rows.Count < 8000) rows.Add(ElementRow(doc, element));
            }
            partial = total > rows.Count;
            return rows;
        }

        private static JObject ElementRow(Document doc, Element element)
        {
            string created = "", demolished = "", hostId = "", hostCreated = "", hostDemolished = "";
            try
            {
                if (element.CreatedPhaseId != null && element.CreatedPhaseId != ElementId.InvalidElementId) created = element.CreatedPhaseId.Value.ToString();
                if (element.DemolishedPhaseId != null && element.DemolishedPhaseId != ElementId.InvalidElementId) demolished = element.DemolishedPhaseId.Value.ToString();
            }
            catch (Exception) { /* views and annotations have no phase */ }
            if (element is FamilyInstance instance)
            {
                Element host = null;
                try { host = instance.Host; } catch (Exception) { host = null; }
                if (host != null)
                {
                    hostId = host.Id.Value.ToString();
                    try
                    {
                        if (host.CreatedPhaseId != null && host.CreatedPhaseId != ElementId.InvalidElementId) hostCreated = host.CreatedPhaseId.Value.ToString();
                        if (host.DemolishedPhaseId != null && host.DemolishedPhaseId != ElementId.InvalidElementId) hostDemolished = host.DemolishedPhaseId.Value.ToString();
                    }
                    catch (Exception) { /* host has no phase */ }
                }
            }
            long category = element.Category?.Id.Value ?? 0;
            string kind = category == (long)BuiltInCategory.OST_Rooms ? "room" : category == (long)BuiltInCategory.OST_MEPSpaces ? "space" : hostId.Length > 0 ? "hosted" : "model";
            string number = "", name = "";
            if (element is SpatialElement spatial)
            {
                number = spatial.Number ?? "";
                Parameter roomName = spatial.get_Parameter(BuiltInParameter.ROOM_NAME);
                name = roomName?.AsString() ?? "";
            }
            string mark = "";
            try { mark = element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? ""; } catch (Exception) { mark = ""; }
            string typeName = "";
            try
            {
                ElementId typeId = element.GetTypeId();
                if (typeId != null && typeId != ElementId.InvalidElementId) typeName = doc.GetElement(typeId)?.Name ?? "";
            }
            catch (Exception) { typeName = ""; }
            return new JObject
            {
                ["id"] = element.Id.Value.ToString(),
                ["category"] = element.Category?.Name ?? "Model",
                ["created_phase_id"] = created,
                ["demolished_phase_id"] = demolished,
                ["host_id"] = hostId,
                ["host_created_phase_id"] = hostCreated,
                ["host_demolished_phase_id"] = hostDemolished,
                ["kind"] = kind,
                ["room_number"] = number,
                ["room_name"] = name,
                ["mark"] = mark,
                ["type_name"] = typeName,
            };
        }

        private static JArray Extents(Document doc, List<long> ids)
        {
            var placed = new Dictionary<long, long>();
            foreach (Viewport viewport in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
                placed[viewport.ViewId.Value] = viewport.SheetId.Value;
            var views = new List<View>();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                if (view.IsTemplate) continue;
                if (view is ViewSheet || placed.ContainsKey(view.Id.Value)) views.Add(view);
            }
            var rows = new JArray();
            foreach (long id in ids.Distinct().Take(50))
            {
                Element element = doc.GetElement(new ElementId(id));
                if (element == null) continue;
                foreach (View view in views)
                {
                    BoundingBoxXYZ box = null;
                    try { box = element.get_BoundingBox(view); } catch (Exception) { box = null; }
                    if (box == null) continue;
                    if (!TryExtent(view, box, out double minU, out double minV, out double maxU, out double maxV)) continue;
                    placed.TryGetValue(view.Id.Value, out long sheetId);
                    rows.Add(new JObject
                    {
                        ["element_id"] = id.ToString(),
                        ["view_id"] = view.Id.Value.ToString(),
                        ["sheet_id"] = view is ViewSheet ? view.Id.Value.ToString() : sheetId == 0 ? "" : sheetId.ToString(),
                        ["min_u_mm"] = minU, ["min_v_mm"] = minV, ["max_u_mm"] = maxU, ["max_v_mm"] = maxV,
                    });
                }
            }
            return rows;
        }

        private static bool TryExtent(View view, BoundingBoxXYZ box, out double minU, out double minV, out double maxU, out double maxV)
        {
            minU = minV = double.MaxValue;
            maxU = maxV = double.MinValue;
            try
            {
                XYZ origin = view.Origin, right = view.RightDirection, up = view.UpDirection;
                foreach (XYZ point in new[] { box.Min, box.Max, new XYZ(box.Min.X, box.Max.Y, box.Min.Z), new XYZ(box.Max.X, box.Min.Y, box.Max.Z) })
                {
                    XYZ placed = box.Transform.OfPoint(point) - origin;
                    double u = placed.DotProduct(right) * 304.8, v = placed.DotProduct(up) * 304.8;
                    minU = Math.Min(minU, u); maxU = Math.Max(maxU, u); minV = Math.Min(minV, v); maxV = Math.Max(maxV, v);
                }
            }
            catch (Exception) { return false; }
            return minU < double.MaxValue;
        }

        private static JArray Sheets(Document doc, List<string> titleParams)
        {
            if (titleParams.Count == 0) titleParams = new List<string> { "Current Revision", "Current Revision Date" };
            var rows = new JArray();
            foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            {
                var revisions = new JArray();
                try { foreach (ElementId id in sheet.GetAdditionalRevisionIds()) revisions.Add(id.Value.ToString()); } catch (Exception) { /* none */ }
                var parameters = new JObject();
                foreach (FamilyInstance title in new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().Cast<FamilyInstance>())
                {
                    foreach (string name in titleParams)
                    {
                        Parameter parameter = title.LookupParameter(name);
                        if (parameter == null) { if (parameters[name] == null) parameters[name] = null; continue; }
                        string value = parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
                        parameters[name] = value ?? "";
                    }
                }
                rows.Add(new JObject
                {
                    ["id"] = sheet.Id.Value.ToString(),
                    ["number"] = sheet.SheetNumber ?? "",
                    ["name"] = sheet.Name ?? "",
                    ["set"] = "",
                    ["revision_ids"] = revisions,
                    ["titleblock_params"] = parameters,
                    ["has_revision_schedule"] = HasRevisionSchedule(doc, sheet),
                });
            }
            return rows;
        }

        private static bool HasRevisionSchedule(Document doc, ViewSheet sheet)
        {
            foreach (ScheduleSheetInstance instance in new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>())
            {
                if (doc.GetElement(instance.ScheduleId) is not ViewSchedule schedule) continue;
                if (schedule.Definition?.CategoryId != null && schedule.Definition.CategoryId.Value == (long)BuiltInCategory.OST_Revisions) return true;
                if ((schedule.Name ?? "").IndexOf("revision", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            return false;
        }

        private static JArray SheetSets(Document doc)
        {
            var rows = new JArray();
            foreach (ViewSheetSet set in new FilteredElementCollector(doc).OfClass(typeof(ViewSheetSet)).Cast<ViewSheetSet>())
            {
                var ids = new JArray();
                foreach (View view in set.Views)
                    if (view is ViewSheet) ids.Add(view.Id.Value.ToString());
                rows.Add(new JObject { ["name"] = set.Name ?? "", ["sheet_ids"] = ids });
            }
            return rows;
        }
    }

    internal static class FmcPhaseIds
    {
        internal static List<long> Longs(JArray array)
        {
            var list = new List<long>();
            if (array == null) return list;
            foreach (JToken token in array)
            {
                if (token.Type == JTokenType.Integer) list.Add(token.Value<long>());
                else if (long.TryParse(token.ToString(), out long id) && id > 0) list.Add(id);
            }
            return list;
        }

        internal static List<string> Strings(JArray array)
        {
            var list = new List<string>();
            if (array == null) return list;
            foreach (JToken token in array)
                if (!string.IsNullOrWhiteSpace(token.ToString())) list.Add(token.ToString().Trim());
            return list;
        }

        internal static bool IsCentral(Document doc)
        {
            try
            {
                if (doc == null || !doc.IsWorkshared || string.IsNullOrEmpty(doc.PathName)) return false;
                string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                return !string.IsNullOrEmpty(central) && string.Equals(System.IO.Path.GetFullPath(central), System.IO.Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
        }

        internal static void RefuseWrite(Document doc, JObject parameters)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_phase.");
            if (IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_phase.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }
    }
}
