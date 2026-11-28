using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_schedule_data (GAP-06): a schedule's fields and rows by element id, and edited marks, comments and key-schedule
    /// values written back. Calculated, formula, percentage, count, combined and read-only fields are never written.
    /// The server (server/src/fmc/schedule_data.ts) makes the diff; this side checks every cell again before it writes.
    /// </summary>
    public static class FmcScheduleDataCore
    {
        /// <summary>Marks and comments: the only fields written outside a key schedule.</summary>
        public static readonly HashSet<string> MarkComment = new HashSet<string>
        {
            "ALL_MODEL_MARK", "ALL_MODEL_TYPE_MARK", "ALL_MODEL_INSTANCE_COMMENTS", "ALL_MODEL_TYPE_COMMENTS",
        };

        public static ViewSchedule Find(Document doc, string key)
        {
            key = (key ?? "").Trim();
            if (long.TryParse(key, out _) && doc.GetElement(FmcExtStoreSchema.ToId(key)) is ViewSchedule byId) return byId;
            return new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                .FirstOrDefault(v => !v.IsTemplate && string.Equals(v.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        public static string Kind(ScheduleField f)
        {
            if (f.FieldType == ScheduleFieldType.Formula) return "formula";
            if (f.FieldType == ScheduleFieldType.Percentage) return "percentage";
            if (f.IsCalculatedField) return "calculated";
            if (f.FieldType == ScheduleFieldType.Count) return "count";
#if REVIT2022_OR_GREATER
            if (f.IsCombinedParameterField) return "combined";
#endif
            if (f.ParameterId == null || f.ParameterId == ElementId.InvalidElementId) return "other";
            return "parameter";
        }

        public static string Builtin(ScheduleField f)
        {
            if (f.ParameterId == null || f.ParameterId == ElementId.InvalidElementId) return "";
            long v = f.ParameterId.GetValue();
            if (v >= 0) return "";
            var bip = (BuiltInParameter)(int)v;
            return Enum.IsDefined(typeof(BuiltInParameter), bip) ? bip.ToString() : "";
        }

        public static bool TypeParam(ScheduleField f) => f.FieldType == ScheduleFieldType.ElementType;

        /// <summary>The parameter the field shows on this element (its type's for a type field).</summary>
        public static Parameter Param(Document doc, Element e, ScheduleField f)
        {
            Element host = e;
            if (TypeParam(f))
            {
                ElementId t = e.GetTypeId();
                host = t == null || t == ElementId.InvalidElementId ? null : doc.GetElement(t);
            }
            if (host == null || f.ParameterId == null || f.ParameterId == ElementId.InvalidElementId) return null;
            long v = f.ParameterId.GetValue();
            if (v < 0) return host.get_Parameter((BuiltInParameter)(int)v);
            return doc.GetElement(f.ParameterId) is ParameterElement pe ? host.get_Parameter(pe.GetDefinition()) : null;
        }

        public static string Text(Parameter p)
        {
            if (p == null || !p.HasValue) return "";
            return p.StorageType == StorageType.String ? (p.AsString() ?? "") : (p.AsValueString() ?? "");
        }

        public static List<ScheduleField> Fields(ViewSchedule vs)
        {
            ScheduleDefinition def = vs.Definition;
            var list = new List<ScheduleField>();
            for (int i = 0; i < def.GetFieldCount(); i++) list.Add(def.GetField(i));
            return list;
        }

        /// <summary>Why a field can't be written ("" when it can).</summary>
        public static string WhyNot(ScheduleField f, bool isKey)
        {
            string kind = Kind(f);
            if (kind != "parameter") return f.GetName() + " is a " + kind + " field";
            if (!isKey && !MarkComment.Contains(Builtin(f))) return f.GetName() + ": only marks, comments and key-schedule values are written";
            return "";
        }
    }

    /// <summary>A schedule's fields and rows (one per element). No transaction.</summary>
    public class FmcScheduleDataReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft schedule data read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_schedule_data needs document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    ViewSchedule vs = FmcScheduleDataCore.Find(doc, Parameters.Value<string>("schedule"))
                        ?? throw new InvalidOperationException("[FMC-SCHEDULE-NOT-FOUND] No schedule by that name or id.");
                    bool isKey = vs.Definition.IsKeySchedule;
                    int limit = Math.Max(1, Parameters.Value<int?>("limit") ?? 10000);
                    List<ScheduleField> fields = FmcScheduleDataCore.Fields(vs);
                    var readOnly = new bool[fields.Count];
                    var rows = new JArray();
                    bool truncated = false;
                    foreach (Element e in new FilteredElementCollector(doc, vs.Id).WhereElementIsNotElementType())
                    {
                        if (rows.Count >= limit) { truncated = true; break; }
                        var values = new JObject();
                        for (int i = 0; i < fields.Count; i++)
                        {
                            ScheduleField f = fields[i];
                            Parameter p = FmcScheduleDataCore.Kind(f) == "parameter" ? FmcScheduleDataCore.Param(doc, e, f) : null;
                            if (p != null && p.IsReadOnly) readOnly[i] = true;
                            values[f.GetName()] = p != null ? FmcScheduleDataCore.Text(p) : "";
                        }
                        var row = new JObject { ["id"] = e.Id.GetValue().ToString(), ["values"] = values };
                        ElementId t = e.GetTypeId();
                        if (t != null && t != ElementId.InvalidElementId) row["type_id"] = t.GetValue().ToString();
                        FmcExtStoreSchema.Checkout(doc, e.Id, row);
                        rows.Add(row);
                    }
                    var fieldRows = new JArray();
                    for (int i = 0; i < fields.Count; i++)
                    {
                        ScheduleField f = fields[i];
                        fieldRows.Add(new JObject
                        {
                            ["name"] = f.GetName(),
                            ["heading"] = f.ColumnHeading ?? "",
                            ["kind"] = FmcScheduleDataCore.Kind(f),
                            ["builtin"] = FmcScheduleDataCore.Builtin(f),
                            ["type_param"] = FmcScheduleDataCore.TypeParam(f),
                            ["read_only"] = readOnly[i],
                            ["hidden"] = f.IsHidden,
                        });
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["schedule"] = vs.Name ?? "",
                        ["schedule_id"] = vs.Id.GetValue().ToString(),
                        ["is_key"] = isKey,
                        ["fields"] = fieldRows,
                        ["rows"] = rows,
                        ["truncated"] = truncated,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>Edited schedule cells written back in one transaction. Every cell is checked again here.</summary>
    public class FmcScheduleDataApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft schedule data apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_schedule_data needs document.");
                if ((Parameters.Value<string>("batch_lease") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-BATCH-LOCKED] fmc_schedule_data writes only under a batch lease.");
                bool dry = Parameters.Value<bool?>("dry_run") == true;
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsReadOnly) throw new InvalidOperationException("[FMC-SCHEDULE-READONLY] The document is read-only.");
                    ViewSchedule vs = doc.GetElement(FmcExtStoreSchema.ToId(Parameters.Value<string>("schedule_id"))) as ViewSchedule
                        ?? throw new InvalidOperationException("[FMC-SCHEDULE-NOT-FOUND] The schedule id is not a schedule.");
                    bool isKey = vs.Definition.IsKeySchedule;
                    Dictionary<string, ScheduleField> byName = FmcScheduleDataCore.Fields(vs)
                        .GroupBy(f => f.GetName()).ToDictionary(g => g.Key, g => g.First());
                    var inSchedule = new HashSet<long>(new FilteredElementCollector(doc, vs.Id).WhereElementIsNotElementType().ToElementIds().Select(i => i.GetValue()));
                    var written = new JArray();
                    var skipped = new JArray();
                    using (var tx = new Transaction(doc, "Formcraft: schedule data"))
                    {
                        tx.Start();
                        foreach (JObject c in ((Parameters["changes"] as JArray) ?? new JArray()).OfType<JObject>())
                        {
                            string id = c.Value<string>("id") ?? "";
                            string field = c.Value<string>("field") ?? "";
                            string to = c.Value<string>("to") ?? "";
                            JObject skip(string reason) => new JObject { ["id"] = id, ["field"] = field, ["reason"] = reason };
                            Element e = doc.GetElement(FmcExtStoreSchema.ToId(id));
                            if (e == null || !inSchedule.Contains(e.Id.GetValue())) { skipped.Add(skip("not in the schedule")); continue; }
                            if (!byName.TryGetValue(field, out ScheduleField f)) { skipped.Add(skip("no such field")); continue; }
                            string why = FmcScheduleDataCore.WhyNot(f, isKey);
                            if (why.Length > 0) { skipped.Add(skip(why)); continue; }
                            Parameter p = FmcScheduleDataCore.Param(doc, e, f);
                            if (p == null) { skipped.Add(skip("the element has no such parameter")); continue; }
                            if (p.IsReadOnly) { skipped.Add(skip("read-only")); continue; }
                            Element owner = p.Element ?? e;
                            if (doc.IsWorkshared && WorksharingUtils.GetCheckoutStatus(doc, owner.Id, out string user) == CheckoutStatus.OwnedByOtherUser)
                            { skipped.Add(skip("owned by " + user)); continue; }
                            bool ok;
                            switch (p.StorageType)
                            {
                                case StorageType.String: ok = p.Set(to); break;
                                case StorageType.Integer:
                                case StorageType.Double: ok = p.SetValueString(to); break;
                                default: ok = false; break;
                            }
                            if (!ok) { skipped.Add(skip("Revit did not accept the value")); continue; }
                            written.Add(new JObject { ["id"] = id, ["field"] = field, ["to"] = to });
                        }
                        if (dry) tx.RollBack(); else tx.Commit();
                    }
                    Result = new JObject
                    {
                        ["dry_run"] = dry,
                        ["rolled_back"] = dry,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["schedule"] = vs.Name ?? "",
                        ["written"] = written.Count,
                        ["written_cells"] = written,
                        ["skipped"] = skipped,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
