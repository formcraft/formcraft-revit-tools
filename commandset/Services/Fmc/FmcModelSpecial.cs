using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.DB.Structure;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's specialist ops (owner 26 Oct): structural_connection, boundary_condition, analytical_panel,
    /// load_combination, multi_rebar_annotation, rebar_coupler, rebar_shape_bar, rebar_cover_type, fabric_sheet,
    /// truss_chord, mep_connector (families), load_classification, demand_factor, mep_settings, check_systems,
    /// radial_dimension / diameter_dimension (families), align.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject SpecialOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "structural_connection":
                {
                    // ids: the beams and columns it joins; type_name: a structural connection type (Revit's or the steel library's)
                    var types = new FilteredElementCollector(doc).OfClass(typeof(StructuralConnectionHandlerType)).ToElementIds();
                    ElementId t = TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException("the model has no structural connection type"));
                    var h = StructuralConnectionHandler.Create(doc, Targets(doc, op, made).ToList(), t);
                    created.Add(h.Id);
                    return new JObject { ["connection"] = h.Id.Value };
                }
                case "boundary_condition":
                {
                    // host: an analytical member (point at its start or end, or line) or panel (area); fixity: fixed|pinned|roller
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("boundary_condition needs host (analytical member or panel)"));
                    string fix = op.Value<string>("fixity") ?? "pinned";
                    var F = TranslationRotationValue.Fixed; var R = TranslationRotationValue.Release;
                    var rot = fix == "fixed" ? F : R; var tz = F; var txy = fix == "roller" ? R : F;
                    Element bc;
                    string kind = op.Value<string>("kind") ?? (host is AnalyticalPanel ? "area" : "point");
                    if (kind == "area") bc = doc.Create.NewAreaBoundaryConditions(host, txy, 0, txy, 0, tz, 0);
                    else if (kind == "line") bc = doc.Create.NewLineBoundaryConditions(host, txy, 0, txy, 0, tz, 0, rot, 0);
                    else
                    {
                        var m = host as AnalyticalMember ?? throw new InvalidOperationException("a point condition needs an analytical member host");
                        var sel = (op.Value<string>("end") ?? "start") == "end" ? AnalyticalCurveSelector.EndPoint : AnalyticalCurveSelector.StartPoint;
                        Reference r = m.GetReference(new AnalyticalModelSelector(m.GetCurve(), sel));
                        bc = doc.Create.NewPointBoundaryConditions(r, txy, 0, txy, 0, tz, 0, rot, 0, rot, 0, rot, 0);
                    }
                    created.Add(bc.Id);
                    return new JObject { ["boundary_condition"] = bc.Id.Value, ["fixity"] = fix };
                }
                case "analytical_panel":
                {
                    var loop = Loops(op)[0];
                    var p = AnalyticalPanel.Create(doc, loop);
                    created.Add(p.Id);
                    return new JObject { ["panel"] = p.Id.Value };
                }
                case "load_combination":
                {
                    // cases: [{case, factor}]
                    var lc = LoadCombination.Create(doc, op.Value<string>("name") ?? throw new InvalidOperationException("load_combination needs name"));
                    var comps = (op["cases"] as JArray ?? throw new InvalidOperationException("load_combination needs cases [{case, factor}]")).OfType<JObject>().Select(c =>
                        new LoadComponent(new FilteredElementCollector(doc).OfClass(typeof(LoadCase)).FirstOrDefault(x => string.Equals(x.Name, c.Value<string>("case"), StringComparison.OrdinalIgnoreCase))?.Id
                            ?? throw new InvalidOperationException($"no load case {c.Value<string>("case")}"), c.Value<double?>("factor") ?? 1)).ToList();
                    lc.SetComponents(comps);
                    created.Add(lc.Id);
                    return new JObject { ["combination"] = lc.Id.Value, ["cases"] = comps.Count };
                }
                case "multi_rebar_annotation":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(MultiReferenceAnnotationType)).Cast<MultiReferenceAnnotationType>().ToList();
                    var mt = types.FirstOrDefault(x => x.Name == op.Value<string>("type_name")) ?? types.FirstOrDefault() ?? throw new InvalidOperationException("the model has no multi-rebar annotation type");
                    var o = new MultiReferenceAnnotationOptions(mt);
                    o.SetElementsToDimension(Targets(doc, op, made, allowPinned: true).ToList());
                    XYZ at = Vec(op["point_mm"], "multi_rebar_annotation needs point_mm (where the dimension line goes)");
                    o.DimensionLineOrigin = at; o.DimensionLineDirection = op["direction_mm"] != null ? Vec(op["direction_mm"], "direction_mm").Normalize() : v.RightDirection;
                    o.DimensionPlaneNormal = v.ViewDirection; o.TagHeadPosition = at + v.UpDirection * Ft(500); o.TagHasLeader = true;
                    var a = MultiReferenceAnnotation.Create(doc, v.Id, o);
                    created.Add(a.Id);
                    return new JObject { ["annotation"] = a.Id.Value };
                }
                case "rebar_coupler":
                {
                    var types = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Coupler).WhereElementIsElementType().ToElementIds();
                    ElementId t = TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException("load a coupler family first"));
                    ElementId bar = Ref(doc, op["id"], made) ?? throw new InvalidOperationException("rebar_coupler needs id (the rebar)");
                    var c = RebarCoupler.Create(doc, t, RebarReinforcementData.Create(bar, op.Value<int?>("end") ?? 0), null, out RebarCouplerError err);
                    if (c == null) throw new InvalidOperationException($"Revit couldn't place the coupler: {err}");
                    created.Add(c.Id);
                    return new JObject { ["coupler"] = c.Id.Value };
                }
                case "rebar_shape_bar":
                {
                    // a bar from a rebar shape (e.g. 00, 21, M_T1) in host at origin_mm, x_dir / y_dir its plane
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("rebar_shape_bar needs host"));
                    var shape = new FilteredElementCollector(doc).OfClass(typeof(RebarShape)).Cast<RebarShape>().FirstOrDefault(s => s.Name == op.Value<string>("shape")) ?? throw new InvalidOperationException($"no rebar shape {op.Value<string>("shape")}");
                    var barTypes = new FilteredElementCollector(doc).OfClass(typeof(RebarBarType)).ToElementIds();
                    var bt = (RebarBarType)doc.GetElement(TypeFor(doc, new JObject { ["type_name"] = op["bar_type"] }, barTypes, barTypes.First()));
                    var r = Rebar.CreateFromRebarShape(doc, shape, bt, host, Vec(op["origin_mm"], "rebar_shape_bar needs origin_mm"),
                        op["x_dir"] != null ? Vec(op["x_dir"], "x_dir").Normalize() : XYZ.BasisX, op["y_dir"] != null ? Vec(op["y_dir"], "y_dir").Normalize() : XYZ.BasisZ);
                    created.Add(r.Id);
                    return new JObject { ["rebar"] = r.Id.Value };
                }
                case "rebar_cover_type":
                {
                    var c = RebarCoverType.Create(doc, op.Value<string>("name") ?? throw new InvalidOperationException("rebar_cover_type needs name"), Ft(op.Value<double?>("cover_mm") ?? 40));
                    created.Add(c.Id);
                    return new JObject { ["cover_type"] = c.Id.Value };
                }
                case "fabric_sheet":
                {
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("fabric_sheet needs host"));
                    var types = new FilteredElementCollector(doc).OfClass(typeof(FabricSheetType)).ToElementIds();
                    var fs = FabricSheet.Create(doc, host, TypeFor(doc, op, types, types.First()));
                    created.Add(fs.Id);
                    return new JObject { ["fabric_sheet"] = fs.Id.Value };
                }
                case "truss_chord":
                {
                    var tr = doc.GetElement(Ref(doc, op["truss"], made)) as Truss ?? throw new InvalidOperationException("truss_chord needs truss");
                    Element target = doc.GetElement(Ref(doc, op["target"], made) ?? throw new InvalidOperationException("truss_chord needs target (a roof or floor)"));
                    tr.AttachChord(target, (op.Value<string>("chord") ?? "top") == "bottom" ? TrussChordLocation.Bottom : TrussChordLocation.Top, op.Value<bool?>("unlock_profile") ?? false);
                    return new JObject { ["attached"] = target.Id.Value };
                }
                case "mep_connector":
                {
                    // families: a connector on the face of a form nearest point_mm; kind duct|pipe|electrical|cable_tray|conduit
                    Fam(doc, name);
                    Element form = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("mep_connector needs host (a form)"));
                    Reference face = FaceNear(form, Vec(op["point_mm"], "mep_connector needs point_mm on the face"));
                    string kind = op.Value<string>("kind") ?? "pipe";
                    ConnectorElement c = kind switch
                    {
                        "duct" => ConnectorElement.CreateDuctConnector(doc, (DuctSystemType)Enum.Parse(typeof(DuctSystemType), op.Value<string>("system") ?? "SupplyAir", true),
                            (op.Value<string>("shape") ?? "round") == "rectangular" ? ConnectorProfileType.Rectangular : ConnectorProfileType.Round, face),
                        "electrical" => ConnectorElement.CreateElectricalConnector(doc, (ElectricalSystemType)Enum.Parse(typeof(ElectricalSystemType), op.Value<string>("system") ?? "PowerCircuit", true), face),
                        "cable_tray" => ConnectorElement.CreateCableTrayConnector(doc, face),
                        "conduit" => ConnectorElement.CreateConduitConnector(doc, face),
                        _ => ConnectorElement.CreatePipeConnector(doc, (PipeSystemType)Enum.Parse(typeof(PipeSystemType), op.Value<string>("system") ?? "DomesticColdWater", true), face),
                    };
                    created.Add(c.Id);
                    return new JObject { ["connector"] = c.Id.Value, ["kind"] = kind };
                }
                case "load_classification":
                {
                    var lc = ElectricalLoadClassification.Create(doc, op.Value<string>("name") ?? throw new InvalidOperationException("load_classification needs name"));
                    created.Add(lc.Id);
                    return new JObject { ["load_classification"] = lc.Id.Value };
                }
                case "demand_factor":
                {
                    var df = ElectricalDemandFactorDefinition.Create(doc, op.Value<string>("name") ?? throw new InvalidOperationException("demand_factor needs name"));
                    if (op["settings"] is JObject st) Props(df, st);
                    created.Add(df.Id);
                    return new JObject { ["demand_factor"] = df.Id.Value };
                }
                case "mep_settings":
                {
                    // duct, pipe, electrical: {Property: value} on Revit's settings objects (names as in the API)
                    int n = 0;
                    if (op["duct"] is JObject d) n += Props(DuctSettings.GetDuctSettings(doc), d);
                    if (op["pipe"] is JObject p) n += Props(PipeSettings.GetPipeSettings(doc), p);
                    if (op["electrical"] is JObject e) n += Props(ElectricalSetting.GetElectricalSettings(doc), e);
                    if (op["reinforcement"] is JObject r) n += Props(ReinforcementSettings.GetReinforcementSettings(doc), r);
                    return new JObject { ["settings_changed"] = n };
                }
                case "check_systems":
                {
                    // Show Disconnects and Check Duct / Pipe Systems / Circuits: open connectors, and circuits with no panel; changes nothing
                    var open = new JArray();
                    foreach (Element el in new FilteredElementCollector(doc).WhereElementIsNotElementType().Where(x => x is MEPCurve || x is FamilyInstance))
                    {
                        ConnectorManager cm = el is MEPCurve mc ? mc.ConnectorManager : (el as FamilyInstance)?.MEPModel?.ConnectorManager;
                        if (cm == null) continue;
                        foreach (Connector c in cm.UnusedConnectors)
                            if (c.Domain != Domain.DomainUndefined && open.Count < 300)
                                open.Add(new JObject { ["id"] = el.Id.Value, ["category"] = el.Category?.Name, ["domain"] = c.Domain.ToString(), ["at_mm"] = new JArray(Math.Round(c.Origin.X * 304.8), Math.Round(c.Origin.Y * 304.8), Math.Round(c.Origin.Z * 304.8)) });
                    }
                    var noPanel = new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>().Where(s => s.BaseEquipment == null).Select(s => (JToken)s.Id.Value).ToList();
                    return new JObject { ["open_connectors"] = open, ["circuits_without_panel"] = new JArray(noPanel) };
                }
                case "radial_dimension":
                case "diameter_dimension":
                {
                    // families: on the arc edge of a form nearest point_mm
                    Fam(doc, name);
                    View v = op["view"] != null ? ViewOf(doc, op["view"], made) : doc.ActiveView;
                    Element form = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException($"{name} needs host (a form with an arc)"));
                    XYZ at = Vec(op["point_mm"], $"{name} needs point_mm near the arc");
                    Reference arc = ArcNear(form, at);
                    Dimension dim = name == "radial_dimension" ? doc.FamilyCreate.NewRadialDimension(v, arc, at) : doc.FamilyCreate.NewDiameterDimension(v, arc, at);
                    if (op["label"] != null) dim.FamilyLabel = doc.FamilyManager.get_Parameter(op.Value<string>("label"));
                    created.Add(dim.Id);
                    return new JObject { ["dimension"] = dim.Id.Value };
                }
                case "align":
                {
                    // locks two references together (reference planes, grids or levels)
                    View v = op["view"] != null ? ViewOf(doc, op["view"], made) : doc.ActiveView;
                    var refs = (op["refs"] as JArray ?? throw new InvalidOperationException("align needs refs [a, b]")).ToList();
                    Autodesk.Revit.Creation.ItemFactoryBase f = doc.IsFamilyDocument ? (Autodesk.Revit.Creation.ItemFactoryBase)doc.FamilyCreate : doc.Create;
                    Dimension d = f.NewAlignment(v, RefOf(doc, refs[0], made), RefOf(doc, refs[1], made));
                    created.Add(d.Id);
                    return new JObject { ["alignment"] = d.Id.Value };
                }
                default: return SteelOp(doc, name, op, made, created);
            }
        }

        /// <summary>Sets public properties by name (doubles, ints, bools, strings, enums) on a Revit settings object.</summary>
        private static int Props(object target, JObject values)
        {
            int n = 0;
            foreach (var kv in values)
            {
                PropertyInfo p = target.GetType().GetProperty(kv.Key, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase)
                    ?? throw new InvalidOperationException($"{target.GetType().Name} has no setting {kv.Key} (settings: {string.Join(", ", target.GetType().GetProperties().Where(x => x.CanWrite).Select(x => x.Name))})");
                if (!p.CanWrite) throw new InvalidOperationException($"{kv.Key} is read-only");
                object v = p.PropertyType.IsEnum ? Enum.Parse(p.PropertyType, kv.Value.ToString(), true) : kv.Value.ToObject(p.PropertyType);
                p.SetValue(target, v); n++;
            }
            return n;
        }

        private static Reference ArcNear(Element e, XYZ p)
        {
            var opt = new Options { ComputeReferences = true };
            Reference best = null; double d = double.MaxValue;
            foreach (Solid s in Solids(e.get_Geometry(opt)))
                foreach (Edge ed in s.Edges)
                    if (ed.AsCurve() is Arc a && ed.Reference != null)
                    {
                        double dd = a.Distance(p);
                        if (dd < d) { d = dd; best = ed.Reference; }
                    }
            return best ?? throw new InvalidOperationException($"{e.Id.Value} has no arc edge");
        }
    }
}
