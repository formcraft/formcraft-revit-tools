using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's view and sheet ops (owner 26 Oct, tools group 2): create_view (floor, ceiling and structural
    /// plans, sections, elevations, 3D, drafting, callouts), duplicate_view, set_view (name, scale, detail level,
    /// template, crop, view range, discipline, section box, any parameter), override (graphics by element, category or
    /// filter), hide / unhide, create_filter, create_template, apply_template, create_sheet, place_view, open_view.
    /// A view is named by id, by its name, or "$n". Lengths in mm.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private UIDocument _uidoc;
        private View _openView;

        private JObject ViewOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "create_view": return CreateView(doc, op, made, created);
                case "duplicate_view":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var mode = (op.Value<string>("mode") ?? "duplicate") switch
                    {
                        "with_detailing" => ViewDuplicateOption.WithDetailing,
                        "as_dependent" => ViewDuplicateOption.AsDependent,
                        _ => ViewDuplicateOption.Duplicate,
                    };
                    if (!v.CanViewBeDuplicated(mode)) throw new InvalidOperationException($"{v.Name} can't be duplicated {mode}");
                    View copy = (View)doc.GetElement(v.Duplicate(mode));
                    if (op["name"] != null) copy.Name = op.Value<string>("name");
                    created.Add(copy.Id);
                    return new JObject { ["view"] = copy.Id.Value, ["name"] = copy.Name };
                }
                case "set_view":
                {
                    View v = ViewOf(doc, op["view"], made);
                    SetView(doc, v, op);
                    return new JObject { ["view"] = v.Id.Value, ["name"] = v.Name };
                }
                case "override":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var ogs = Graphics(doc, op);
                    int n = 0;
                    if (op["ids"] is JArray) foreach (ElementId id in op["ids"].Select(t => Ref(doc, t, made))) { v.SetElementOverrides(id, ogs); n++; }
                    foreach (ElementId c in Categories(doc, op["categories"])) { v.SetCategoryOverrides(c, ogs); n++; }
                    if (op["filter"] != null)
                    {
                        ElementId f = FilterOf(doc, op["filter"], made);
                        if (!v.GetFilters().Contains(f)) v.AddFilter(f);
                        v.SetFilterOverrides(f, ogs);
                        if (op["visible"] != null) v.SetFilterVisibility(f, op.Value<bool>("visible"));
                        n++;
                    }
                    if (n == 0) throw new InvalidOperationException("override needs ids, categories or filter");
                    return new JObject { ["overridden"] = n, ["view"] = v.Name };
                }
                case "hide":
                case "unhide":
                {
                    View v = ViewOf(doc, op["view"], made);
                    bool hide = name == "hide";
                    var ids = (op["ids"] as JArray ?? new JArray()).Select(t => Ref(doc, t, made)).ToList();
                    if (ids.Count > 0) { if (hide) v.HideElements(ids); else v.UnhideElements(ids); }
                    var cats = Categories(doc, op["categories"]);
                    foreach (ElementId c in cats) v.SetCategoryHidden(c, hide);
                    if (ids.Count + cats.Count == 0) throw new InvalidOperationException($"{name} needs ids or categories");
                    return new JObject { [name] = ids.Count + cats.Count, ["view"] = v.Name };
                }
                case "create_filter":
                {
                    string fname = op.Value<string>("name") ?? throw new InvalidOperationException("create_filter needs name");
                    var cats = Categories(doc, op["categories"]);
                    if (cats.Count == 0) throw new InvalidOperationException("create_filter needs categories");
                    var rules = new List<FilterRule>();
                    var filterable = ParameterFilterUtilities.GetFilterableParametersInCommon(doc, cats);
                    foreach (JObject r in (op["rules"] as JArray ?? new JArray()).OfType<JObject>()) rules.Add(Rule(doc, filterable, r));
                    ElementFilter filter = rules.Count > 0 ? new ElementParameterFilter(rules) : null;
                    ParameterFilterElement pf = filter == null ? ParameterFilterElement.Create(doc, fname, cats) : ParameterFilterElement.Create(doc, fname, cats, filter);
                    created.Add(pf.Id);
                    return new JObject { ["filter"] = pf.Id.Value, ["rules"] = rules.Count };
                }
                case "create_template":
                {
                    View v = ViewOf(doc, op["view"], made);
                    View t = v.CreateViewTemplate();
                    if (op["name"] != null) t.Name = op.Value<string>("name");
                    created.Add(t.Id);
                    return new JObject { ["template"] = t.Id.Value, ["name"] = t.Name };
                }
                case "apply_template":
                {
                    View t = ViewOf(doc, op["template"], made, templates: true);
                    if (!t.IsTemplate) throw new InvalidOperationException($"{t.Name} isn't a view template");
                    var views = (op["views"] as JArray ?? throw new InvalidOperationException("apply_template needs views")).Select(x => ViewOf(doc, x, made)).ToList();
                    foreach (View v in views)
                    {
                        if (op.Value<bool?>("once") == true) v.ApplyViewTemplateParameters(t);
                        else v.ViewTemplateId = t.Id;
                    }
                    return new JObject { ["applied"] = views.Count, ["template"] = t.Name };
                }
                case "create_sheet":
                {
                    ElementId tb = ElementId.InvalidElementId;
                    var tbs = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().ToElementIds();
                    if (op["title_block"] != null) tb = TypeFor(doc, new JObject { ["type_name"] = op["title_block"] }, tbs);
                    else if (tbs.Count > 0) tb = tbs.First();
                    ViewSheet sh = ViewSheet.Create(doc, tb);
                    if (op["number"] != null) sh.SheetNumber = op.Value<string>("number");
                    if (op["name"] != null) sh.Name = op.Value<string>("name");
                    created.Add(sh.Id);
                    return new JObject { ["sheet"] = sh.Id.Value, ["number"] = sh.SheetNumber, ["name"] = sh.Name };
                }
                case "place_view":
                {
                    View sheetView = ViewOf(doc, op["sheet"], made);
                    if (!(sheetView is ViewSheet sheet)) throw new InvalidOperationException($"{sheetView.Name} isn't a sheet");
                    View v = ViewOf(doc, op["view"], made);
                    XYZ at = op["point_mm"] != null ? Vec(op["point_mm"], "point_mm is [x, y] on the sheet") : SheetCentre(sheet);
                    ElementId placed;
                    if (v is ViewSchedule) placed = ScheduleSheetInstance.Create(doc, sheet.Id, v.Id, at).Id;
                    else
                    {
                        if (!Viewport.CanAddViewToSheet(doc, sheet.Id, v.Id)) throw new InvalidOperationException($"{v.Name} can't go on {sheet.SheetNumber} (it's on another sheet, or empty)");
                        placed = Viewport.Create(doc, sheet.Id, v.Id, at).Id;
                    }
                    created.Add(placed);
                    return new JObject { ["placed"] = placed.Value, ["sheet"] = sheet.SheetNumber, ["view"] = v.Name };
                }
                case "open_view":
                {
                    // shown when the batch is done (Revit can't switch views inside a transaction)
                    _openView = ViewOf(doc, op["view"], made);
                    return new JObject { ["open"] = _openView.Name };
                }
                default: return null;
            }
        }

        private JObject CreateView(Document doc, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            string kind = op.Value<string>("kind") ?? throw new InvalidOperationException("create_view needs kind: floor_plan, ceiling_plan, structural_plan, section, elevation, 3d, drafting or callout");
            ViewFamily family = kind switch
            {
                "floor_plan" => ViewFamily.FloorPlan, "ceiling_plan" => ViewFamily.CeilingPlan, "structural_plan" => ViewFamily.StructuralPlan,
                "section" => ViewFamily.Section, "elevation" => ViewFamily.Elevation, "3d" => ViewFamily.ThreeDimensional,
                "drafting" => ViewFamily.Drafting, "callout" => ViewFamily.Detail,
                _ => throw new InvalidOperationException($"{kind} isn't a view kind"),
            };
            var vfts = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().Where(t => t.ViewFamily == family).ToList();
            if (kind == "callout" && vfts.Count == 0) vfts = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().Where(t => t.ViewFamily == ViewFamily.FloorPlan).ToList();
            if (vfts.Count == 0) throw new InvalidOperationException($"the model has no {family} view type");
            ElementId vft = TypeFor(doc, op, vfts.Select(t => t.Id).ToList(), vfts[0].Id);
            View v;
            switch (kind)
            {
                case "floor_plan": case "ceiling_plan": case "structural_plan":
                    v = ViewPlan.Create(doc, vft, LevelOf(doc, op["level"]).Id); break;
                case "3d":
                {
                    var v3 = View3D.CreateIsometric(doc, vft);
                    if (op["section_box_mm"] is JArray sb) v3.SetSectionBox(Box(sb));
                    v = v3; break;
                }
                case "drafting": v = ViewDrafting.Create(doc, vft); break;
                case "section":
                {
                    // line_mm: the cut line in plan, looking to its left; depth_mm how far it sees; bottom_mm / top_mm the height
                    var l = Points(op["line_mm"], "section needs line_mm: [[x, y], [x, y]], the cut line");
                    XYZ dir = (l[1] - l[0]).Normalize(), up = XYZ.BasisZ, view = dir.CrossProduct(up);
                    double half = (l[1] - l[0]).GetLength() / 2;
                    var t = Transform.Identity; t.Origin = (l[0] + l[1]) / 2; t.BasisX = dir; t.BasisY = up; t.BasisZ = view;
                    var box = new BoundingBoxXYZ
                    {
                        Transform = t,
                        Min = new XYZ(-half, Ft(op.Value<double?>("bottom_mm") ?? -1000), 0),
                        Max = new XYZ(half, Ft(op.Value<double?>("top_mm") ?? 10000), Ft(op.Value<double?>("depth_mm") ?? 5000)),
                    };
                    v = ViewSection.CreateSection(doc, vft, box); break;
                }
                case "elevation":
                {
                    // a marker at point_mm in the plan view; face 0-3 picks the marker's arrow; the answer gives the view direction
                    View plan = op["plan"] != null ? ViewOf(doc, op["plan"], made) : PlanOf(doc, op["level"]);
                    XYZ at = Vec(op["point_mm"], "elevation needs point_mm [x, y] in the plan");
                    ElevationMarker m = ElevationMarker.CreateElevationMarker(doc, vft, at, op.Value<int?>("scale") ?? 100);
                    created.Add(m.Id);
                    v = m.CreateElevation(doc, plan.Id, op.Value<int?>("face") ?? 0); break;
                }
                default: // callout
                {
                    View parent = ViewOf(doc, op["parent"], made);
                    var c = Points(op["box_mm"], "callout needs box_mm: [[x, y], [x, y]], two corners in the parent view");
                    v = ViewSection.CreateCallout(doc, parent.Id, vft, c[0], c[1]); break;
                }
            }
            created.Insert(0, v.Id);
            if (op["name"] != null) v.Name = op.Value<string>("name");
            SetView(doc, v, op);
            return new JObject { ["view"] = v.Id.Value, ["name"] = v.Name, ["direction"] = new JArray(Math.Round(v.ViewDirection.X, 3), Math.Round(v.ViewDirection.Y, 3), Math.Round(v.ViewDirection.Z, 3)) };
        }

        private void SetView(Document doc, View v, JObject op)
        {
            if (op["rename"] != null) v.Name = op.Value<string>("rename");
            if (op["scale"] != null) v.Scale = op.Value<int>("scale");
            if (op["detail_level"] != null) v.DetailLevel = (ViewDetailLevel)Enum.Parse(typeof(ViewDetailLevel), op.Value<string>("detail_level"), true);
            if (op["discipline"] != null) v.Discipline = (ViewDiscipline)Enum.Parse(typeof(ViewDiscipline), op.Value<string>("discipline"), true);
            if (op["template"] != null)
                v.ViewTemplateId = op.Value<string>("template").Equals("none", StringComparison.OrdinalIgnoreCase) ? ElementId.InvalidElementId : ViewOf(doc, op["template"], null, templates: true).Id;
            if (op["crop_mm"] is JArray crop)
            {
                // two corners in plan coordinates (plans), or along / up the view (sections, elevations)
                var c = Points(crop, "crop_mm is [[x, y], [x, y]]");
                BoundingBoxXYZ cb = v.CropBox;
                XYZ a = v is ViewPlan ? cb.Transform.Inverse.OfPoint(c[0]) : c[0], b = v is ViewPlan ? cb.Transform.Inverse.OfPoint(c[1]) : c[1];
                cb.Min = new XYZ(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), cb.Min.Z);
                cb.Max = new XYZ(Math.Max(a.X, b.X), Math.Max(a.Y, b.Y), cb.Max.Z);
                v.CropBoxActive = true;
                v.CropBox = cb;
            }
            if (op["crop_visible"] != null) v.CropBoxVisible = op.Value<bool>("crop_visible");
            if (op["view_range_mm"] is JObject vr && v is ViewPlan plan)
            {
                PlanViewRange r = plan.GetViewRange();
                foreach (var (key, plane) in new[] { ("top", PlanViewPlane.TopClipPlane), ("cut", PlanViewPlane.CutPlane), ("bottom", PlanViewPlane.BottomClipPlane), ("depth", PlanViewPlane.ViewDepthPlane) })
                    if (vr[key] != null) r.SetOffset(plane, Ft(vr.Value<double>(key)));
                plan.SetViewRange(r);
            }
            if (op["section_box_mm"] is JArray sb && v is View3D v3 && op.Value<string>("op") != "create_view") v3.SetSectionBox(Box(sb));
            if (op["params"] is JObject ps) foreach (var kv in ps) SetParam(doc, v, kv.Key, ValueOp(kv.Value), false);
        }

        private OverrideGraphicSettings Graphics(Document doc, JObject op)
        {
            var g = new OverrideGraphicSettings();
            if (op["color"] is JArray c)
            {
                var col = new Color((byte)c[0].Value<int>(), (byte)c[1].Value<int>(), (byte)c[2].Value<int>());
                g.SetProjectionLineColor(col); g.SetCutLineColor(col);
                if (op.Value<bool?>("fill") ?? true)
                {
                    ElementId solid = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>()
                        .FirstOrDefault(f => f.GetFillPattern().IsSolidFill)?.Id ?? ElementId.InvalidElementId;
                    if (solid != ElementId.InvalidElementId)
                    {
                        g.SetSurfaceForegroundPatternId(solid); g.SetSurfaceForegroundPatternColor(col);
                        g.SetCutForegroundPatternId(solid); g.SetCutForegroundPatternColor(col);
                    }
                }
            }
            if (op["line_weight"] != null) { g.SetProjectionLineWeight(op.Value<int>("line_weight")); g.SetCutLineWeight(op.Value<int>("line_weight")); }
            if (op["transparency"] != null) g.SetSurfaceTransparency(op.Value<int>("transparency"));
            if (op["halftone"] != null) g.SetHalftone(op.Value<bool>("halftone"));
            return g;
        }

        private static FilterRule Rule(Document doc, ICollection<ElementId> filterable, JObject r)
        {
            string pname = r.Value<string>("param") ?? throw new InvalidOperationException("each rule needs param");
            ElementId pid = filterable.FirstOrDefault(id => string.Equals(ParamName(doc, id), pname, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"{pname} can't be filtered on for these categories");
            string how = r.Value<string>("op") ?? "equals";
            JToken v = r["value"];
            if (r["value_mm"] != null || v?.Type == JTokenType.Float || v?.Type == JTokenType.Integer)
            {
                double d = r["value_mm"] != null ? Ft(r.Value<double>("value_mm")) : v.Value<double>();
                const double eps = 1e-4;
                return how switch
                {
                    "greater" => ParameterFilterRuleFactory.CreateGreaterRule(pid, d, eps),
                    "less" => ParameterFilterRuleFactory.CreateLessRule(pid, d, eps),
                    "not_equals" => ParameterFilterRuleFactory.CreateNotEqualsRule(pid, d, eps),
                    _ => ParameterFilterRuleFactory.CreateEqualsRule(pid, d, eps),
                };
            }
            string s = v?.ToString() ?? "";
            return how switch
            {
                "contains" => ParameterFilterRuleFactory.CreateContainsRule(pid, s),
                "not_equals" => ParameterFilterRuleFactory.CreateNotEqualsRule(pid, s),
                "begins_with" => ParameterFilterRuleFactory.CreateBeginsWithRule(pid, s),
                _ => ParameterFilterRuleFactory.CreateEqualsRule(pid, s),
            };
        }

        private static string ParamName(Document doc, ElementId id)
        {
            if (id.Value < 0) { try { return LabelUtils.GetLabelFor((BuiltInParameter)id.Value); } catch (Exception) { return ""; } }
            return doc.GetElement(id)?.Name ?? "";
        }

        /// <summary>Categories by built-in name (OST_Walls) or by their name in Revit (Walls).</summary>
        private static List<ElementId> Categories(Document doc, JToken t)
        {
            var list = new List<ElementId>();
            foreach (string s in (t as JArray ?? new JArray()).Select(x => x.ToString()))
            {
                Category c = Enum.TryParse(s, true, out BuiltInCategory bic) ? Category.GetCategory(doc, bic)
                    : doc.Settings.Categories.Cast<Category>().FirstOrDefault(x => string.Equals(x.Name, s, StringComparison.OrdinalIgnoreCase));
                list.Add(c?.Id ?? throw new InvalidOperationException($"no category {s}"));
            }
            return list;
        }

        private static View ViewOf(Document doc, JToken t, List<List<ElementId>> made, bool templates = false)
        {
            if (t == null) throw new InvalidOperationException("the op needs a view (id, name or $n)");
            string s = t.ToString();
            if (s.StartsWith("$") || long.TryParse(s, out _)) return doc.GetElement(Ref(doc, t, made ?? new List<List<ElementId>>())) as View ?? throw new InvalidOperationException($"{s} isn't a view");
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => v.IsTemplate == templates || v is ViewSheet).ToList();
            return views.FirstOrDefault(v => string.Equals(v.Name, s, StringComparison.OrdinalIgnoreCase))
                ?? views.OfType<ViewSheet>().FirstOrDefault(v => string.Equals(v.SheetNumber, s, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"no {(templates ? "view template" : "view or sheet")} named {s}");
        }

        private static ElementId FilterOf(Document doc, JToken t, List<List<ElementId>> made)
        {
            string s = t.ToString();
            if (s.StartsWith("$") || long.TryParse(s, out _)) return Ref(doc, t, made);
            return new FilteredElementCollector(doc).OfClass(typeof(ParameterFilterElement)).FirstOrDefault(f => string.Equals(f.Name, s, StringComparison.OrdinalIgnoreCase))?.Id
                ?? throw new InvalidOperationException($"no view filter named {s}");
        }

        private static View PlanOf(Document doc, JToken level)
        {
            Level l = LevelOf(doc, level);
            return new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(v => !v.IsTemplate && v.GenLevel?.Id == l.Id && v.ViewType == ViewType.FloorPlan)
                ?? throw new InvalidOperationException($"{l.Name} has no floor plan for the elevation marker (give plan)");
        }

        private static BoundingBoxXYZ Box(JArray two)
        {
            var p = Points(two, "a box is [[x, y, z], [x, y, z]]");
            return new BoundingBoxXYZ { Min = new XYZ(Math.Min(p[0].X, p[1].X), Math.Min(p[0].Y, p[1].Y), Math.Min(p[0].Z, p[1].Z)), Max = new XYZ(Math.Max(p[0].X, p[1].X), Math.Max(p[0].Y, p[1].Y), Math.Max(p[0].Z, p[1].Z)) };
        }

        private static XYZ SheetCentre(ViewSheet sheet)
        {
            BoundingBoxUV o = sheet.Outline;
            return new XYZ((o.Min.U + o.Max.U) / 2, (o.Min.V + o.Max.V) / 2, 0);
        }
    }
}
