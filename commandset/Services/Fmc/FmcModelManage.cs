using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's project settings ops (owner 26 Oct, tools group 7): create_material, line_style, line_pattern,
    /// fill_pattern, object_style, project_info, project_units, global_param, associate_global, coordinates,
    /// acquire_coordinates, publish_coordinates, create_workset, set_workset, purge, save_selection, copy_types,
    /// keynote_file.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject ManageOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "create_material":
                {
                    string mname = op.Value<string>("name") ?? throw new InvalidOperationException("create_material needs name");
                    Material m;
                    if (op["from"] != null)
                    {
                        var src = (Material)doc.GetElement(MaterialId(doc, op.Value<string>("from")));
                        m = src.Duplicate(mname);
                    }
                    else m = (Material)doc.GetElement(Material.Create(doc, mname));
                    if (op["color"] is JArray c) m.Color = new Color((byte)c[0].Value<int>(), (byte)c[1].Value<int>(), (byte)c[2].Value<int>());
                    if (op["transparency"] != null) m.Transparency = op.Value<int>("transparency");
                    if (op["class"] != null) m.MaterialClass = op.Value<string>("class");
                    created.Add(m.Id);
                    return new JObject { ["material"] = m.Id.Value, ["name"] = m.Name };
                }
                case "line_style":
                {
                    Category lines = Category.GetCategory(doc, BuiltInCategory.OST_Lines);
                    string sname = op.Value<string>("name") ?? throw new InvalidOperationException("line_style needs name");
                    Category sub = lines.SubCategories.Cast<Category>().FirstOrDefault(x => x.Name == sname) ?? doc.Settings.Categories.NewSubcategory(lines, sname);
                    Style(doc, sub, op);
                    return new JObject { ["line_style"] = sub.Name };
                }
                case "line_pattern":
                {
                    // segments: [{kind: dash|space|dot, length_mm}]
                    var lp = new LinePattern(op.Value<string>("name") ?? throw new InvalidOperationException("line_pattern needs name"));
                    lp.SetSegments((op["segments"] as JArray ?? throw new InvalidOperationException("line_pattern needs segments")).OfType<JObject>()
                        .Select(s => new LinePatternSegment((LinePatternSegmentType)Enum.Parse(typeof(LinePatternSegmentType), s.Value<string>("kind") ?? "dash", true), Ft(s.Value<double?>("length_mm") ?? 0))).ToList());
                    var e = LinePatternElement.Create(doc, lp);
                    created.Add(e.Id);
                    return new JObject { ["line_pattern"] = e.Id.Value };
                }
                case "fill_pattern":
                {
                    var target = (op.Value<string>("kind") ?? "drafting") == "model" ? FillPatternTarget.Model : FillPatternTarget.Drafting;
                    double ang = (op.Value<double?>("angle_deg") ?? 45) * Math.PI / 180, sp = Ft(op.Value<double?>("spacing_mm") ?? 3);
                    string pname = op.Value<string>("name") ?? throw new InvalidOperationException("fill_pattern needs name");
                    var fp = op.Value<bool?>("crosshatch") == true
                        ? new FillPattern(pname, target, FillPatternHostOrientation.ToView, ang, sp, Ft(op.Value<double?>("spacing2_mm") ?? op.Value<double?>("spacing_mm") ?? 3))
                        : new FillPattern(pname, target, FillPatternHostOrientation.ToView, ang, sp);
                    var e = FillPatternElement.Create(doc, fp);
                    created.Add(e.Id);
                    return new JObject { ["fill_pattern"] = e.Id.Value };
                }
                case "object_style":
                {
                    Category c = Category.GetCategory(doc, Categories(doc, new JArray(op.Value<string>("category") ?? throw new InvalidOperationException("object_style needs category")))[0]);
                    if (op["subcategory"] != null)
                        c = c.SubCategories.Cast<Category>().FirstOrDefault(x => string.Equals(x.Name, op.Value<string>("subcategory"), StringComparison.OrdinalIgnoreCase))
                            ?? doc.Settings.Categories.NewSubcategory(c, op.Value<string>("subcategory"));
                    Style(doc, c, op);
                    if (op["material"] != null) c.Material = (Material)doc.GetElement(MaterialId(doc, op.Value<string>("material")));
                    return new JObject { ["style"] = c.Name };
                }
                case "project_info":
                {
                    var ps = op["params"] as JObject ?? throw new InvalidOperationException("project_info needs params {name: value}");
                    foreach (var kv in ps) SetParam(doc, doc.ProjectInformation, kv.Key, ValueOp(kv.Value), false);
                    return new JObject { ["set"] = ps.Count };
                }
                case "project_units":
                {
                    // length: Millimeters, Meters, Centimeters, Feet...; accuracy e.g. 1 or 0.01; area / volume likewise
                    Units u = doc.GetUnits();
                    foreach (var (key, spec) in new[] { ("length", SpecTypeId.Length), ("area", SpecTypeId.Area), ("volume", SpecTypeId.Volume), ("angle", SpecTypeId.Angle) })
                    {
                        if (op[key] == null) continue;
                        var unit = typeof(UnitTypeId).GetProperties().FirstOrDefault(p => string.Equals(p.Name, op.Value<string>(key), StringComparison.OrdinalIgnoreCase))?.GetValue(null) as ForgeTypeId
                            ?? throw new InvalidOperationException($"{op.Value<string>(key)} isn't a unit (Millimeters, Meters, SquareMeters, CubicMeters, Degrees...)");
                        var fo = new FormatOptions(unit);
                        if (op[key + "_accuracy"] != null) fo.Accuracy = op.Value<double>(key + "_accuracy");
                        u.SetFormatOptions(spec, fo);
                    }
                    doc.SetUnits(u);
                    return new JObject { ["units"] = "set" };
                }
                case "global_param":
                {
                    string gname = op.Value<string>("name") ?? throw new InvalidOperationException("global_param needs name");
                    ElementId id = GlobalParametersManager.FindByName(doc, gname);
                    var gp = id != ElementId.InvalidElementId ? (GlobalParameter)doc.GetElement(id) : GlobalParameter.Create(doc, gname, Spec(op.Value<string>("type") ?? "Length"));
                    if (op["formula"] != null) gp.SetFormula(op.Value<string>("formula"));
                    else if (op["value"] != null)
                    {
                        var dt = gp.GetDefinition().GetDataType();
                        if (dt == SpecTypeId.String.Text) gp.SetValue(new StringParameterValue(op.Value<string>("value")));
                        else if (dt == SpecTypeId.Int.Integer || dt == SpecTypeId.Boolean.YesNo) gp.SetValue(new IntegerParameterValue(op.Value<int>("value")));
                        else gp.SetValue(new DoubleParameterValue(dt == SpecTypeId.Length ? Ft(op.Value<double>("value")) : op.Value<double>("value")));
                    }
                    created.Add(gp.Id);
                    return new JObject { ["global"] = gp.Id.Value, ["name"] = gname };
                }
                case "associate_global":
                {
                    ElementId g = GlobalParametersManager.FindByName(doc, op.Value<string>("global") ?? throw new InvalidOperationException("associate_global needs global"));
                    if (g == ElementId.InvalidElementId) throw new InvalidOperationException($"no global parameter {op.Value<string>("global")}");
                    string pname = op.Value<string>("param") ?? throw new InvalidOperationException("associate_global needs param");
                    foreach (ElementId id in Targets(doc, op, made)) (doc.GetElement(id).LookupParameter(pname) ?? throw new InvalidOperationException($"{id.Value} has no {pname}")).AssociateWithGlobalParameter(g);
                    return new JObject { ["associated"] = op["ids"].Count() };
                }
                case "coordinates":
                {
                    // the shared coordinates at point_mm (default the internal origin): east_west_mm, north_south_mm, elevation_mm, angle_deg to true north
                    ProjectLocation loc = doc.ActiveProjectLocation;
                    XYZ at = op["point_mm"] != null ? Vec(op["point_mm"], "point_mm is [x, y, z]") : XYZ.Zero;
                    ProjectPosition now = loc.GetProjectPosition(at);
                    var pp = new ProjectPosition(
                        op["east_west_mm"] != null ? Ft(op.Value<double>("east_west_mm")) : now.EastWest,
                        op["north_south_mm"] != null ? Ft(op.Value<double>("north_south_mm")) : now.NorthSouth,
                        op["elevation_mm"] != null ? Ft(op.Value<double>("elevation_mm")) : now.Elevation,
                        op["angle_deg"] != null ? op.Value<double>("angle_deg") * Math.PI / 180 : now.Angle);
                    loc.SetProjectPosition(at, pp);
                    return new JObject { ["coordinates"] = "set" };
                }
                case "acquire_coordinates":
                    doc.AcquireCoordinates(Ref(doc, op["link"], made) ?? throw new InvalidOperationException("acquire_coordinates needs link (the link instance id)"));
                    return new JObject { ["acquired_from"] = op["link"] };
                case "publish_coordinates":
                {
                    ElementId link = Ref(doc, op["link"], made) ?? throw new InvalidOperationException("publish_coordinates needs link (the link instance id)");
                    var inst = (RevitLinkInstance)doc.GetElement(link);
                    Document ld = inst.GetLinkDocument() ?? throw new InvalidOperationException("the link isn't loaded");
                    doc.PublishCoordinates(new LinkElementId(link, ld.ActiveProjectLocation.Id));
                    return new JObject { ["published_to"] = op["link"] };
                }
                case "create_workset":
                {
                    if (!doc.IsWorkshared) throw new InvalidOperationException("the model isn't workshared (enable worksharing first)");
                    string wname = op.Value<string>("name") ?? throw new InvalidOperationException("create_workset needs name");
                    Workset w = Workset.Create(doc, wname);
                    return new JObject { ["workset"] = w.Id.IntegerValue, ["name"] = w.Name };
                }
                case "set_workset":
                {
                    Workset w = new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).FirstOrDefault(x => string.Equals(x.Name, op.Value<string>("workset"), StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"no workset {op.Value<string>("workset")}");
                    foreach (ElementId id in Targets(doc, op, made)) doc.GetElement(id).get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)?.Set(w.Id.IntegerValue);
                    return new JObject { ["moved"] = op["ids"].Count(), ["workset"] = w.Name };
                }
                case "purge":
                {
                    // unused families, types, materials... (Revit's Purge Unused); categories limits it; passes repeats it
                    var cats = op["categories"] != null ? Categories(doc, op["categories"]).ToHashSet() : new HashSet<ElementId>();
                    int removed = 0;
                    for (int pass = 0; pass < (op.Value<int?>("passes") ?? 3); pass++)
                    {
                        var unused = doc.GetUnusedElements(cats);
                        if (unused.Count == 0) break;
                        foreach (ElementId id in unused) { try { if (doc.GetElement(id) != null) { doc.Delete(id); removed++; } } catch (Exception) { /* Revit keeps it */ } }
                    }
                    return new JObject { ["purged"] = removed };
                }
                case "save_selection":
                {
                    var f = SelectionFilterElement.Create(doc, op.Value<string>("name") ?? throw new InvalidOperationException("save_selection needs name"));
                    f.SetElementIds(Targets(doc, op, made, allowPinned: true));
                    created.Add(f.Id);
                    return new JObject { ["selection"] = f.Id.Value };
                }
                case "copy_types":
                {
                    // Transfer Project Standards, by copying: types (by name) or every type of categories, from another open model
                    string from = op.Value<string>("from") ?? throw new InvalidOperationException("copy_types needs from (the other open model's title)");
                    Document src = doc.Application.Documents.Cast<Document>().FirstOrDefault(d => string.Equals(d.Title, from, StringComparison.OrdinalIgnoreCase)) ?? throw new InvalidOperationException($"{from} isn't open");
                    var names = (op["names"] as JArray)?.Select(x => x.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
                    var cats = op["categories"] != null ? Categories(src, op["categories"]).ToHashSet() : null;
                    var ids = new FilteredElementCollector(src).WhereElementIsElementType().Where(t => (names == null || names.Contains(t.Name)) && (cats == null || (t.Category != null && cats.Contains(t.Category.Id)))).Select(t => t.Id).ToList();
                    if (ids.Count == 0) throw new InvalidOperationException("no types match in the other model");
                    var opts = new CopyPasteOptions(); opts.SetDuplicateTypeNamesHandler(new KeepTypes());
                    created.AddRange(ElementTransformUtils.CopyElements(src, ids, doc, Transform.Identity, opts));
                    return new JObject { ["copied"] = created.Count };
                }
                case "keynote_file":
                {
                    string path = op.Value<string>("path") ?? throw new InvalidOperationException("keynote_file needs path");
                    var r = ExternalResourceReference.CreateLocalResource(doc, ExternalResourceTypes.BuiltInExternalResourceTypes.KeynoteTable, ModelPathUtils.ConvertUserVisiblePathToModelPath(path), PathType.Absolute);
                    KeynoteTable.GetKeynoteTable(doc).LoadFrom(r, new KeyBasedTreeEntriesLoadResults());
                    return new JObject { ["keynotes"] = path };
                }
                default: return null;
            }
        }

        private static void Style(Document doc, Category c, JObject op)
        {
            if (op["weight"] != null) c.SetLineWeight(op.Value<int>("weight"), GraphicsStyleType.Projection);
            if (op["cut_weight"] != null) c.SetLineWeight(op.Value<int>("cut_weight"), GraphicsStyleType.Cut);
            if (op["color"] is JArray col) c.LineColor = new Color((byte)col[0].Value<int>(), (byte)col[1].Value<int>(), (byte)col[2].Value<int>());
            if (op["pattern"] != null)
            {
                ElementId lp = LinePatternElement.GetLinePatternElementByName(doc, op.Value<string>("pattern"))?.Id ?? throw new InvalidOperationException($"no line pattern {op.Value<string>("pattern")}");
                c.SetLinePatternId(lp, GraphicsStyleType.Projection);
            }
        }

        private sealed class KeepTypes : IDuplicateTypeNamesHandler
        {
            public DuplicateTypeAction OnDuplicateTypeNamesFound(DuplicateTypeNamesHandlerArgs args) => DuplicateTypeAction.UseDestinationTypes;
        }
    }
}
