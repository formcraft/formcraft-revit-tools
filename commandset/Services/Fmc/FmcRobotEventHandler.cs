using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Track R (Robot) on the Revit main thread. export (read-only): every column and beam with an analytical member,
    /// its ends in mm, its type, b and h, material and the kit's grades, for the Robot connector. write: the analysis
    /// results the engineer brought back, into the kit's FMC_FEA_NEd_kN, FMC_FEA_MEd_kNm and FMC_FEA_Run_Ref, as one
    /// Undo; a dry run lists them first. FMC_FEA_Approval_Ref is the engineer's signature and is never written, and no
    /// section, load or size is ever changed (rule 5).
    /// </summary>
    public class FmcRobotEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public string GetName() => "FMC Robot";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: Action == "export");
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("The analytical model lives in a project model.");
                Result = Action switch
                {
                    "export" => Export(doc),
                    "write" => Write(doc, Parameters),
                    _ => throw new ArgumentException($"Unknown FMC Robot action '{Action}'"),
                };
                Result["model"] = doc.Title;
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        private static string Text(Element e, string name)
        {
            Parameter p = e?.LookupParameter(name);
            if (p == null || !p.HasValue) return "";
            return (p.StorageType == StorageType.String ? p.AsString() : p.AsValueString())?.Trim() ?? "";
        }

        private static double Mm(Element e, params string[] names)
        {
            foreach (string n in names)
            {
                Parameter p = e?.LookupParameter(n);
                if (p != null && p.HasValue && p.StorageType == StorageType.Double) return Math.Round(p.AsDouble() * FeetToMm, 1);
            }
            return 0;
        }

        private static JObject Export(Document doc)
        {
            var assoc = AnalyticalToPhysicalAssociationManager.GetAnalyticalToPhysicalAssociationManager(doc);
            var cats = new List<BuiltInCategory> { BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_StructuralFraming };
            var members = new JArray();
            int without = 0;
            var withoutIds = new JArray(); // RB-12: which members, first 50
            foreach (FamilyInstance m in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats))
                         .WhereElementIsNotElementType().OfType<FamilyInstance>())
            {
                ElementId aId = assoc?.GetAssociatedElementId(m.Id) ?? ElementId.InvalidElementId;
                if (!(doc.GetElement(aId) is AnalyticalMember am) || am.GetCurve() is not Curve c) { without++; if (withoutIds.Count < 50) withoutIds.Add(m.Id.Value); continue; }
                XYZ a = c.GetEndPoint(0), b = c.GetEndPoint(1);
                FamilySymbol type = m.Symbol;
                string material = "";
                try { material = m.StructuralMaterialType.ToString(); } catch (Exception) { /* unknown */ }
                bool column = m.Category.Id.Value == (long)BuiltInCategory.OST_StructuralColumns;
                members.Add(new JObject
                {
                    ["id"] = m.Id.Value,
                    ["unique_id"] = m.UniqueId, // the hub's identity map keeps Revit elements by UniqueId (it survives sessions)
                    ["kind"] = column ? "column" : "beam",
                    ["start"] = new JArray(Math.Round(a.X * FeetToMm, 1), Math.Round(a.Y * FeetToMm, 1), Math.Round(a.Z * FeetToMm, 1)),
                    ["end"] = new JArray(Math.Round(b.X * FeetToMm, 1), Math.Round(b.Y * FeetToMm, 1), Math.Round(b.Z * FeetToMm, 1)),
                    ["family"] = type?.FamilyName ?? "",
                    ["section"] = type?.Name ?? "",
                    ["b_mm"] = Mm(type, "b", "Width", "B") is double bw && bw > 0 ? bw : Mm(m, "b", "Width"),
                    ["h_mm"] = Mm(type, "h", "Depth", "H", "Height") is double hh && hh > 0 ? hh : Mm(m, "h", "Depth"),
                    ["material_class"] = material,
                    ["concrete_grade"] = Text(type, "FMC_Concrete_Grade"),
                    ["steel_grade"] = Text(type, "FMC_Steel_Grade"),
                    ["mark"] = Text(m, "FMC_Member_Mark") is string mk && mk.Length > 0 ? mk : Text(m, "Mark"),
                });
            }
            return new JObject { ["members"] = members, ["without_analytical"] = without, ["without_analytical_ids"] = withoutIds,
                ["categories"] = new JArray("Structural Columns", "Structural Framing") };
        }

        private static readonly string[] Writable = { "FMC_FEA_NEd_kN", "FMC_FEA_MEd_kNm", "FMC_FEA_Run_Ref" };

        private static JObject Write(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") != false;
            var rows = new JArray();
            int set = 0, notSet = 0;
            var missing = new HashSet<string>();
            // RB-7: preflight. Every member must carry all three parameters (writable) or nothing is written: no NEd without MEd or Run_Ref.
            var lacking = new JArray();
            foreach (JObject r in (p["results"] as JArray ?? new JArray()).OfType<JObject>())
            {
                Element e = doc.GetElement(FmcCompatId(r.Value<long>("id")));
                if (e == null) continue;
                var names = Writable.Where(n => { Parameter q = e.LookupParameter(n); return q == null || q.IsReadOnly; }).ToList();
                if (names.Count == 0) continue;
                foreach (string n in names) missing.Add(n);
                if (lacking.Count < 50) lacking.Add(new JObject { ["id"] = e.Id.Value, ["missing_parameters"] = new JArray(names) });
            }
            if (lacking.Count > 0)
                return new JObject { ["dry_run"] = dry, ["refused"] = !dry, ["can_write"] = false, ["values_set"] = 0,
                    ["missing_parameters"] = new JArray(missing.OrderBy(x => x)), ["members_missing"] = lacking,
                    ["not_in_model"] = new JArray(missing.OrderBy(x => x)),
                    ["message"] = "Some members lack FMC_FEA_NEd_kN, FMC_FEA_MEd_kNm or FMC_FEA_Run_Ref (or it is read-only). Nothing is written until every member has all three: load the kit's FEA parameters.",
                    ["never_written"] = "FMC_FEA_Approval_Ref (the engineer's)" };
            using (var t = new Transaction(doc, "Formcraft: Robot results"))
            {
                if (!dry) t.Start();
                foreach (JObject r in (p["results"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    Element e = doc.GetElement(FmcCompatId(r.Value<long>("id")));
                    if (e == null) { rows.Add(new JObject { ["id"] = r["id"], ["result"] = "not in this model" }); continue; }
                    var values = new Dictionary<string, JToken> { ["FMC_FEA_NEd_kN"] = r["ned_kn"], ["FMC_FEA_MEd_kNm"] = r["med_knm"], ["FMC_FEA_Run_Ref"] = r["run"] };
                    var before = new JObject();
                    foreach (var kv in values)
                    {
                        if (!Writable.Contains(kv.Key) || kv.Value == null) continue;
                        Parameter par = e.LookupParameter(kv.Key);
                        if (par == null || par.IsReadOnly) { missing.Add(kv.Key); continue; }
                        before[kv.Key] = par.StorageType == StorageType.String ? par.AsString() : par.AsValueString();
                        if (dry) continue;
                        bool ok = false;
                        if (par.StorageType == StorageType.String) ok = par.Set(kv.Value.ToString());
                        else if (par.StorageType == StorageType.Double) ok = par.Set(kv.Value.Value<double>());
                        else if (par.StorageType == StorageType.Integer) ok = par.Set((int)Math.Round(kv.Value.Value<double>()));
                        if (ok) set++; else notSet++;
                    }
                    rows.Add(new JObject { ["id"] = r["id"], ["before"] = before, ["after"] = new JObject { ["FMC_FEA_NEd_kN"] = r["ned_kn"], ["FMC_FEA_MEd_kNm"] = r["med_knm"], ["FMC_FEA_Run_Ref"] = r["run"] } });
                }
                if (!dry) t.Commit();
            }
            return new JObject { ["dry_run"] = dry, ["rows"] = rows, ["values_set"] = set, ["values_not_set"] = notSet, ["can_write"] = true,
                ["missing_parameters"] = new JArray(missing.OrderBy(x => x)), ["not_in_model"] = new JArray(missing.OrderBy(x => x)), ["never_written"] = "FMC_FEA_Approval_Ref (the engineer's)" };
        }

        private static ElementId FmcCompatId(long v) => new ElementId(v);
    }
}
