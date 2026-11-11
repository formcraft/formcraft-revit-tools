using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's MEP and site ops (owner 26 Oct, tools group 5): duct, pipe (or placeholders), flex_duct, flex_pipe,
    /// cable_tray, conduit, connect (elbow, tee or transition between two or three runs), insulation, lining,
    /// convert_placeholders, wire, space, space_separation, toposolid, toposolid_subdivision, mass_floors, wall_by_face,
    /// curtain_system_by_face. Run points are [x, y, z] in mm, z above the level.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private JObject MepOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "duct":
                case "pipe":
                case "cable_tray":
                case "conduit":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var pts = Points(op["points_mm"], $"{name} needs points_mm, the run [[x, y, z], ...]").Select(p => p + new XYZ(0, 0, level.Elevation)).ToList();
                    bool placeholder = op.Value<bool?>("placeholder") ?? false;
                    var segs = new List<MEPCurve>();
                    for (int i = 0; i + 1 < pts.Count; i++)
                    {
                        MEPCurve c;
                        switch (name)
                        {
                            case "duct":
                            {
                                ElementId sys = SystemType<MechanicalSystemType>(doc, op), t = CurveType<DuctType>(doc, op);
                                c = placeholder ? Duct.CreatePlaceholder(doc, sys, t, level.Id, pts[i], pts[i + 1]) : Duct.Create(doc, sys, t, level.Id, pts[i], pts[i + 1]);
                                break;
                            }
                            case "pipe":
                            {
                                ElementId sys = SystemType<PipingSystemType>(doc, op), t = CurveType<PipeType>(doc, op);
                                c = placeholder ? Pipe.CreatePlaceholder(doc, sys, t, level.Id, pts[i], pts[i + 1]) : Pipe.Create(doc, sys, t, level.Id, pts[i], pts[i + 1]);
                                break;
                            }
                            case "cable_tray": c = CableTray.Create(doc, CurveType<CableTrayType>(doc, op), pts[i], pts[i + 1], level.Id); break;
                            default: c = Conduit.Create(doc, CurveType<ConduitType>(doc, op), pts[i], pts[i + 1], level.Id); break;
                        }
                        Size(c, op);
                        segs.Add(c); created.Add(c.Id);
                    }
                    // elbows at the corners, unless elbows false
                    if (!placeholder && (op.Value<bool?>("elbows") ?? true))
                        for (int i = 0; i + 1 < segs.Count; i++)
                        {
                            var (a, b) = Nearest(segs[i], segs[i + 1]);
                            try { created.Add(doc.Create.NewElbowFitting(a, b).Id); } catch (Exception) { /* no elbow in the routing preferences: left unjoined */ }
                        }
                    return new JObject { ["segments"] = segs.Count };
                }
                case "flex_duct":
                case "flex_pipe":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var pts = Points(op["points_mm"], $"{name} needs points_mm").Select(p => p + new XYZ(0, 0, level.Elevation)).ToList();
                    Element f = name == "flex_duct"
                        ? (Element)FlexDuct.Create(doc, SystemType<MechanicalSystemType>(doc, op), CurveType<FlexDuctType>(doc, op), level.Id, pts)
                        : FlexPipe.Create(doc, SystemType<PipingSystemType>(doc, op), CurveType<FlexPipeType>(doc, op), level.Id, pts);
                    created.Add(f.Id);
                    return new JObject { [name] = f.Id.Value };
                }
                case "connect":
                {
                    // ids: two runs (elbow, or transition when they're in line) or three (tee: the first two in line).
                    // A plumbing fixture is a family instance: the nearest unconnected connector of the same domain,
                    // and the same system classification where that classification is set.
                    var ids = Targets(doc, op, made).Select(id => doc.GetElement(id) ?? throw new InvalidOperationException($"{id.Value} isn't in this model")).ToList();
                    if (ids.Count != 2 && ids.Count != 3) throw new InvalidOperationException("connect needs two or three ids");
                    FamilyInstance fixture = ids.OfType<FamilyInstance>().FirstOrDefault(fi => fi.MEPModel?.ConnectorManager != null);
                    if (fixture == null)
                    {
                        var curves = ids.Select(e => e as MEPCurve ?? throw new InvalidOperationException($"{e.Id.Value} isn't a duct, pipe, tray or conduit")).ToList();
                        FamilyInstance fit;
                        if (curves.Count == 3)
                        {
                            var (a, b) = Nearest(curves[0], curves[1]); var c = Nearest(curves[2], curves[0]).Item1;
                            fit = doc.Create.NewTeeFitting(a, b, c);
                        }
                        else if (curves.Count == 2)
                        {
                            var (a, b) = Nearest(curves[0], curves[1]);
                            bool inLine = a.CoordinateSystem.BasisZ.IsAlmostEqualTo(b.CoordinateSystem.BasisZ.Negate());
                            fit = inLine ? doc.Create.NewTransitionFitting(a, b) : doc.Create.NewElbowFitting(a, b);
                        }
                        else throw new InvalidOperationException("connect needs two or three ids");
                        created.Add(fit.Id);
                        return new JObject { ["fitting"] = fit.Id.Value };
                    }
                    if (ids.Count != 2) throw new InvalidOperationException("[FMC-CONNECT] A fixture connect needs two ids: the pipe and the fixture. Three ids is a tee of ducts, pipes, trays or conduits. Fix: pass the pipe and the basin or WC.");
                    Element run = ids.FirstOrDefault(e => e.Id != fixture.Id && e is MEPCurve);
                    if (run == null) throw new InvalidOperationException($"[FMC-CONNECT] {fixture.Id.Value} needs a duct, pipe, tray or conduit beside it. Fix: pass the pipe id and the fixture id.");
                    return ConnectFixture(doc, (MEPCurve)run, fixture, op.Value<string>("system"), created);
                }
                case "insulation":
                case "lining":
                {
                    double t = Ft(op.Value<double?>("thickness_mm") ?? 25);
                    foreach (ElementId id in Targets(doc, op, made))
                    {
                        Element e = doc.GetElement(id);
                        Element made2 = name == "lining"
                            ? DuctLining.Create(doc, id, new FilteredElementCollector(doc).OfClass(typeof(DuctLiningType)).FirstElementId(), t)
                            : e is Pipe || e.Category?.Id.Value == (long)BuiltInCategory.OST_PipeFitting || e.Category?.Id.Value == (long)BuiltInCategory.OST_PipeAccessory
                                ? (Element)PipeInsulation.Create(doc, id, new FilteredElementCollector(doc).OfClass(typeof(PipeInsulationType)).FirstElementId(), t)
                                : DuctInsulation.Create(doc, id, new FilteredElementCollector(doc).OfClass(typeof(DuctInsulationType)).FirstElementId(), t);
                        created.Add(made2.Id);
                    }
                    return new JObject { [name] = created.Count };
                }
                case "convert_placeholders":
                {
                    var ids = Targets(doc, op, made);
                    var ducts = ids.Where(i => doc.GetElement(i) is Duct).ToList(); var pipes = ids.Where(i => doc.GetElement(i) is Pipe).ToList();
                    if (ducts.Count > 0) created.AddRange(MechanicalUtils.ConvertDuctPlaceholders(doc, ducts));
                    if (pipes.Count > 0) created.AddRange(PlumbingUtils.ConvertPipePlaceholders(doc, pipes));
                    return new JObject { ["converted"] = ducts.Count + pipes.Count };
                }
                case "wire":
                {
                    View v = ViewOf(doc, op["view"], made);
                    var pts = Points(op["points_mm"], "wire needs points_mm in the plan");
                    var types = new FilteredElementCollector(doc).OfClass(typeof(WireType)).ToElementIds();
                    var kind = (op.Value<string>("style") ?? "arc") switch { "chamfer" => WiringType.Chamfer, _ => WiringType.Arc };
                    Wire w = Wire.Create(doc, TypeFor(doc, op, types, types.First()), v.Id, kind, pts, null, null);
                    created.Add(w.Id);
                    return new JObject { ["wire"] = w.Id.Value };
                }
                case "space":
                {
                    Level level = LevelOf(doc, op["level"]);
                    var ids = new JArray();
                    foreach (JArray p in PointList(op))
                    {
                        XYZ at = Vec(p, "points_mm are [x, y]");
                        Space s = doc.Create.NewSpace(level, new UV(at.X, at.Y));
                        if (op["name"] != null) s.Name = op.Value<string>("name");
                        created.Add(s.Id); ids.Add(s.Id.Value);
                    }
                    return new JObject { ["spaces"] = ids };
                }
                case "space_separation":
                {
                    Level level = LevelOf(doc, op["level"]);
                    View plan = PlanOf(doc, op["level"]);
                    var lines = new CurveArray();
                    foreach (JArray seg in (op["lines_mm"] as JArray ?? throw new InvalidOperationException("space_separation needs lines_mm")).OfType<JArray>())
                    {
                        var p = Points(seg, "each line is [[x, y], [x, y]]");
                        lines.Append(Line.CreateBound(new XYZ(p[0].X, p[0].Y, level.Elevation), new XYZ(p[1].X, p[1].Y, level.Elevation)));
                    }
                    var made2 = doc.Create.NewSpaceBoundaryLines(SketchPlane.Create(doc, level.Id), lines, plan);
                    foreach (ModelCurve c in made2) created.Add(c.Id);
                    return new JObject { ["lines"] = made2.Size };
                }
                case "toposolid":
                {
                    // points_mm: survey points [x, y, z]; or outline_mm (flat) at the level; type_name optional
                    Level level = LevelOf(doc, op["level"]);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(ToposolidType)).ToElementIds();
                    ElementId t = TypeFor(doc, op, types, types.FirstOrDefault() ?? throw new InvalidOperationException("the model has no toposolid type"));
                    Toposolid ts;
                    if (op["points_mm"] != null)
                    {
                        var pts = Points(op["points_mm"], "points_mm are [x, y, z]");
                        ts = op["outline_mm"] != null ? Toposolid.Create(doc, Loops(op), pts, t, level.Id) : Toposolid.Create(doc, pts, t, level.Id);
                    }
                    else ts = Toposolid.Create(doc, Loops(op), t, level.Id);
                    created.Add(ts.Id);
                    return new JObject { ["toposolid"] = ts.Id.Value };
                }
                case "toposolid_subdivision":
                {
                    var ts = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("toposolid_subdivision needs host (the toposolid)")) as Toposolid ?? throw new InvalidOperationException("host isn't a toposolid");
                    Toposolid sub = ts.CreateSubDivision(doc, Loops(op));
                    if (op["material"] != null) sub.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.Set(MaterialId(doc, op.Value<string>("material")));
                    created.Add(sub.Id);
                    return new JObject { ["subdivision"] = sub.Id.Value };
                }
                case "mass_floors":
                {
                    // ids: masses; levels: the levels to slice them at
                    var levels = (op["levels"] as JArray ?? throw new InvalidOperationException("mass_floors needs levels")).Select(l => LevelOf(doc, l).Id).ToList();
                    int n = 0;
                    foreach (ElementId m in Targets(doc, op, made)) foreach (ElementId l in levels) { MassInstanceUtils.AddMassLevelDataToMassInstance(doc, m, l); n++; }
                    return new JObject { ["mass_floors"] = n };
                }
                case "wall_by_face":
                {
                    // the face of a mass (or generic model) facing point_mm
                    Element host = doc.GetElement(Ref(doc, op["host"], made) ?? throw new InvalidOperationException("wall_by_face needs host (a mass)"));
                    var types = new FilteredElementCollector(doc).OfClass(typeof(WallType)).ToElementIds();
                    Reference face = FaceNear(host, Vec(op["point_mm"], "wall_by_face needs point_mm on or near the face"));
                    FaceWall fw = FaceWall.Create(doc, TypeFor(doc, op, types, types.First()), WallLocationLine.CoreCenterline, face);
                    created.Add(fw.Id);
                    return new JObject { ["wall"] = fw.Id.Value };
                }
                default: return null;
            }
        }

        private static void Size(MEPCurve c, JObject op)
        {
            if (op["diameter_mm"] != null)
                (c.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM))?.Set(Ft(op.Value<double>("diameter_mm")));
            if (op["width_mm"] != null) (c.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CABLETRAY_WIDTH_PARAM))?.Set(Ft(op.Value<double>("width_mm")));
            if (op["height_mm"] != null) (c.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM) ?? c.get_Parameter(BuiltInParameter.RBS_CABLETRAY_HEIGHT_PARAM))?.Set(Ft(op.Value<double>("height_mm")));
        }

        /// <summary>One millimetre, in feet. Connectors closer than this are coincident; two fixture connectors this close are ambiguous.</summary>
        private const double ConnectMm = 1.0 / 304.8;

        /// <summary>
        /// Joins a pipe (or other run) to a fixture's nearest unconnected connector. Domain must match.
        /// System classification must match where it is set (sanitary for waste and soil, domestic hot or cold for supply).
        /// Coincident ends use ConnectTo. A gap on a pipe becomes one new pipe of the same type, system and level.
        /// A failure throws, and the batch's transaction rolls the whole step back.
        /// </summary>
        private JObject ConnectFixture(Document doc, MEPCurve run, FamilyInstance fixture, string system, List<ElementId> created)
        {
            Domain domain = run is Pipe || run is FlexPipe ? Domain.DomainPiping
                : run is Duct || run is FlexDuct ? Domain.DomainHvac
                : Domain.DomainCableTrayConduit;
            var pipeEnds = OpenEnds(run, domain);
            if (pipeEnds.Count == 0) throw new InvalidOperationException($"[FMC-CONNECT] {run.Id.Value} has no open end. Fix: pass the open pipe, not one that is already connected at both ends.");
            if (fixture.MEPModel?.ConnectorManager == null) throw new InvalidOperationException($"{fixture.Id.Value} isn't a duct, pipe, tray or conduit");
            var fixtureEnds = OpenEnds(fixture, domain);
            string pipeClass = SystemOf(pipeEnds[0]);
            List<string> accept = AcceptSystems(system);
            if (accept != null && !SystemUnset(pipeClass) && !accept.Contains(pipeClass))
                throw new InvalidOperationException($"[FMC-CONNECT] Pipe {run.Id.Value} is {pipeClass}, which is not {string.Join(" or ", accept)}. Fix: pass the system that matches this pipe (sanitary for waste and soil, domestic cold or domestic hot for supply).");
            var matches = new List<Connector>();
            foreach (Connector c in fixtureEnds)
            {
                string cls = SystemOf(c);
                if (accept != null) { if (accept.Contains(cls)) matches.Add(c); }
                else if (SystemUnset(pipeClass) || SystemUnset(cls) || cls == pipeClass) matches.Add(c);
            }
            if (accept == null && SystemUnset(pipeClass))
            {
                var distinct = matches.Select(SystemOf).Where(s => !SystemUnset(s)).Distinct().ToList();
                if (distinct.Count > 1)
                    throw new InvalidOperationException("[FMC-CONNECT] The pipe system is unset and the fixture has more than one piping connector (" + string.Join(", ", distinct) + "). Fix: pass system as sanitary (waste or soil), domestic cold (supply), or domestic hot (supply).");
            }
            if (matches.Count == 0)
                throw new InvalidOperationException($"[FMC-CONNECT] {fixture.Id.Value} has no unconnected {domain} connector for {(accept == null ? (SystemUnset(pipeClass) ? "the pipe" : pipeClass) : string.Join(" or ", accept))}. Fix: a basin has sanitary waste plus domestic hot and cold; a WC has sanitary soil plus domestic cold. Pass system to name which one.");
            var ranked = new List<Tuple<Connector, Connector, double>>();
            foreach (Connector f in matches)
            {
                Connector end = null; double d = double.MaxValue;
                foreach (Connector p in pipeEnds) { double dd = f.Origin.DistanceTo(p.Origin); if (dd < d) { d = dd; end = p; } }
                ranked.Add(Tuple.Create(f, end, d));
            }
            Tuple<Connector, Connector, double> first = null, second = null;
            foreach (var row in ranked)
            {
                if (first == null || row.Item3 < first.Item3) { second = first; first = row; }
                else if (second == null || row.Item3 < second.Item3) second = row;
            }
            if (second != null && Math.Abs(first.Item3 - second.Item3) <= ConnectMm)
                throw new InvalidOperationException("[FMC-CONNECT] " + fixture.Id.Value + " has " + matches.Count + " compatible unconnected connectors and the nearest two are the same distance. Fix: pass system as sanitary, domestic hot, or domestic cold so only one connector matches.");
            Connector bestFix = first.Item1, bestPipe = first.Item2; double best = first.Item3;
            string how;
            long made = 0;
            if (best <= ConnectMm)
            {
                bestPipe.ConnectTo(bestFix);
                how = "connect_to";
            }
            else if (run is Pipe pipe)
            {
                ElementId levelId = pipe.ReferenceLevel?.Id ?? pipe.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM)?.AsElementId() ?? ElementId.InvalidElementId;
                ElementId sysId = pipe.get_Parameter(BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM)?.AsElementId() ?? ElementId.InvalidElementId;
                if (levelId == ElementId.InvalidElementId) throw new InvalidOperationException($"[FMC-CONNECT] Pipe {pipe.Id.Value} has no level. Fix: set the pipe's reference level, then connect again.");
                if (sysId == ElementId.InvalidElementId) throw new InvalidOperationException($"[FMC-CONNECT] Pipe {pipe.Id.Value} has no piping system type. Fix: set the pipe's system (sanitary, domestic cold, or domestic hot), then connect again.");
                Pipe link;
                try { link = Pipe.Create(doc, sysId, pipe.PipeType.Id, levelId, bestPipe.Origin, bestFix.Origin); }
                catch (Exception ex) { throw new InvalidOperationException($"[FMC-CONNECT] The connectors are {Math.Round(best * 304.8, 1)} mm apart and Revit did not create the connecting pipe ({ex.Message}). Fix: move the pipe end onto the fixture connector, or leave a longer gap, then connect again."); }
                created.Add(link.Id); made = link.Id.Value;
                try
                {
                    Parameter fromKey = pipe.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
                    Parameter toKey = link.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
                    if (fromKey != null && toKey != null && !toKey.IsReadOnly && fromKey.HasValue) toKey.Set(fromKey.AsString() ?? "");
                }
                catch (Exception) { /* the pipe's keynote stays on the type when the instance has none */ }
                Connector a = null, b = null;
                foreach (Connector c in link.ConnectorManager.Connectors)
                {
                    if (c.Origin.DistanceTo(bestPipe.Origin) <= ConnectMm) a = c;
                    if (c.Origin.DistanceTo(bestFix.Origin) <= ConnectMm) b = c;
                }
                if (a == null || b == null) throw new InvalidOperationException("[FMC-CONNECT] The new pipe's ends did not land on the open connectors. Nothing is kept: this error rolls the batch back.");
                a.ConnectTo(bestPipe); b.ConnectTo(bestFix);
                how = "pipe";
            }
            else
            {
                bool inLine = bestPipe.CoordinateSystem.BasisZ.IsAlmostEqualTo(bestFix.CoordinateSystem.BasisZ.Negate());
                FamilyInstance fit = inLine ? doc.Create.NewTransitionFitting(bestPipe, bestFix) : doc.Create.NewElbowFitting(bestPipe, bestFix);
                created.Add(fit.Id); made = fit.Id.Value;
                how = inLine ? "transition" : "elbow";
            }
            return new JObject { ["connected"] = true, ["how"] = how, ["fixture"] = fixture.Id.Value, ["pipe"] = run.Id.Value, ["system"] = SystemOf(bestFix), ["made"] = made };
        }

        private static List<Connector> OpenEnds(Element e, Domain domain)
        {
            var list = new List<Connector>();
            ConnectorManager cm = e is MEPCurve mc ? mc.ConnectorManager : (e as FamilyInstance)?.MEPModel?.ConnectorManager;
            if (cm == null) return list;
            foreach (Connector c in cm.Connectors)
            {
                if (c.ConnectorType != ConnectorType.End || c.Domain != domain) continue;
                try { if (c.IsConnected) continue; } catch (InvalidOperationException) { continue; }
                list.Add(c);
            }
            return list;
        }

        private static string SystemOf(Connector c)
        {
            try
            {
                if (c.Domain == Domain.DomainPiping) return c.PipeSystemType.ToString();
                if (c.Domain == Domain.DomainHvac) return c.DuctSystemType.ToString();
            }
            catch (Exception) { /* a connector with no system type is unset */ }
            return "";
        }

        private static bool SystemUnset(string s) => s == "" || s == "UndefinedSystemType" || s == "Fitting" || s == "Global" || s == "OtherPipe" || s == "OtherAir";

        /// <summary>Null when the caller left system out: match the classification only where the connector has one.</summary>
        private static List<string> AcceptSystems(string system)
        {
            if (string.IsNullOrWhiteSpace(system)) return null;
            string s = system.Trim().ToLowerInvariant().Replace("_", " ").Replace("-", " ");
            if (s == "sanitary" || s == "waste" || s == "soil") return new List<string> { "Sanitary" };
            if (s == "supply") return new List<string> { "DomesticHotWater", "DomesticColdWater" };
            if (s == "domestic hot" || s == "domestic hot water" || s == "hot" || s == "dhw" || s == "hot supply" || s == "supply hot") return new List<string> { "DomesticHotWater" };
            if (s == "domestic cold" || s == "domestic cold water" || s == "cold" || s == "dcw" || s == "cold supply" || s == "supply cold") return new List<string> { "DomesticColdWater" };
            throw new InvalidOperationException("[FMC-CONNECT] Unknown system \"" + system + "\". Fix: pass sanitary (waste or soil), supply, domestic hot, or domestic cold.");
        }

        private static (Connector, Connector) Nearest(MEPCurve a, MEPCurve b)
        {
            Connector best1 = null, best2 = null; double d = double.MaxValue;
            foreach (Connector x in a.ConnectorManager.Connectors)
                foreach (Connector y in b.ConnectorManager.Connectors)
                {
                    double dd = x.Origin.DistanceTo(y.Origin);
                    if (dd < d) { d = dd; best1 = x; best2 = y; }
                }
            return (best1, best2);
        }

        private static ElementId SystemType<T>(Document doc, JObject op) where T : Element
        {
            var all = new FilteredElementCollector(doc).OfClass(typeof(T)).ToElementIds();
            if (all.Count == 0) throw new InvalidOperationException($"the model has no {typeof(T).Name}");
            return TypeFor(doc, new JObject { ["type_name"] = op["system"] }, all, all.First());
        }

        private static ElementId CurveType<T>(Document doc, JObject op) where T : ElementType => TypeOf<T>(doc, op);

        private static Reference FaceNear(Element e, XYZ p)
        {
            var opt = new Options { ComputeReferences = true };
            Reference best = null; double d = double.MaxValue;
            foreach (Solid s in Solids(e.get_Geometry(opt)))
                foreach (Face f in s.Faces)
                {
                    IntersectionResult r = f.Project(p);
                    if (r != null && r.Distance < d && f.Reference != null) { d = r.Distance; best = f.Reference; }
                }
            return best ?? throw new InvalidOperationException($"no face of {e.Id.Value} near that point");
        }
    }
}
