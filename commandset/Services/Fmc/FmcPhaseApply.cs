using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One transaction for a phase or revision plan. At most 50 operations.
    /// Elements another user owns, or that are not current, are skipped. Nothing is saved or synced.
    /// The active document and the active view are not changed. A hard error rolls the transaction back.
    /// </summary>
    public class FmcPhaseApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft phase apply";

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
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-PHASE] fmc_phase_apply runs on a project model.");
                    FmcPhaseIds.RefuseWrite(doc, Parameters);
                    int cap = Parameters.Value<int?>("max_ops") ?? 50;
                    if (cap < 1) cap = 1;
                    if (cap > 50) cap = 50;
                    var ops = (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>().Take(cap).ToList();
                    var done = new JArray();
                    var skipped = new JArray();
                    var clouds = new JArray();
                    bool hard = false;
                    int changed = 0;
                    string revisionId = "";
                    int sequence = 0;
                    bool issued = false;
                    using (var transaction = new Transaction(doc, "Formcraft phase"))
                    {
                        transaction.Start();
                        foreach (JObject op in ops)
                        {
                            try
                            {
                                JObject row = ApplyOne(doc, op, skipped, clouds, ref revisionId, ref sequence, ref issued);
                                done.Add(row);
                                if (row.Value<bool?>("ok") == true) changed++;
                            }
                            catch (Exception ex)
                            {
                                hard = true;
                                done.Add(new JObject { ["op"] = op.Value<string>("op") ?? "", ["ok"] = false, ["error"] = ex.Message });
                                break;
                            }
                        }
                        if (hard) transaction.RollBack();
                        else transaction.Commit();
                    }
                    Result["ok"] = !hard;
                    Result["applied"] = !hard && changed > 0;
                    Result["rolled_back"] = hard;
                    Result["saved"] = false;
                    Result["synced"] = false;
                    Result["ops"] = done;
                    Result["skipped"] = skipped;
                    Result["clouds"] = hard ? new JArray() : clouds;
                    Result["revision_id"] = hard ? "" : revisionId;
                    Result["sequence"] = hard ? 0 : sequence;
                    Result["issued"] = hard ? false : issued;
                    Result["read_only"] = false;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = false;
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

        private static JObject ApplyOne(Document doc, JObject op, JArray skipped, JArray clouds, ref string revisionId, ref int sequence, ref bool issued)
        {
            string name = (op.Value<string>("op") ?? "").Trim();
            var ids = Ids(op);
            var kept = new List<ElementId>();
            var held = new JArray();
            if (ids.Count > 0) FmcCheckout.Partition(doc, ids, kept, held);
            foreach (JToken row in held) skipped.Add(row);
            if (ids.Count > 0 && kept.Count == 0) return new JObject { ["op"] = name, ["ok"] = false, ["skipped"] = held };
            switch (name)
            {
                case "set_created":
                    Each(doc, kept, element => element.CreatedPhaseId = PhaseId(doc, op.Value<string>("phase_id")));
                    return new JObject { ["op"] = name, ["ok"] = true, ["count"] = kept.Count };
                case "set_demolished":
                    Each(doc, kept, element => element.DemolishedPhaseId = PhaseId(doc, op.Value<string>("phase_id")));
                    return new JObject { ["op"] = name, ["ok"] = true, ["count"] = kept.Count };
                case "clear_demolished":
                    Each(doc, kept, element => element.DemolishedPhaseId = ElementId.InvalidElementId);
                    return new JObject { ["op"] = name, ["ok"] = true, ["count"] = kept.Count };
                case "set_view":
                    ElementId phase = PhaseId(doc, op.Value<string>("phase_id"));
                    ElementId filter = string.IsNullOrWhiteSpace(op.Value<string>("filter_id")) ? null : new ElementId(long.Parse(op.Value<string>("filter_id")));
                    foreach (ElementId id in kept)
                    {
                        if (doc.GetElement(id) is not View view) continue;
                        Parameter phaseParameter = view.get_Parameter(BuiltInParameter.VIEW_PHASE);
                        if (phaseParameter != null && !phaseParameter.IsReadOnly) phaseParameter.Set(phase);
                        if (filter != null)
                        {
                            Parameter filterParameter = view.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER);
                            if (filterParameter != null && !filterParameter.IsReadOnly) filterParameter.Set(filter);
                        }
                    }
                    return new JObject { ["op"] = name, ["ok"] = true, ["count"] = kept.Count };
                case "revision_open":
                {
                    Revision revision = OpenRevision(doc, op);
                    revisionId = revision.Id.Value.ToString();
                    sequence = revision.SequenceNumber;
                    issued = revision.Issued;
                    return new JObject { ["op"] = name, ["ok"] = true, ["revision_id"] = revisionId, ["sequence"] = sequence };
                }
                case "cloud":
                {
                    Revision revision = RevisionOf(doc, op.Value<string>("revision_id"));
                    if (revision.Issued) throw new InvalidOperationException("[FMC-PHASE-ISSUED] That revision is issued.");
                    if (kept.Count == 0) throw new InvalidOperationException("[FMC-PHASE-VIEW] The view is not in this document.");
                    View view = doc.GetElement(kept[0]) as View ?? throw new InvalidOperationException("[FMC-PHASE-VIEW] The cloud view is not a view.");
                    RevisionCloud cloud = Cloud(doc, view, revision.Id, op);
                    clouds.Add(new JObject
                    {
                        ["id"] = cloud.Id.Value.ToString(),
                        ["view_id"] = view.Id.Value.ToString(),
                        ["sheet_id"] = string.IsNullOrWhiteSpace(op.Value<string>("sheet_id"))
                            ? (view is ViewSheet ? view.Id.Value.ToString() : "")
                            : op.Value<string>("sheet_id"),
                    });
                    revisionId = revision.Id.Value.ToString();
                    sequence = revision.SequenceNumber;
                    return new JObject { ["op"] = name, ["ok"] = true, ["cloud"] = cloud.Id.Value.ToString() };
                }
                case "issue":
                {
                    Revision revision = string.IsNullOrWhiteSpace(op.Value<string>("revision_id")) ? OpenRevision(doc, op) : RevisionOf(doc, op.Value<string>("revision_id"));
                    int sheets = 0;
                    foreach (ElementId id in kept)
                    {
                        if (doc.GetElement(id) is not ViewSheet sheet) continue;
                        var extra = new List<ElementId>(sheet.GetAdditionalRevisionIds());
                        if (extra.All(item => item.Value != revision.Id.Value)) extra.Add(revision.Id);
                        sheet.SetAdditionalRevisionIds(extra);
                        sheets++;
                    }
                    bool mark = op.Value<bool?>("mark_issued") == true && ChecksPass(doc, kept, op);
                    if (mark) revision.Issued = true;
                    revisionId = revision.Id.Value.ToString();
                    sequence = revision.SequenceNumber;
                    issued = revision.Issued;
                    return new JObject { ["op"] = name, ["ok"] = true, ["revision_id"] = revisionId, ["sheets"] = sheets, ["issued"] = revision.Issued };
                }
                case "unissue":
                {
                    Revision revision = RevisionOf(doc, op.Value<string>("revision_id"));
                    revision.Issued = false;
                    revisionId = revision.Id.Value.ToString();
                    sequence = revision.SequenceNumber;
                    issued = false;
                    return new JObject { ["op"] = name, ["ok"] = true, ["revision_id"] = revisionId };
                }
                default:
                    throw new InvalidOperationException("Unknown phase operation " + name);
            }
        }

        private static void Each(Document doc, List<ElementId> ids, Action<Element> edit)
        {
            foreach (ElementId id in ids)
            {
                Element element = doc.GetElement(id) ?? throw new InvalidOperationException("[FMC-PHASE] Element " + id.Value + " is not in this document.");
                edit(element);
            }
        }

        private static ElementId PhaseId(Document doc, string id)
        {
            if (!long.TryParse(id, out long value) || value <= 0) throw new InvalidOperationException("[FMC-PHASE-UNKNOWN] A phase id is missing.");
            if (doc.GetElement(new ElementId(value)) is not Phase) throw new InvalidOperationException("[FMC-PHASE-UNKNOWN] Phase " + id + " is not in this document.");
            return new ElementId(value);
        }

        private static Revision OpenRevision(Document doc, JObject op)
        {
            if (!string.IsNullOrWhiteSpace(op.Value<string>("revision_id"))) return RevisionOf(doc, op.Value<string>("revision_id"));
            Revision revision = Revision.Create(doc);
            string description = op.Value<string>("description");
            if (!string.IsNullOrWhiteSpace(description)) revision.Description = description;
            string date = op.Value<string>("date");
            if (!string.IsNullOrWhiteSpace(date)) revision.RevisionDate = date;
            revision.Issued = false;
            return revision;
        }

        private static Revision RevisionOf(Document doc, string id)
        {
            if (!long.TryParse(id, out long value)) throw new InvalidOperationException("[FMC-PHASE-REVISION] No revision " + id + ".");
            return doc.GetElement(new ElementId(value)) as Revision ?? throw new InvalidOperationException("[FMC-PHASE-REVISION] No revision " + id + ".");
        }

        private static RevisionCloud Cloud(Document doc, View view, ElementId revisionId, JObject op)
        {
            double minU = (op.Value<double?>("min_u_mm") ?? 0) / 304.8;
            double minV = (op.Value<double?>("min_v_mm") ?? 0) / 304.8;
            double maxU = (op.Value<double?>("max_u_mm") ?? 0) / 304.8;
            double maxV = (op.Value<double?>("max_v_mm") ?? 0) / 304.8;
            if (maxU - minU < 1e-6) maxU = minU + (300 / 304.8);
            if (maxV - minV < 1e-6) maxV = minV + (300 / 304.8);
            XYZ origin = view.Origin, right = view.RightDirection, up = view.UpDirection;
            XYZ At(double u, double v) => origin + right * u + up * v;
            var corners = new[] { At(minU, minV), At(maxU, minV), At(maxU, maxV), At(minU, maxV) };
            var curves = new List<Curve>();
            for (int i = 0; i < 4; i++) curves.Add(Line.CreateBound(corners[i], corners[(i + 1) % 4]));
            return RevisionCloud.Create(doc, view, revisionId, curves);
        }

        private static bool ChecksPass(Document doc, List<ElementId> sheetIds, JObject op)
        {
            var names = FmcPhaseIds.Strings(op["titleblock_params"] as JArray);
            bool needSchedule = op.Value<bool?>("schedule_required") != false;
            if (sheetIds.Count == 0) return false;
            foreach (ElementId id in sheetIds)
            {
                if (doc.GetElement(id) is not ViewSheet sheet) return false;
                foreach (string name in names)
                {
                    bool seen = false;
                    foreach (FamilyInstance title in new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().Cast<FamilyInstance>())
                    {
                        Parameter parameter = title.LookupParameter(name);
                        if (parameter == null) continue;
                        seen = true;
                        string value = parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
                        if (string.IsNullOrWhiteSpace(value)) return false;
                    }
                    if (!seen) return false;
                }
                if (needSchedule && !HasSchedule(doc, sheet)) return false;
            }
            return true;
        }

        private static bool HasSchedule(Document doc, ViewSheet sheet)
        {
            foreach (ScheduleSheetInstance instance in new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>())
            {
                if (doc.GetElement(instance.ScheduleId) is not ViewSchedule schedule) continue;
                if (schedule.Definition?.CategoryId != null && schedule.Definition.CategoryId.Value == (long)BuiltInCategory.OST_Revisions) return true;
            }
            return false;
        }

        private static List<ElementId> Ids(JObject op)
        {
            var list = new List<ElementId>();
            if (op["ids"] is JArray array)
            {
                foreach (long id in FmcPhaseIds.Longs(array)) list.Add(new ElementId(id));
            }
            return list.GroupBy(id => id.Value).Select(group => group.First()).ToList();
        }
    }
}
