using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_room_build (docs/PLAN_RECIPE_TREE.md, T1): a planned room (fmc_room plan: walls, openings, families, the
    /// ceiling, the room) built in the active model in one transaction. What this node built last time (replace: its
    /// UniqueIds) is removed first, so a rebuild changes only the node's own elements. Each element made is marked in
    /// its Comments as FMC:<node>, so people see it came from the recipe tree (T3 reads that to find hand edits).
    /// The server sends it through the live-model lock; positions arrive in mm.
    /// </summary>
    public class FmcRoomBuildHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft room build";

        private static double Ft(double mm) => mm / 304.8;

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Build(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open the WIP model first")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Build(Document doc)
        {
            if (doc.IsFamilyDocument) throw new InvalidOperationException("A room is built in a project model, not a family");
            // new elements go into the active design option: only the one asked for (O3), or the main model when none is
            FmcDesignOption.Check(doc, Parameters.Value<string>("design_option") ?? "");
            string node = Parameters.Value<string>("node") ?? "";
            var ops = (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            var notes = new JArray();
            var made = new List<Element>();
            var keys = new List<string>();
            // each element made, with the key of the op that made it (the server keeps the identity map: T3)
            void Made(Element e, JObject o) { made.Add(e); keys.Add(o.Value<string>("key") ?? ""); }
            int removed = 0;
            string levelName = Parameters.Value<string>("level") ?? "";
            Level level = FmcLevels.Find(doc, levelName);
            JArray loaded = new JArray();

            using (var t = new Transaction(doc, "FMC room " + node))
            {
                t.Start();
                // F-073: each family the room places that the model doesn't hold yet is loaded from the file the server
                // found (kit staging / library roots); one already loaded is used as it is, its values untouched
                loaded = LoadFamilies(doc);
                // what this node made last time goes first
                foreach (string uid in (Parameters["replace"] as JArray ?? new JArray()).Select(x => x.Value<string>()))
                {
                    Element old = doc.GetElement(uid);
                    if (old == null) continue;
                    try { doc.Delete(old.Id); removed++; } catch (Exception) { notes.Add($"{uid} could not be removed"); }
                }
                var walls = new Dictionary<string, Wall>();
                var into = new Dictionary<string, XYZ> { ["south"] = XYZ.BasisY, ["east"] = -XYZ.BasisX, ["north"] = -XYZ.BasisY, ["west"] = XYZ.BasisX };
                Ceiling ceiling = null;
                foreach (JObject o in ops.Where(x => x.Value<string>("op") == "wall"))
                {
                    WallType wt = Type<WallType>(doc, o.Value<string>("type"));
                    var a = o["start"] as JArray; var b = o["end"] as JArray;
                    var line = Line.CreateBound(new XYZ(Ft(a[0].Value<double>()), Ft(a[1].Value<double>()), level.Elevation), new XYZ(Ft(b[0].Value<double>()), Ft(b[1].Value<double>()), level.Elevation));
                    Wall w = Wall.Create(doc, line, wt.Id, level.Id, Ft(o.Value<double>("height")), 0, false, false);
                    walls[o.Value<string>("side")] = w;
                    Made(w, o);
                }
                doc.Regenerate();
                foreach (JObject o in ops.Where(x => x.Value<string>("op") == "ceiling"))
                {
                    var loop = new CurveLoop();
                    var pts = (o["outline"] as JArray).Select(p => new XYZ(Ft(p[0].Value<double>()), Ft(p[1].Value<double>()), level.Elevation)).ToList();
                    for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                    ceiling = Ceiling.Create(doc, new List<CurveLoop> { loop }, Type<CeilingType>(doc, o.Value<string>("type")).Id, level.Id);
                    ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(Ft(o.Value<double>("height")));
                    Made(ceiling, o);
                }
                doc.Regenerate();
                foreach (JObject o in ops.Where(x => x.Value<string>("op") == "opening"))
                {
                    if (!walls.TryGetValue(o.Value<string>("wall"), out Wall host)) { notes.Add($"{o.Value<string>("type")}: no {o.Value<string>("wall")} wall"); continue; }
                    FamilySymbol sym = Symbol(doc, o.Value<string>("family"), o.Value<string>("type"));
                    var at = o["at"] as JArray;
                    var p = new XYZ(Ft(at[0].Value<double>()), Ft(at[1].Value<double>()), level.Elevation);
                    FamilyInstance fi = doc.Create.NewFamilyInstance(p, sym, host, level, StructuralType.NonStructural);
                    if (o.Value<string>("kind") == "window") fi.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.Set(Ft(o.Value<double>("sill")));
                    // a door swings into the room: flip its facing when it faces out
                    if (fi.CanFlipFacing && fi.FacingOrientation.DotProduct(into[o.Value<string>("wall")]) < 0) fi.flipFacing();
                    Made(fi, o);
                }
                foreach (JObject o in ops.Where(x => x.Value<string>("op") == "place"))
                {
                    try { Made(Place(doc, o, level, walls, into, ceiling), o); }
                    catch (Exception e) { notes.Add($"{o.Value<string>("id")}: {e.Message}"); }
                }
                doc.Regenerate();
                foreach (JObject o in ops.Where(x => x.Value<string>("op") == "room"))
                {
                    var at = o["at"] as JArray;
                    Autodesk.Revit.DB.Architecture.Room room = doc.Create.NewRoom(level, new UV(Ft(at[0].Value<double>()), Ft(at[1].Value<double>())));
                    room.Name = o.Value<string>("name") ?? room.Name;
                    if (o["number"] != null) room.Number = o.Value<string>("number");
                    // the brief's programme data (kit parameters bound to Rooms); one that won't set is noted, not fatal
                    foreach (var kv in (o["params"] as JObject ?? new JObject()).Properties())
                    {
                        Parameter p = room.LookupParameter(kv.Name);
                        if (p == null || p.IsReadOnly) { notes.Add($"room {room.Number}: no writable {kv.Name}"); continue; }
                        bool ok;
                        if (p.StorageType == StorageType.String) ok = p.Set(kv.Value.ToString());
                        else if (p.StorageType == StorageType.Integer) ok = p.Set(kv.Value.Value<int>());
                        else if (p.StorageType == StorageType.Double) ok = p.Set(UnitUtils.ConvertToInternalUnits(kv.Value.Value<double>(), p.GetUnitTypeId()));
                        else ok = false;
                        if (!ok) notes.Add($"room {room.Number}: {kv.Name} not set");
                    }
                    Made(room, o);
                }
                foreach (Element e in made) e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set("FMC:" + node);
                t.Commit();
            }
            return new JObject
            {
                ["made"] = new JArray(made.Select(e => e.UniqueId)),
                ["elements"] = new JArray(made.Select((e, i) => new JObject { ["unique_id"] = e.UniqueId, ["key"] = keys[i] })),
                ["removed"] = removed,
                ["loaded"] = loaded,
                ["notes"] = notes,
            };
        }

        /// <summary>
        /// The families the server resolved (families: [{family, path}], path "" when no file was found; searched: the
        /// folders it looked in). A family already in the model is kept; a missing one is loaded from its path, or the
        /// build stops naming the folders searched. Runs inside the build's transaction, so a failure rolls it all back.
        /// </summary>
        private JArray LoadFamilies(Document doc)
        {
            var loaded = new JArray();
            var searched = (Parameters["searched"] as JArray ?? new JArray()).Select(x => x.Value<string>()).ToList();
            foreach (JObject f in (Parameters["families"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = f.Value<string>("family") ?? "", path = f.Value<string>("path") ?? "";
                if (name.Length == 0) continue;
                bool inModel = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().Any(x => x.Name == name);
                if (inModel) continue;
                if (path.Length == 0)
                    throw new InvalidOperationException($"No {name} in the model, and no {name}.rfa in " +
                        (searched.Count > 0 ? string.Join("; ", searched) : "any folder (fmc_guard.json sets no family_staging_root or library_roots)") +
                        ": stage the family there, or load it into the model first");
                if (!System.IO.File.Exists(path)) throw new InvalidOperationException($"No file {path} (for {name})");
                if (!doc.LoadFamily(path, new FmcDocLod.NoOverwrite(), out Family fam) || fam == null)
                    throw new InvalidOperationException($"Revit didn't load {name} from {path}");
                loaded.Add(new JObject { ["family"] = fam.Name, ["path"] = path });
            }
            if (loaded.Count > 0) doc.Regenerate();
            return loaded;
        }

        private static FamilyInstance Place(Document doc, JObject o, Level level, Dictionary<string, Wall> walls, Dictionary<string, XYZ> into, Ceiling ceiling)
        {
            FamilySymbol sym = Symbol(doc, o.Value<string>("family"), o.Value<string>("type"));
            var at = o["at"] as JArray;
            var p = new XYZ(Ft(at[0].Value<double>()), Ft(at[1].Value<double>()), level.Elevation + Ft(at[2].Value<double>()));
            string host = o.Value<string>("host") ?? "floor";
            FamilyInstance fi;
            if (host == "ceiling" && ceiling != null && sym.Family.FamilyPlacementType == FamilyPlacementType.WorkPlaneBased)
            {
                Reference face = HostObjectUtils.GetBottomFaces(ceiling).FirstOrDefault() ?? throw new InvalidOperationException("the ceiling has no bottom face");
                fi = doc.Create.NewFamilyInstance(face, new XYZ(p.X, p.Y, level.Elevation), XYZ.BasisX, sym);
            }
            else if (host == "wall" && walls.TryGetValue(o.Value<string>("wall") ?? "", out Wall w))
            {
                if (sym.Family.FamilyPlacementType == FamilyPlacementType.WorkPlaneBased)
                {
                    // the wall face that looks into the room
                    XYZ inward = into[o.Value<string>("wall")];
                    Reference face = HostObjectUtils.GetSideFaces(w, ShellLayerType.Interior).Concat(HostObjectUtils.GetSideFaces(w, ShellLayerType.Exterior))
                        .FirstOrDefault(r => w.GetGeometryObjectFromReference(r) is PlanarFace f && f.FaceNormal.DotProduct(inward) > 0.9)
                        ?? throw new InvalidOperationException("no wall face looks into the room");
                    XYZ along = new XYZ(-inward.Y, inward.X, 0);
                    fi = doc.Create.NewFamilyInstance(face, p, along, sym);
                }
                else fi = doc.Create.NewFamilyInstance(p, sym, w, level, StructuralType.NonStructural);
            }
            else
            {
                fi = doc.Create.NewFamilyInstance(p, sym, level, StructuralType.NonStructural);
                double deg = o.Value<double?>("rotate_deg") ?? 0;
                if (Math.Abs(deg) > 1e-6) ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(p, p + XYZ.BasisZ), deg * Math.PI / 180);
            }
            return fi;
        }

        private static T Type<T>(Document doc, string name) where T : ElementType =>
            new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>().FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"No {typeof(T).Name} named {name} in the model (load it from the kit's template)");

        private static FamilySymbol Symbol(Document doc, string family, string type)
        {
            FamilySymbol s = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(x => x.Family?.Name == family && x.Name == type)
                ?? throw new InvalidOperationException(new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().Any(x => x.Name == family)
                    ? $"{family} has no type {type} (check the recipe's type name against the family's types)"
                    : $"No {family} : {type} in the model (load the family first)");
            if (!s.IsActive) { s.Activate(); doc.Regenerate(); }
            return s;
        }
    }
}
