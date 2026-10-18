using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// F-061: the host test for Gate A. In a new project that is never saved (opened in the background, closed in the end),
    /// a family is placed on a wall face or the underside of a ceiling the way a click places it (face based: the reference
    /// direction is Up × the face normal, so it lands upright), the host is moved (wall 500 mm out, ceiling 300 mm up) and
    /// the family must follow, keep its host, stay upright and have no connector pointing out of the host into the room.
    /// Never touches the person's documents.
    /// </summary>
    public partial class FmcFamilyEventHandler
    {
        private static double ToMm(double feet) => UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);

        private JObject HostTest(UIApplication app)
        {
            string path = Parameters.Value<string>("path") ?? throw new ArgumentException("path (the staged .rfa) is needed");
            if (!File.Exists(path)) throw new FileNotFoundException("No family at " + path);
            string host = (Parameters.Value<string>("host") ?? "wall").Trim().ToLowerInvariant();
            if (host != "wall" && host != "ceiling") throw new ArgumentException("host is wall or ceiling");

            var result = new JObject { ["family"] = Path.GetFileNameWithoutExtension(path), ["host"] = host };
            Document? doc = null;
            try
            {
                string template = app.Application.DefaultProjectTemplate ?? "";
                doc = File.Exists(template) ? app.Application.NewProjectDocument(template) : app.Application.NewProjectDocument(UnitSystem.Metric);
                result["project_template"] = File.Exists(template) ? Path.GetFileName(template) : "none (metric, no template)";
                using var t = new Transaction(doc, "FMC host test");
                var opts = t.GetFailureHandlingOptions();
                opts.SetFailuresPreprocessor(new SwallowWarnings());
                t.SetFailureHandlingOptions(opts);
                t.Start();

                Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).FirstOrDefault()
                              ?? Level.Create(doc, 0);
                if (!doc.LoadFamily(path, new OverwriteLoad(), out Family family) || family == null)
                    family = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                                 .FirstOrDefault(f => f.Name == Path.GetFileNameWithoutExtension(path)) ?? throw new InvalidOperationException("Could not load " + path);
                var symbol = family.GetFamilySymbolIds().Select(id => (FamilySymbol)doc.GetElement(id)).FirstOrDefault()
                             ?? throw new InvalidOperationException("The family has no types");
                if (!symbol.IsActive) symbol.Activate();
                result["placement"] = family.FamilyPlacementType.ToString();

                // the host: a 6 m wall 3 m high, or a 4 x 4 m ceiling at 2.7 m
                HostObject hostEl;
                if (host == "wall")
                {
                    var wall = Wall.Create(doc, Line.CreateBound(new XYZ(Mm(-3000), 0, 0), new XYZ(Mm(3000), 0, 0)), level.Id, false);
                    wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.Set(Mm(3000));
                    hostEl = wall;
                }
                else
                {
                    var type = new FilteredElementCollector(doc).OfClass(typeof(CeilingType)).FirstElementId();
                    if (type == ElementId.InvalidElementId)
                    {
                        t.RollBack();
                        result["state"] = "Not checked";
                        result["detail"] = "The project template has no ceiling type, so a ceiling host can't be made";
                        return result;
                    }
                    double h = Mm(2000);
                    var loop = CurveLoop.Create(new List<Curve>
                    {
                        Line.CreateBound(new XYZ(-h, -h, 0), new XYZ(h, -h, 0)), Line.CreateBound(new XYZ(h, -h, 0), new XYZ(h, h, 0)),
                        Line.CreateBound(new XYZ(h, h, 0), new XYZ(-h, h, 0)), Line.CreateBound(new XYZ(-h, h, 0), new XYZ(-h, -h, 0)),
                    });
                    var ceiling = Ceiling.Create(doc, new List<CurveLoop> { loop }, type, level.Id);
                    ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(Mm(2700));
                    hostEl = ceiling;
                }
                doc.Regenerate();

                // the face a person clicks: the wall's exterior side, the ceiling's underside
                Reference faceRef = host == "wall"
                    ? HostObjectUtils.GetSideFaces(hostEl, ShellLayerType.Exterior).First()
                    : HostObjectUtils.GetBottomFaces(hostEl).First();
                var face = hostEl.GetGeometryObjectFromReference(faceRef) as PlanarFace ?? throw new InvalidOperationException("The host's face isn't planar");
                BoundingBoxUV box = face.GetBoundingBox();
                XYZ at = face.Evaluate((box.Min + box.Max) / 2);
                XYZ normal = face.FaceNormal.Normalize();
                XYZ refDir = XYZ.BasisZ.CrossProduct(normal);
                if (refDir.GetLength() < 1e-6) refDir = XYZ.BasisX; // a horizontal face: any direction along it

                FamilyInstance inst;
                switch (family.FamilyPlacementType)
                {
                    case FamilyPlacementType.WorkPlaneBased:
                        inst = doc.Create.NewFamilyInstance(faceRef, at, refDir.Normalize(), symbol);
                        break;
                    case FamilyPlacementType.OneLevelBasedHosted:
                        inst = doc.Create.NewFamilyInstance(at, symbol, hostEl, level, StructuralType.NonStructural);
                        break;
                    default:
                        t.RollBack();
                        result["state"] = "Fail";
                        result["placed"] = false;
                        result["detail"] = $"{family.FamilyPlacementType}: the family doesn't host, so it can't be placed on a {host} " +
                                           "(use a face based template, which hosts on walls and ceilings, linked ones too)";
                        return result;
                }
                doc.Regenerate();
                result["placed"] = true;

                XYZ before = Origin(inst);
                XYZ move = host == "wall" ? normal.Multiply(Mm(500)) : XYZ.BasisZ.Multiply(Mm(300));
                if (host == "wall") ElementTransformUtils.MoveElement(doc, hostEl.Id, move);
                else
                {
                    var p = hostEl.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM);
                    p?.Set(p.AsDouble() + Mm(300));
                }
                doc.Regenerate();
                XYZ after = Origin(inst);
                double moved = ToMm(after.Subtract(before).DotProduct(move.Normalize())), expected = ToMm(move.GetLength());
                bool followed = Math.Abs(moved - expected) <= 1.0;
                bool hostKept = inst.Host?.Id == hostEl.Id;

                // upright: on a wall face the family's Y is world up; on a ceiling (or a wall-hosted family) its Z is vertical
                Transform tf = inst.GetTransform();
                bool upright = host == "wall" && family.FamilyPlacementType == FamilyPlacementType.WorkPlaneBased
                    ? tf.BasisY.Z > 0.99
                    : Math.Abs(tf.BasisZ.Z) > 0.99;

                // connectors: into the host (against the face normal), never out of it into the room
                XYZ faceNow = normal; // the face moved, it didn't turn
                var connectors = new JArray();
                bool connectorsOk = true;
                var cm = inst.MEPModel?.ConnectorManager;
                if (cm != null)
                    foreach (Connector c in cm.Connectors)
                    {
                        double dot = c.CoordinateSystem.BasisZ.DotProduct(faceNow);
                        string way = dot < -0.5 ? "into the host" : dot > 0.5 ? "out into the room" : "along the face";
                        if (dot > 0.5) connectorsOk = false;
                        connectors.Add(new JObject { ["domain"] = c.Domain.ToString(), ["points"] = way, ["dot"] = Math.Round(dot, 3) });
                    }
                t.RollBack();

                result["moved_mm"] = Math.Round(moved, 1);
                result["expected_mm"] = Math.Round(expected, 1);
                result["followed"] = followed;
                result["host_kept"] = hostKept;
                result["upright"] = upright;
                result["connectors"] = connectors;
                bool ok = followed && hostKept && upright && connectorsOk;
                result["state"] = ok ? "Pass" : "Fail";
                var why = new List<string>();
                if (!followed) why.Add($"moved {Math.Round(moved, 1)} mm when the {host} moved {Math.Round(expected)} mm");
                if (!hostKept) why.Add("lost its host");
                if (!upright) why.Add("not upright");
                if (!connectorsOk) why.Add("a connector points out of the host into the room");
                result["detail"] = ok
                    ? $"Placed on the {(host == "wall" ? "wall face" : "ceiling underside")}, followed a {Math.Round(expected)} mm {(host == "wall" ? "wall move" : "ceiling raise")}, upright" +
                      (connectors.Count > 0 ? $", {connectors.Count} connector(s) into the host or along it" : "")
                    : string.Join("; ", why);
                return result;
            }
            finally
            {
                // never saved: the test project is closed without saving whatever happened
                try { doc?.Close(false); } catch (Exception) { /* closing */ }
            }
        }

        private static XYZ Origin(FamilyInstance inst) =>
            inst.Location is LocationPoint lp ? lp.Point : inst.GetTransform().Origin;
    }
}
