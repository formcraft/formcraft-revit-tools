using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Steel;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's steel fabrication ops (owner 26 Oct), through Revit's Advance Steel API (the Steel Connections
    /// add-in): steel_plate, bolts, anchors, weld, shorten, notch, corner_fillet. The steel elements it acts on are
    /// structural framing, columns and steel plates (ids). Lengths in mm.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private static readonly string[] SteelOps = { "steel_plate", "bolts", "anchors", "weld", "shorten", "notch", "corner_fillet" };

        static FmcModelEditHandler()
        {
            // Revit loads the steel libraries from the Steel Connections folder; resolve them from there for this add-in too
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
            {
                string name = new AssemblyName(e.Name).Name;
                if (!name.StartsWith("AS") && !name.StartsWith("Autodesk.SteelConnections") && !name.StartsWith("DotNetRoots")) return null;
                string dir = Path.Combine(Path.GetDirectoryName(typeof(Document).Assembly.Location) ?? "", "AddIns", "SteelConnections");
                string f = Path.Combine(dir, name + ".dll");
                return File.Exists(f) ? Assembly.LoadFrom(f) : null;
            };
        }

        private JObject SteelOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            if (!SteelOps.Contains(name)) return null;
#if FMC_STEEL
            return FmcSteel.Run(doc, name, op, op["ids"] is JArray ? Targets(doc, op, made, allowPinned: true).ToList() : new List<ElementId>());
#else
            throw new InvalidOperationException("steel fabrication needs Revit's Steel Connections add-in (this build was made without it)");
#endif
        }
    }

#if FMC_STEEL
    internal static class FmcSteel
    {
        public static JObject Run(Document doc, string name, JObject op, List<ElementId> ids)
        {
            // Advance Steel works in mm in model coordinates
            Autodesk.AdvanceSteel.Geometry.Point3d P(JToken t) { var a = (JArray)t; return new Autodesk.AdvanceSteel.Geometry.Point3d(a[0].Value<double>(), a[1].Value<double>(), a.Count > 2 ? a[2].Value<double>() : 0); }
            Autodesk.AdvanceSteel.Geometry.Vector3d V(JToken t, double x, double y, double z) { var a = t as JArray; return a == null ? new Autodesk.AdvanceSteel.Geometry.Vector3d(x, y, z) : new Autodesk.AdvanceSteel.Geometry.Vector3d(a[0].Value<double>(), a[1].Value<double>(), a.Count > 2 ? a[2].Value<double>() : 0); }
            Autodesk.AdvanceSteel.CADAccess.FilerObject[] Steel() => ids.Select(id => Filer(doc, id)).ToArray();
            var location = (op.Value<string>("site") ?? "shop") == "site" ? Autodesk.AdvanceSteel.ConstructionTypes.AtomicElement.eAssemblyLocation.kOnSite : Autodesk.AdvanceSteel.ConstructionTypes.AtomicElement.eAssemblyLocation.kInShop;
            JObject result;
            using (var t = new Autodesk.SteelConnectionsDB.FabricationTransaction(doc, false, "FMC steel " + name, true))
            {
                switch (name)
                {
                    case "steel_plate":
                    {
                        // points_mm: the outline in the plate's plane; normal_mm (default up), thickness_mm
                        var pts = ((JArray)(op["points_mm"] ?? throw new InvalidOperationException("steel_plate needs points_mm"))).Select(P).ToArray();
                        var plane = new Autodesk.AdvanceSteel.Geometry.Plane(pts[0], V(op["normal_mm"], 0, 0, 1));
                        var plate = new Autodesk.AdvanceSteel.Modelling.Plate(plane, pts, op.Value<double?>("thickness_mm") ?? 10);
                        plate.WriteToDb();
                        result = new JObject { ["plate"] = plate.GetUniqueId().ToString() };
                        break;
                    }
                    case "bolts":
                    case "anchors":
                    {
                        // corner1_mm, corner2_mm: the bolt field; x_dir / y_dir in its plane (default x and y); ids: what it connects
                        var a = P(op["corner1_mm"] ?? throw new InvalidOperationException($"{name} needs corner1_mm and corner2_mm"));
                        var b = P(op["corner2_mm"] ?? throw new InvalidOperationException($"{name} needs corner2_mm"));
                        var vx = V(op["x_dir"], 1, 0, 0); var vy = V(op["y_dir"], 0, 1, 0);
                        Autodesk.AdvanceSteel.Modelling.BoltPattern bp = name == "anchors"
                            ? new Autodesk.AdvanceSteel.Modelling.AnchorPattern(a, b, vx, vy)
                            : new Autodesk.AdvanceSteel.Modelling.FinitRectScrewBoltPattern(a, b, vx, vy);
                        // spacing_x_mm / spacing_y_mm between bolts; diameter_mm, grade, standard as in Revit's bolt properties
                        if (bp is Autodesk.AdvanceSteel.Modelling.FinitRectScrewBoltPattern fr)
                        {
                            if (op["spacing_x_mm"] != null) fr.Wx = op.Value<double>("spacing_x_mm");
                            if (op["spacing_y_mm"] != null) fr.Wy = op.Value<double>("spacing_y_mm");
                        }
                        if (bp is Autodesk.AdvanceSteel.Modelling.ScrewBoltPattern sb)
                        {
                            if (op["diameter_mm"] != null) sb.ScrewDiameter = op.Value<double>("diameter_mm");
                            if (op["grade"] != null) sb.Grade = op.Value<string>("grade");
                            if (op["standard"] != null) sb.Standard = op.Value<string>("standard");
                        }
                        bp.WriteToDb();
                        if (ids.Count > 0) bp.Connect(Steel(), location);
                        result = new JObject { [name] = bp.GetUniqueId().ToString(), ["connects"] = ids.Count };
                        break;
                    }
                    case "weld":
                    {
                        // point_mm (a weld point) or points_mm (a weld line); thickness_mm; ids: what it joins
                        var vx = V(op["x_dir"], 1, 0, 0); var vy = V(op["y_dir"], 0, 1, 0);
                        Autodesk.AdvanceSteel.Modelling.WeldPattern w = op["points_mm"] is JArray line
                            ? new Autodesk.AdvanceSteel.Modelling.WeldLine(line.Select(P).ToArray(), vx, vy)
                            : new Autodesk.AdvanceSteel.Modelling.WeldPoint(P(op["point_mm"] ?? throw new InvalidOperationException("weld needs point_mm or points_mm")), vx, vy);
                        w.WriteToDb();
                        if (op["thickness_mm"] != null) w.SetSeamThickness(Autodesk.AdvanceSteel.Modelling.WeldPattern.eSeamPosition.kUpper, op.Value<double>("thickness_mm"));
                        if (ids.Count > 0) w.Connect(Steel(), location);
                        result = new JObject { ["weld"] = w.GetUniqueId().ToString(), ["joins"] = ids.Count };
                        break;
                    }
                    case "shorten":
                    case "notch":
                    {
                        // a beam (ids[0]) shortened, or notched (length_mm along, depth_mm down), at end start|end
                        var beam = Filer(doc, ids.FirstOrDefault()) as Autodesk.AdvanceSteel.Modelling.Beam ?? throw new InvalidOperationException($"{name} needs ids [a steel beam or column]");
                        var end = (op.Value<string>("end") ?? "start") == "end" ? Autodesk.AdvanceSteel.Modelling.Beam.eEnd.kEnd : Autodesk.AdvanceSteel.Modelling.Beam.eEnd.kStart;
                        Autodesk.AdvanceSteel.ConstructionTypes.FeatureObject f = name == "shorten"
                            ? new Autodesk.AdvanceSteel.Modelling.BeamShortening(end, op.Value<double?>("length_mm") ?? throw new InvalidOperationException("shorten needs length_mm"))
                            : new Autodesk.AdvanceSteel.Modelling.BeamNotchEx(end, (op.Value<string>("side") ?? "top") == "bottom" ? Autodesk.AdvanceSteel.Modelling.Beam.eSide.kLower : Autodesk.AdvanceSteel.Modelling.Beam.eSide.kUpper,
                                op.Value<double?>("length_mm") ?? 100, op.Value<double?>("depth_mm") ?? 50);
                        beam.AddFeature(f);
                        result = new JObject { [name] = f.GetUniqueId().ToString() };
                        break;
                    }
                    default: // corner_fillet
                    {
                        // a plate's corner (vertex index) filleted with radius_mm
                        var plate = Filer(doc, ids.FirstOrDefault()) as Autodesk.AdvanceSteel.Modelling.PlateBase ?? throw new InvalidOperationException("corner_fillet needs ids [a steel plate]");
                        var f = new Autodesk.AdvanceSteel.Modelling.PlateFeatVertFillet(0, (short)(op.Value<int?>("vertex") ?? 0), op.Value<double?>("radius_mm") ?? 20);
                        plate.AddFeature(f);
                        result = new JObject { ["fillet"] = f.GetUniqueId().ToString() };
                        break;
                    }
                }
                t.Commit();
            }
            return result;
        }

        private static Autodesk.AdvanceSteel.CADAccess.FilerObject Filer(Document doc, ElementId id)
        {
            Element e = doc.GetElement(id) ?? throw new InvalidOperationException($"{id?.Value} isn't in this model");
            Guid g = SteelElementProperties.GetFabricationUniqueID(doc, new Reference(e));
            if (g == Guid.Empty)
            {
                // a framing or column element without steel data yet: give it some
                SteelElementProperties.AddFabricationInformationForRevitElements(doc, new List<ElementId> { id });
                g = SteelElementProperties.GetFabricationUniqueID(doc, new Reference(e));
            }
            string handle = Autodesk.AdvanceSteel.DocumentManagement.DocumentManager.GetCurrentDocument().CurrentDatabase.getUidDictionary().GetHandle(g);
            return Autodesk.AdvanceSteel.CADAccess.FilerObject.GetFilerObjectByHandle(handle) ?? throw new InvalidOperationException($"{id.Value} has no steel fabrication data");
        }
    }
#endif
}
