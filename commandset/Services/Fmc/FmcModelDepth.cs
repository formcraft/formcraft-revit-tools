using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Depth for every op (owner 27 Oct: "the depth you gave the section box, give it to every feature to the max"):
    /// <list type="bullet">
    /// <item>select: any op that takes ids takes a select instead (or as well): FmcSelect's query (category, level,
    /// room, box, near, param, hosted_by, not...), run when the op runs, so it sees what earlier ops made.</item>
    /// <item>{select: {...}} (or the query itself) in place of one id (host, target, id, along...): exactly one match, or
    /// first true.</item>
    /// <item>for_each {per: room|level|element|view|sheet|grid_intersection|point, items? | select?, level? (rooms),
    /// ops: [...]}: the ops once per item, with the item's values filled in: "{id}", "{name}", "{number}",
    /// "{level}", "{center_mm}", "{min_mm}", "{max_mm}", "{outline_mm}" (a room's boundary), "{start_mm}",
    /// "{end_mm}", "{elevation_mm}", "{next_level}", "{index}"... A whole-string "{x}" becomes the value itself (a
    /// point stays a point); inside text it becomes text ("Ceiling {number}"). "@k" is op k of the same pass;
    /// "$n" still names op n of the batch as written.</item>
    /// </list>
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private const int MaxItems = 500, MaxExpanded = 3000;
        private static readonly Regex Hole = new Regex(@"\{([a-z_0-9]+)\}");
        private static readonly Regex Dollar = new Regex(@"^\$(\d+)$");
        private static readonly Regex At = new Regex(@"^@(\d+)$");

        /// <summary>The batch with every for_each spread out; "$n" renumbered to the spread batch. sources: each op's own number as written.</summary>
        private List<JObject> Expand(Document doc, List<JObject> ops, out List<int> sources)
        {
            sources = new List<int>();
            if (!ops.Any(o => o.Value<string>("op") == "for_each")) { for (int i = 0; i < ops.Count; i++) sources.Add(i + 1); return ops; }
            var output = new List<JObject>();
            var renumber = new Dictionary<int, int>();   // op n as written -> its last op in the spread batch
            var pending = new List<(JObject op, int written)>();
            for (int i = 0; i < ops.Count; i++)
            {
                JObject op = ops[i];
                if (op.Value<string>("op") != "for_each")
                {
                    output.Add(Renumber((JObject)op.DeepClone(), renumber, 0)); sources.Add(i + 1);
                    renumber[i + 1] = output.Count;
                    continue;
                }
                var inner = (op["ops"] as JArray ?? throw new InvalidOperationException($"op {i + 1} for_each needs ops: [...]")).OfType<JObject>().ToList();
                if (inner.Count == 0) throw new InvalidOperationException($"op {i + 1} for_each has no ops");
                if (inner.Any(o => o.Value<string>("op") == "for_each")) throw new InvalidOperationException("for_each inside for_each: spread it in one for_each with per element and a select");
                var items = Items(doc, op);
                if (items.Count == 0) throw new InvalidOperationException($"op {i + 1} for_each found no {op.Value<string>("per")}s");
                if (items.Count > MaxItems) throw new InvalidOperationException($"op {i + 1} for_each: {items.Count} items, over {MaxItems}: narrow it with items or select");
                for (int k = 0; k < items.Count; k++)
                {
                    var values = items[k];
                    values["index"] = k + 1; values["count"] = items.Count;
                    int baseN = output.Count;
                    foreach (JObject io in inner)
                    {
                        var filled = (JObject)Fill(io.DeepClone(), values);
                        output.Add(Renumber(filled, renumber, baseN)); sources.Add(i + 1);
                        if (output.Count > MaxExpanded) throw new InvalidOperationException($"the batch spreads to over {MaxExpanded} ops: split it");
                    }
                }
                renumber[i + 1] = output.Count;
            }
            return output;
        }

        /// <summary>"$n" (as written) to the spread batch's number; "@k" to op k of this pass.</summary>
        private static JObject Renumber(JObject op, Dictionary<int, int> renumber, int passBase)
        {
            foreach (JValue v in op.DescendantsAndSelf().OfType<JValue>().Where(x => x.Type == JTokenType.String).ToList())
            {
                string s = (string)v.Value;
                var d = Dollar.Match(s);
                if (d.Success)
                {
                    int n = int.Parse(d.Groups[1].Value);
                    if (!renumber.TryGetValue(n, out int to)) throw new InvalidOperationException($"{s}: op {n} comes later in the batch, or is the op itself");
                    v.Value = "$" + to;
                }
                var a = At.Match(s);
                if (a.Success) v.Value = "$" + (passBase + int.Parse(a.Groups[1].Value));
            }
            return op;
        }

        private static JToken Fill(JToken t, JObject values)
        {
            switch (t)
            {
                case JObject o:
                    foreach (var p in o.Properties().ToList()) p.Value = Fill(p.Value, values);
                    return o;
                case JArray a:
                    for (int i = 0; i < a.Count; i++) a[i] = Fill(a[i], values);
                    return a;
                case JValue v when v.Type == JTokenType.String:
                {
                    string s = (string)v.Value;
                    var whole = Hole.Match(s);
                    if (whole.Success && whole.Length == s.Length && values[whole.Groups[1].Value] is JToken val) return val.DeepClone();
                    return new JValue(Hole.Replace(s, m => values[m.Groups[1].Value] is JToken x ? (x.Type == JTokenType.String ? (string)x : x.ToString(Newtonsoft.Json.Formatting.None)) : m.Value));
                }
                default: return t;
            }
        }

        private static JArray P3(XYZ p) => new JArray(Mm(p.X), Mm(p.Y), Mm(p.Z));

        private static void Extent(JObject v, Element e)
        {
            if (e.get_BoundingBox(null) is BoundingBoxXYZ b) { v["min_mm"] = P3(b.Min); v["max_mm"] = P3(b.Max); }
            try { v["center_mm"] = P3(FmcSelect.Centre(e)); } catch (Exception) { }
        }

        private List<JObject> Items(Document doc, JObject op)
        {
            string per = op.Value<string>("per") ?? throw new InvalidOperationException("for_each needs per: room, level, element, view, sheet, grid_intersection or point");
            var given = op["items"] as JArray;
            var sel = op["select"] as JObject;
            var rows = new List<JObject>();
            switch (per)
            {
                case "room":
                {
                    IEnumerable<Room> rooms = given != null ? given.Select(t => FmcBox.RoomOf(doc, t))
                        : sel != null ? FmcSelect.Find(doc, sel, null, _uidoc?.ActiveView).OfType<Room>()
                        : new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).OfType<Room>().Where(r => r.Area > 0);
                    if (op["level"] != null) { string l = op.Value<string>("level"); rooms = rooms.Where(r => string.Equals(r.Level?.Name, l, StringComparison.OrdinalIgnoreCase)); }
                    foreach (Room r in rooms.OrderBy(r => r.Level?.Elevation ?? 0).ThenBy(r => r.Number))
                    {
                        var v = new JObject { ["id"] = r.Id.Value, ["number"] = r.Number, ["name"] = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "",
                            ["level"] = r.Level?.Name ?? "", ["area_m2"] = Math.Round(r.Area * 0.09290304, 2) };
                        Extent(v, r);
                        var loop = r.GetBoundarySegments(new SpatialElementBoundaryOptions()).FirstOrDefault();
                        if (loop != null) v["outline_mm"] = new JArray(loop.Select(sg => new JArray(Mm(sg.GetCurve().GetEndPoint(0).X), Mm(sg.GetCurve().GetEndPoint(0).Y))));
                        rows.Add(v);
                    }
                    break;
                }
                case "level":
                {
                    var all = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
                    var chosen = given != null ? given.Select(t => LevelOf(doc, t)).OrderBy(l => l.Elevation).ToList() : all;
                    foreach (Level l in chosen)
                        rows.Add(new JObject { ["id"] = l.Id.Value, ["name"] = l.Name, ["level"] = l.Name, ["elevation_mm"] = Mm(l.Elevation),
                            ["next_level"] = all.FirstOrDefault(x => x.Elevation > l.Elevation + 1e-6)?.Name ?? "" });
                    break;
                }
                case "element":
                {
                    var els = given != null ? given.Select(t => doc.GetElement(Ref(doc, t, new List<List<ElementId>>())) ?? throw new InvalidOperationException($"{t} isn't in this model")).ToList()
                        : sel != null ? FmcSelect.Find(doc, sel, null, _uidoc?.ActiveView) : throw new InvalidOperationException("for_each per element needs items (ids) or select");
                    foreach (Element e in els)
                    {
                        var v = new JObject { ["id"] = e.Id.Value, ["name"] = e.Name, ["type"] = doc.GetElement(e.GetTypeId())?.Name ?? e.Name,
                            ["category"] = e.Category?.Name ?? "", ["level"] = doc.GetElement(e.LevelId)?.Name ?? "", ["type_id"] = e.GetTypeId().Value };
                        Extent(v, e);
                        if (e.Location is LocationCurve lc) { v["start_mm"] = P3(lc.Curve.GetEndPoint(0)); v["end_mm"] = P3(lc.Curve.GetEndPoint(1)); v["length_mm"] = Mm(lc.Curve.Length); }
                        if (e is FamilyInstance fi && fi.Host != null) v["host"] = fi.Host.Id.Value;
                        rows.Add(v);
                    }
                    break;
                }
                case "view":
                case "sheet":
                {
                    IEnumerable<View> views = given != null ? given.Select(t => ViewOf(doc, t, null))
                        : new FilteredElementCollector(doc).OfClass(per == "sheet" ? typeof(ViewSheet) : typeof(View)).Cast<View>().Where(v => !v.IsTemplate && (per == "sheet" || !(v is ViewSheet)));
                    if (op["view_type"] != null) views = views.Where(v => string.Equals(v.ViewType.ToString(), op.Value<string>("view_type"), StringComparison.OrdinalIgnoreCase));
                    if (op["name_contains"] != null) views = views.Where(v => v.Name.IndexOf(op.Value<string>("name_contains"), StringComparison.OrdinalIgnoreCase) >= 0);
                    foreach (View v in views)
                        rows.Add(new JObject { ["id"] = v.Id.Value, ["name"] = v.Name, ["number"] = (v as ViewSheet)?.SheetNumber ?? "", ["view_type"] = v.ViewType.ToString(),
                            ["level"] = v.GenLevel?.Name ?? "", ["scale"] = v is ViewSheet ? 0 : v.Scale });
                    break;
                }
                case "grid_intersection":
                {
                    var grids = new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>().Where(g => g.Curve is Line).ToList();
                    if (given != null) { var want = new HashSet<string>(given.Select(t => t.ToString()), StringComparer.OrdinalIgnoreCase); grids = grids.Where(g => want.Contains(g.Name)).ToList(); }
                    for (int a = 0; a < grids.Count; a++)
                        for (int b = a + 1; b < grids.Count; b++)
                        {
                            Line la = (Line)grids[a].Curve, lb = (Line)grids[b].Curve;
                            Line fa = Line.CreateUnbound(new XYZ(la.Origin.X, la.Origin.Y, 0), new XYZ(la.Direction.X, la.Direction.Y, 0));
                            Line fb = Line.CreateBound(new XYZ(lb.GetEndPoint(0).X, lb.GetEndPoint(0).Y, 0), new XYZ(lb.GetEndPoint(1).X, lb.GetEndPoint(1).Y, 0));
                            if (fa.Intersect(fb, out IntersectionResultArray hit) != SetComparisonResult.Overlap || hit == null || hit.Size == 0) continue;
                            XYZ p = hit.get_Item(0).XYZPoint;
                            if (la.Project(new XYZ(p.X, p.Y, la.Origin.Z))?.Distance > 1e-3) continue;   // only where both drawn grids reach
                            rows.Add(new JObject { ["center_mm"] = new JArray(Mm(p.X), Mm(p.Y)), ["name"] = $"{grids[a].Name}-{grids[b].Name}", ["grids"] = new JArray(grids[a].Name, grids[b].Name) });
                        }
                    break;
                }
                case "point":
                    foreach (JToken t in given ?? throw new InvalidOperationException("for_each per point needs items: [[x, y], ...]"))
                        rows.Add(new JObject { ["center_mm"] = t.DeepClone(), ["name"] = t.ToString(Newtonsoft.Json.Formatting.None) });
                    break;
                default: throw new InvalidOperationException($"for_each per {per}? (room, level, element, view, sheet, grid_intersection, point)");
            }
            return rows;
        }

        /// <summary>An op's select becomes ids (added to any it names), when the op runs.</summary>
        private JObject WithSelect(Document doc, JObject op, List<List<ElementId>> made, out int selected)
        {
            selected = 0;
            if (!(op["select"] is JObject spec)) return op;
            var found = FmcSelect.ForEdit(doc, spec, t => Ref(doc, t, made), _uidoc?.ActiveView, $"{op.Value<string>("op")} select");
            selected = found.Count;
            var copy = (JObject)op.DeepClone();
            copy.Remove("select");
            var ids = copy["ids"] as JArray ?? new JArray();
            var have = new HashSet<string>(ids.Select(x => x.ToString()));
            foreach (ElementId id in found) if (have.Add(id.Value.ToString())) ids.Add(id.Value);
            copy["ids"] = ids;
            return copy;
        }

        /// <summary>{select: {...}} (or a bare query) in place of one id: exactly one match, or first true.</summary>
        private static ElementId OneOf(Document doc, JObject t, List<List<ElementId>> made)
        {
            JObject spec = t["select"] as JObject ?? t;
            var found = FmcSelect.ForEdit(doc, spec, x => Ref(doc, x, made), null, "a {select} in place of an id");
            if (found.Count > 1 && spec.Value<bool?>("first") != true)
                throw new InvalidOperationException($"a {{select}} in place of one id found {found.Count} elements ({string.Join(", ", found.Take(5).Select(x => x.Value))}...): narrow it, or first true");
            return found[0];
        }
    }
}
