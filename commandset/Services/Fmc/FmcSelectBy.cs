using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_select_by (Ogala report: a region selection missed the old BQ stair): elements by category, level, type,
    /// family, comment, mark, workset, phase, a box or a view, read-only; ids with their category, type and level.
    /// </summary>
    public class FmcSelectByHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft select by";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Select(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private static bool Has(string v, string want) => v != null && v.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0;
        private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        private JObject Select(Document doc)
        {
            JObject p = Parameters;
            View view = p["view"] != null ? FmcViewImageHandler.ViewOf(doc, p.Value<string>("view")) : null;
            var col = view != null ? new FilteredElementCollector(doc, view.Id) : new FilteredElementCollector(doc);
            IEnumerable<Element> q = col.WhereElementIsNotElementType().Where(e => e.Category != null && (e.Category.CategoryType == CategoryType.Model || e is Room));
            if (p["category"] != null)
            {
                string c = p.Value<string>("category");
                q = q.Where(e => Same(e.Category.Name, c) || Same("OST_" + ((BuiltInCategory)e.Category.Id.Value).ToString().Replace("OST_", ""), c));
            }
            if (p["level"] != null)
            {
                string l = p.Value<string>("level");
                q = q.Where(e => Same(doc.GetElement(e.LevelId)?.Name, l) || Same(doc.GetElement(e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId() ?? ElementId.InvalidElementId)?.Name, l));
            }
            if (p["type_name"] != null) q = q.Where(e => Has(doc.GetElement(e.GetTypeId())?.Name, p.Value<string>("type_name")));
            if (p["family"] != null) q = q.Where(e => Has((doc.GetElement(e.GetTypeId()) as ElementType)?.FamilyName, p.Value<string>("family")));
            if (p["comment"] != null) q = q.Where(e => Has(e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString(), p.Value<string>("comment")));
            if (p["mark"] != null) q = q.Where(e => Same(e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString(), p.Value<string>("mark")));
            if (p["workset"] != null && doc.IsWorkshared)
            {
                Workset ws = new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).FirstOrDefault(w => Same(w.Name, p.Value<string>("workset")))
                    ?? throw new InvalidOperationException($"no workset {p.Value<string>("workset")}");
                q = q.Where(e => e.WorksetId == ws.Id);
            }
            if (p["phase"] != null)
                q = q.Where(e => Same(doc.GetElement(e.get_Parameter(BuiltInParameter.PHASE_CREATED)?.AsElementId() ?? ElementId.InvalidElementId)?.Name, p.Value<string>("phase")));
            if (p["box_mm"] is JArray box)
            {
                // anything whose extent touches the box, so a stair whose foot lies outside it is still found
                var a = (JArray)box[0]; var b = (JArray)box[1];
                double F(JToken t) => t.Value<double>() / 304.8;
                var min = new XYZ(Math.Min(F(a[0]), F(b[0])), Math.Min(F(a[1]), F(b[1])), a.Count > 2 ? Math.Min(F(a[2]), F(b[2])) : -1e6);
                var max = new XYZ(Math.Max(F(a[0]), F(b[0])), Math.Max(F(a[1]), F(b[1])), a.Count > 2 ? Math.Max(F(a[2]), F(b[2])) : 1e6);
                q = q.Where(e => e.get_BoundingBox(null) is BoundingBoxXYZ bb && bb.Max.X >= min.X && bb.Min.X <= max.X && bb.Max.Y >= min.Y && bb.Min.Y <= max.Y && bb.Max.Z >= min.Z && bb.Min.Z <= max.Z);
            }
            var all = q.ToList();
            int limit = p.Value<int?>("limit") ?? 500;
            return new JObject
            {
                ["count"] = all.Count,
                ["by_category"] = new JObject(all.GroupBy(e => e.Category.Name).OrderByDescending(g => g.Count()).Select(g => new JProperty(g.Key, g.Count()))),
                ["ids"] = new JArray(all.Take(limit).Select(e => e.Id.Value)),
                ["elements"] = new JArray(all.Take(Math.Min(limit, 100)).Select(e => new JObject
                {
                    ["id"] = e.Id.Value, ["category"] = e.Category.Name, ["type"] = doc.GetElement(e.GetTypeId())?.Name ?? e.Name, ["level"] = doc.GetElement(e.LevelId)?.Name ?? "",
                })),
            };
        }
    }
}
