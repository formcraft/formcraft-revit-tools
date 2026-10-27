using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The one way to pick elements (owner 27 Oct: "the depth of the section box, to every feature"). select_by,
    /// see_view and every modify_model op ("select" in place of ids, or {select} in place of one id) use it. All
    /// filters combine (and); any of them may be left out:
    /// <para>ids (start from these), category (name or OST_, or a list), level, type_name and family (part of the name),
    /// comment (contains), mark, workset, phase, view (visible in it), room (inside that room: id, number or name),
    /// box (a section-box spec, see FmcBox: elements touching it, inside true: wholly in it), box_mm, near {id |
    /// point_mm, within_mm}, hosted_by (an id: doors and windows in that wall...), host_of (an id: the host of that
    /// element), param {name, is: equals|contains|starts|gt|lt|empty|not_empty, value} (or a list), exclude (ids),
    /// not (another select: those are left out), types true (element types instead of instances), limit (default 5000:
    /// more is refused, so a too-wide query never edits the whole model by accident).</para>
    /// </summary>
    internal static class FmcSelect
    {
        private static bool Has(string v, string want) => v != null && v.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0;
        private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        private static double Ft(double mm) => mm / 304.8;

        public static List<Element> Find(Document doc, JObject p, Func<JToken, ElementId> id = null, View active = null)
        {
            id = id ?? (t => FmcBox.Id(doc, t));
            View view = p["view"] != null ? (Same(p.Value<string>("view"), "active") && active != null ? active : FmcViewImageHandler.ViewOf(doc, p.Value<string>("view"))) : null;
            IEnumerable<Element> q;
            if (p["ids"] is JArray start && start.Count > 0) q = start.Select(t => doc.GetElement(id(t))).Where(e => e != null).ToList();
            else
            {
                var col = view != null ? new FilteredElementCollector(doc, view.Id) : new FilteredElementCollector(doc);
                bool types = p.Value<bool?>("types") == true;
                q = (types ? col.WhereElementIsElementType() : col.WhereElementIsNotElementType())
                    .Where(e => e.Category != null && (types || e.Category.CategoryType == CategoryType.Model || e is Room || e is SpatialElement || e.ViewSpecific && view != null));
            }
            if (p["category"] != null)
            {
                var cats = (p["category"] is JArray ca ? ca.Select(x => x.ToString()) : new[] { p.Value<string>("category") }).ToList();
                q = q.Where(e => e.Category != null && cats.Any(c => Same(e.Category.Name, c) || Same(e.Category.BuiltInCategory.ToString(), c) || Same(e.Category.BuiltInCategory.ToString(), "OST_" + c)));
            }
            if (p["level"] != null)
            {
                string l = p.Value<string>("level");
                q = q.Where(e => Same(doc.GetElement(e.LevelId)?.Name, l) || Same(doc.GetElement(e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId() ?? ElementId.InvalidElementId)?.Name, l)
                    || Same(doc.GetElement(e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)?.AsElementId() ?? ElementId.InvalidElementId)?.Name, l));
            }
            if (p["type_name"] != null) q = q.Where(e => Has(e is ElementType ? e.Name : doc.GetElement(e.GetTypeId())?.Name, p.Value<string>("type_name")));
            if (p["family"] != null) q = q.Where(e => Has((e as ElementType ?? doc.GetElement(e.GetTypeId()) as ElementType)?.FamilyName, p.Value<string>("family")));
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
            if (p["room"] != null)
            {
                Room r = FmcBox.RoomOf(doc, p["room"]);
                q = q.Where(e => e.Id != r.Id && InRoom(r, e));
            }
            if (p["box_mm"] is JArray box)
            {
                // anything whose extent touches the box, so a stair whose foot lies outside it is still found
                var a = (JArray)box[0]; var b = (JArray)box[1];
                double F(JToken t) => t.Value<double>() / 304.8;
                var min = new XYZ(Math.Min(F(a[0]), F(b[0])), Math.Min(F(a[1]), F(b[1])), a.Count > 2 ? Math.Min(F(a[2]), F(b[2])) : -1e6);
                var max = new XYZ(Math.Max(F(a[0]), F(b[0])), Math.Max(F(a[1]), F(b[1])), a.Count > 2 ? Math.Max(F(a[2]), F(b[2])) : 1e6);
                q = q.Where(e => e.get_BoundingBox(null) is BoundingBoxXYZ bb && bb.Max.X >= min.X && bb.Min.X <= max.X && bb.Max.Y >= min.Y && bb.Min.Y <= max.Y && bb.Max.Z >= min.Z && bb.Min.Z <= max.Z);
            }
            if (p["box"] is JObject spec)
            {
                // a section-box spec (turned boxes too): each element's extent against the box, in the box's own frame
                BoundingBoxXYZ bx = FmcBox.Resolve(doc, spec, id, null, out _);
                Transform inv = bx.Transform.Inverse;
                bool inside = spec.Value<bool?>("inside") == true;
                q = q.Where(e =>
                {
                    if (!(e.get_BoundingBox(null) is BoundingBoxXYZ bb)) return false;
                    var c = FmcBox.Corners(bb).Select(inv.OfPoint).ToList();
                    double x0 = c.Min(v => v.X), x1 = c.Max(v => v.X), y0 = c.Min(v => v.Y), y1 = c.Max(v => v.Y), z0 = c.Min(v => v.Z), z1 = c.Max(v => v.Z);
                    return inside ? x0 >= bx.Min.X && x1 <= bx.Max.X && y0 >= bx.Min.Y && y1 <= bx.Max.Y && z0 >= bx.Min.Z && z1 <= bx.Max.Z
                        : x1 >= bx.Min.X && x0 <= bx.Max.X && y1 >= bx.Min.Y && y0 <= bx.Max.Y && z1 >= bx.Min.Z && z0 <= bx.Max.Z;
                });
            }
            if (p["near"] is JObject near)
            {
                XYZ at = near["point_mm"] is JArray pt ? new XYZ(Ft(pt[0].Value<double>()), Ft(pt[1].Value<double>()), pt.Count > 2 ? Ft(pt[2].Value<double>()) : 0)
                    : Centre(doc.GetElement(id(near["id"] ?? throw new InvalidOperationException("near needs id or point_mm"))));
                double within = Ft(near.Value<double?>("within_mm") ?? 1000);
                bool flat = near["point_mm"] is JArray p2 && p2.Count < 3;
                q = q.Where(e => e.get_BoundingBox(null) is BoundingBoxXYZ bb && Gap(bb, at, flat) <= within);
            }
            if (p["hosted_by"] != null)
            {
                ElementId h = id(p["hosted_by"]);
                q = q.Where(e => (e as FamilyInstance)?.Host?.Id == h || (e is FamilyInstance fi && fi.SuperComponent?.Id == h));
            }
            if (p["host_of"] != null)
            {
                Element child = doc.GetElement(id(p["host_of"]));
                ElementId h = (child as FamilyInstance)?.Host?.Id ?? ElementId.InvalidElementId;
                q = q.Where(e => e.Id == h);
            }
            foreach (JObject rule in p["param"] is JArray pa ? pa.OfType<JObject>() : p["param"] is JObject po ? new[] { po } : Enumerable.Empty<JObject>())
                q = q.Where(e => Matches(doc, e, rule));
            if (p["exclude"] is JArray ex)
            {
                var skip = new HashSet<long>(ex.Select(t => id(t).Value));
                q = q.Where(e => !skip.Contains(e.Id.Value));
            }
            var all = q.ToList();
            if (p["not"] is JObject not)
            {
                var skip = new HashSet<long>(Find(doc, not, id, active).Select(e => e.Id.Value));
                all = all.Where(e => !skip.Contains(e.Id.Value)).ToList();
            }
            return all;
        }

        /// <summary>Find, for an edit: refuses more than limit (default 5000) and none at all.</summary>
        public static List<ElementId> ForEdit(Document doc, JObject p, Func<JToken, ElementId> id, View active, string what)
        {
            var found = Find(doc, p, id, active);
            int limit = p.Value<int?>("limit") ?? 5000;
            if (found.Count == 0) throw new InvalidOperationException($"{what}: the select found nothing ({string.Join(", ", p.Properties().Select(x => x.Name))})");
            if (found.Count > limit) throw new InvalidOperationException($"{what}: the select found {found.Count} elements, over its limit {limit}: narrow it or raise limit");
            return found.Select(e => e.Id).ToList();
        }

        public static XYZ Centre(Element e)
        {
            if (e?.Location is LocationPoint lp) return lp.Point;
            if (e?.Location is LocationCurve lc) return lc.Curve.Evaluate(0.5, true);
            var b = e?.get_BoundingBox(null) ?? throw new InvalidOperationException("that element has no place in the model");
            return (b.Min + b.Max) / 2;
        }

        private static double Gap(BoundingBoxXYZ b, XYZ p, bool flat)
        {
            double dx = Math.Max(0, Math.Max(b.Min.X - p.X, p.X - b.Max.X)), dy = Math.Max(0, Math.Max(b.Min.Y - p.Y, p.Y - b.Max.Y));
            double dz = flat ? 0 : Math.Max(0, Math.Max(b.Min.Z - p.Z, p.Z - b.Max.Z));
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        private static bool InRoom(Room r, Element e)
        {
            try
            {
                if (e is FamilyInstance fi && (fi.Room?.Id == r.Id || fi.FromRoom?.Id == r.Id || fi.ToRoom?.Id == r.Id)) return true;
                XYZ c = Centre(e);
                double z = (r.Level?.Elevation ?? c.Z) + 1.0;
                return r.IsPointInRoom(new XYZ(c.X, c.Y, Math.Max(c.Z, z))) || r.IsPointInRoom(new XYZ(c.X, c.Y, z));
            }
            catch (Exception) { return false; }
        }

        private static bool Matches(Document doc, Element e, JObject rule)
        {
            string name = rule.Value<string>("name") ?? throw new InvalidOperationException("param needs name");
            Parameter prm = e.LookupParameter(name) ?? doc.GetElement(e.GetTypeId())?.LookupParameter(name);
            string how = rule.Value<string>("is") ?? "equals";
            if (how == "empty") return prm == null || !prm.HasValue || string.IsNullOrEmpty(prm.AsValueString() ?? prm.AsString());
            if (how == "not_empty") return prm != null && prm.HasValue && !string.IsNullOrEmpty(prm.AsValueString() ?? prm.AsString());
            if (prm == null) return false;
            JToken want = rule["value"];
            if (prm.StorageType == StorageType.Double || prm.StorageType == StorageType.Integer)
            {
                double v = prm.StorageType == StorageType.Integer ? prm.AsInteger() : prm.AsDouble();
                // lengths are compared in mm (the value given), other numbers as they are
                bool length = prm.StorageType == StorageType.Double && prm.Definition.GetDataType() == SpecTypeId.Length;
                if (length) v *= 304.8;
                double w = want?.Type == JTokenType.Float || want?.Type == JTokenType.Integer ? want.Value<double>() : double.TryParse(want?.ToString(), out double d) ? d : double.NaN;
                if (!double.IsNaN(w))
                    return how == "gt" ? v > w : how == "lt" ? v < w : Math.Abs(v - w) < (length ? 0.5 : 1e-6);
            }
            string s = prm.StorageType == StorageType.ElementId ? doc.GetElement(prm.AsElementId())?.Name ?? prm.AsValueString() : prm.AsString() ?? prm.AsValueString();
            string ws = want?.ToString() ?? "";
            return how == "contains" ? Has(s, ws) : how == "starts" ? (s ?? "").StartsWith(ws, StringComparison.OrdinalIgnoreCase) : Same(s, ws);
        }
    }
}
