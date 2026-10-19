using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Casework in the model (CW2, docs/PLAN_CASEWORK.md). The server's engine plans everything (server/src/fmc/
    /// casework_place.ts); these handlers only carry the plan out, in mm from the server and feet in Revit.
    /// <list type="bullet">
    /// <item><b>room</b> (fmc_casework_room, read only): a room's outer boundary on the finish faces, anticlockwise, with
    /// each face's wall, the doors and windows in those walls, and the plumbing, pipe-accessory and electrical fixture
    /// points near the room.</item>
    /// <item><b>place</b> (fmc_casework_place): the kit's unit family types placed at the planned back-centres, facing the
    /// room, with FMC_Assembly_Mark per unit and the type parameters per type; what the same label placed before is
    /// removed first. One transaction group, so one Undo; a dry run is the same run rolled back.</item>
    /// <item><b>pack</b> (fmc_casework_pack): a front elevation per placed unit on the register's A3 sheets, the
    /// I11_Joinery_Cutlist schedule on its sheet, and, on a real run, the sheets exported as one PDF. One Undo; the dry
    /// run rolls back.</item>
    /// </list>
    /// The server sends real runs of place and pack through the live-model lock.
    /// </summary>
    public class FmcCaseworkHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft casework";

        private static double Ft(double mm) => mm / 304.8;
        private static double Mm(double ft) => Math.Round(ft * 304.8, 1);

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: Action == "room");
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Casework is placed in a project model, not a family");
                switch (Action)
                {
                    case "room": Result = Room(doc); break;
                    case "place": Result = Place(doc); break;
                    case "pack": Result = Pack(doc); break;
                    default: Error = $"Unknown casework action '{Action}'"; break;
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        // ---------------------------------------------------------------------------------------------------------
        // room

        private JObject Room(Document doc)
        {
            string key = (Parameters.Value<string>("room") ?? "").Trim();
            var rooms = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().OfType<Room>().Where(r => r.Area > 0).ToList();
            string NameOf(Room r) => r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "";
            Room room = rooms.FirstOrDefault(r => r.Number == key) ?? rooms.FirstOrDefault(r => string.Equals(NameOf(r), key, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"No placed room numbered or named {key}");
            var opts = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };
            IList<IList<BoundarySegment>> loops = room.GetBoundarySegments(opts);
            if (loops == null || loops.Count == 0) throw new InvalidOperationException($"Room {room.Number} has no boundary (is it enclosed?)");
            var notes = new JArray();

            // the outer loop as faces: collinear pieces of one wall merged
            var faces = new List<(XYZ a, XYZ b, long id)>();
            foreach (BoundarySegment seg in loops.OrderByDescending(l => Math.Abs(SignedArea(l))).First())
            {
                Curve c = seg.GetCurve();
                if (!(c is Line)) notes.Add($"A curved boundary piece is read as a straight face from end to end");
                XYZ a = c.GetEndPoint(0), b = c.GetEndPoint(1);
                long id = seg.ElementId?.Value ?? -1;
                if (faces.Count > 0)
                {
                    var last = faces[faces.Count - 1];
                    XYZ d0 = (last.b - last.a).Normalize(), d1 = (b - a).Normalize();
                    if (last.id == id && last.b.IsAlmostEqualTo(a) && d0.IsAlmostEqualTo(d1)) { faces[faces.Count - 1] = (last.a, b, id); continue; }
                }
                faces.Add((a, b, id));
            }
            // anticlockwise, so the room is on the left of each face
            double area = 0;
            foreach (var f in faces) area += f.a.X * f.b.Y - f.b.X * f.a.Y;
            if (area < 0) { faces.Reverse(); faces = faces.Select(f => (f.b, f.a, f.id)).ToList(); }

            var wallIds = new HashSet<long>(faces.Select(f => f.id));
            var walls = new JArray(faces.Select(f => new JObject
            {
                ["start"] = new JArray(Mm(f.a.X), Mm(f.a.Y)), ["end"] = new JArray(Mm(f.b.X), Mm(f.b.Y)),
                ["wall_id"] = f.id,
            }));

            var openings = new JArray();
            foreach (BuiltInCategory bic in new[] { BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows })
                foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().OfType<FamilyInstance>())
                {
                    if (!(fi.Host is Wall host) || !wallIds.Contains(host.Id.Value) || !(fi.Location is LocationPoint lp)) continue;
                    double width = Width(fi, bic == BuiltInCategory.OST_Doors ? BuiltInParameter.DOOR_WIDTH : BuiltInParameter.WINDOW_WIDTH);
                    if (width <= 0) { notes.Add($"{fi.Symbol.FamilyName} : {fi.Name} has no width"); continue; }
                    var o = new JObject
                    {
                        ["kind"] = bic == BuiltInCategory.OST_Doors ? "door" : "window", ["wall_id"] = host.Id.Value,
                        ["at"] = new JArray(Mm(lp.Point.X), Mm(lp.Point.Y)), ["width"] = Mm(width),
                    };
                    Parameter sill = fi.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM);
                    if (bic == BuiltInCategory.OST_Windows && sill != null) o["sill"] = Mm(sill.AsDouble());
                    openings.Add(o);
                }

            // services near the room: inside its plan box widened by 300 mm, between its level and 3 m above
            BoundingBoxXYZ box = room.get_BoundingBox(null);
            double grow = Ft(300);
            var points = new JArray();
            foreach (BuiltInCategory bic in new[] { BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_PipeAccessory, BuiltInCategory.OST_ElectricalFixtures })
                foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().OfType<FamilyInstance>())
                {
                    if (!(fi.Location is LocationPoint lp)) continue;
                    XYZ p = lp.Point;
                    if (box == null || p.X < box.Min.X - grow || p.X > box.Max.X + grow || p.Y < box.Min.Y - grow || p.Y > box.Max.Y + grow || p.Z < box.Min.Z - grow || p.Z > box.Min.Z + Ft(3000)) continue;
                    var systems = new SortedSet<string>();
                    try
                    {
                        ConnectorSet cs = fi.MEPModel?.ConnectorManager?.Connectors;
                        if (cs != null) foreach (Connector c in cs) if (c.MEPSystem != null) systems.Add(c.MEPSystem.Name);
                    }
                    catch (Exception) { /* no connectors: no systems */ }
                    points.Add(new JObject
                    {
                        ["category"] = fi.Category?.Name ?? "", ["family"] = fi.Symbol?.FamilyName ?? "", ["type"] = fi.Name,
                        ["at"] = new JArray(Mm(p.X), Mm(p.Y), Mm(p.Z - (room.Level?.Elevation ?? 0))), ["system"] = string.Join(", ", systems),
                    });
                }

            return new JObject
            {
                ["room"] = new JObject { ["number"] = room.Number, ["name"] = NameOf(room), ["level"] = room.Level?.Name ?? "" },
                ["walls"] = walls, ["openings"] = openings, ["points"] = points, ["notes"] = notes,
            };
        }

        private static double SignedArea(IList<BoundarySegment> loop)
        {
            double a = 0;
            foreach (BoundarySegment s in loop) { XYZ p = s.GetCurve().GetEndPoint(0), q = s.GetCurve().GetEndPoint(1); a += p.X * q.Y - q.X * p.Y; }
            return a / 2;
        }

        private static double Width(FamilyInstance fi, BuiltInParameter bip)
        {
            Parameter p = fi.get_Parameter(bip) ?? fi.Symbol?.get_Parameter(bip) ?? fi.LookupParameter("Width") ?? fi.Symbol?.LookupParameter("Width");
            return p != null && p.StorageType == StorageType.Double ? p.AsDouble() : 0;
        }

        // ---------------------------------------------------------------------------------------------------------
        // place

        private JObject Place(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") ?? true;
            string family = Parameters.Value<string>("family") ?? "";
            string tag = Parameters.Value<string>("tag") ?? "";
            string widthParam = Parameters.Value<string>("width_param") ?? "";
            if (tag.Length == 0) throw new InvalidOperationException("A placement needs its tag (the label's mark in Comments)");
            string levelName = Parameters.Value<string>("level") ?? "";
            Level level = FmcLevels.Find(doc, levelName);
            if (!new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().Any(f => f.Name == family))
                throw new InvalidOperationException($"{family} isn't loaded in the model: load it from the kit's families first");

            var notes = new JArray();
            var placed = new JArray();
            var missingParams = new SortedSet<string>();
            var failures = new FmcFailures();
            int removed = 0;
            using (var group = new TransactionGroup(doc, "Formcraft: place casework"))
            {
                group.Start();
                using (var t = new Transaction(doc, "FMC casework " + tag))
                {
                    failures.Attach(t);
                    t.Start();
                    // what this label placed last time goes first, so a re-run replaces it
                    foreach (FamilyInstance old in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Casework).WhereElementIsNotElementType().OfType<FamilyInstance>().ToList())
                        if (old.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString() == tag) { doc.Delete(old.Id); removed++; }

                    foreach (var tp in (Parameters["type_params"] as JObject ?? new JObject()).Properties())
                    {
                        FamilySymbol sym = Symbol(doc, family, tp.Name);
                        if (sym == null) { notes.Add($"{family} has no type {tp.Name} in the model"); continue; }
                        foreach (var kv in (tp.Value as JObject ?? new JObject()).Properties())
                            if (!SetText(sym, kv.Name, kv.Value.ToString())) missingParams.Add($"{kv.Name} (type {tp.Name})");
                    }

                    foreach (JObject o in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string mark = o.Value<string>("mark") ?? "";
                        try
                        {
                            FamilyInstance fi = PlaceOne(doc, o, family, level, widthParam, notes);
                            foreach (var kv in (o["params"] as JObject ?? new JObject()).Properties())
                                if (!SetText(fi, kv.Name, kv.Value.ToString())) missingParams.Add(kv.Name);
                            fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(tag);
                            placed.Add(new JObject { ["mark"] = mark, ["type"] = o.Value<string>("type"), ["unique_id"] = dry ? "" : fi.UniqueId });
                        }
                        catch (Exception e) { notes.Add($"{mark}: {e.Message}"); }
                    }
                    t.Commit();
                }
                if (dry) group.RollBack(); else group.Assimilate();
            }
            foreach (string p in missingParams) notes.Add($"{p} isn't on {family} or bound to Casework in this model (kit change request: add the kit's shared parameter to the family)");
            return new JObject
            {
                ["dry_run"] = dry, ["placed"] = placed, ["removed"] = removed, ["notes"] = notes,
                ["warnings"] = new JArray(failures.Warnings), ["errors"] = new JArray(failures.Errors), ["rolled_back"] = failures.RolledBack,
            };
        }

        /// <summary>
        /// One unit: placed on the level, its width set, then turned to face the room and moved so its back-centre (read
        /// from its own box before it turns) sits on the planned point of the wall face.
        /// </summary>
        private static FamilyInstance PlaceOne(Document doc, JObject o, string family, Level level, string widthParam, JArray notes)
        {
            string mark = o.Value<string>("mark") ?? "";
            string type = o.Value<string>("type") ?? "";
            FamilySymbol sym = Symbol(doc, family, type) ?? throw new InvalidOperationException($"{family} has no type {type} in the model");
            if (!sym.IsActive) { sym.Activate(); doc.Regenerate(); }
            var at = o["at"] as JArray;
            var face = o["facing"] as JArray;
            double z = Ft(at[2].Value<double>());
            var p = new XYZ(Ft(at[0].Value<double>()), Ft(at[1].Value<double>()), level.Elevation);
            FamilyInstance fi = doc.Create.NewFamilyInstance(p, sym, level, StructuralType.NonStructural);
            Parameter offset = fi.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM) ?? fi.get_Parameter(BuiltInParameter.INSTANCE_ELEVATION_PARAM);
            if (Math.Abs(z) > 1e-9)
            {
                if (offset != null && !offset.IsReadOnly) offset.Set(z);
                else notes.Add($"{mark}: its height above the level can't be set (no writable offset)");
            }
            if (widthParam.Length > 0)
            {
                double w = Ft(o.Value<double>("width"));
                Parameter ip = fi.LookupParameter(widthParam);
                if (ip != null && !ip.IsReadOnly && ip.StorageType == StorageType.Double) ip.Set(w);
                else
                {
                    Parameter tp = sym.LookupParameter(widthParam);
                    if (tp == null) notes.Add($"{mark}: {family} has no {widthParam} parameter");
                    else if (Math.Abs(tp.AsDouble() - w) > Ft(0.5))
                        notes.Add($"{mark}: {widthParam} is a type parameter of {family} : {type} ({Mm(tp.AsDouble())}), so the unit keeps that width, not {o.Value<double>("width")}");
                }
            }
            doc.Regenerate();

            // the back-centre of the unturned unit, from its own box (its axes are the family's while unturned)
            BoundingBoxXYZ bb = fi.get_BoundingBox(null) ?? throw new InvalidOperationException("the placed unit has no extent");
            XYZ f0 = Flat(fi.FacingOrientation);
            XYZ a0 = new XYZ(-f0.Y, f0.X, 0);
            var corners = Corners(bb);
            double back = corners.Min(c => (c - p).DotProduct(f0));
            double lo = corners.Min(c => (c - p).DotProduct(a0)), hi = corners.Max(c => (c - p).DotProduct(a0));
            XYZ backCentre = f0 * back + a0 * ((lo + hi) / 2); // from p

            // turn to face the room
            XYZ want = Flat(new XYZ(face[0].Value<double>(), face[1].Value<double>(), 0));
            double angle = Math.Atan2(f0.CrossProduct(want).Z, f0.DotProduct(want));
            if (Math.Abs(angle) > 1e-9) ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(p, p + XYZ.BasisZ), angle);
            XYZ turned = Transform.CreateRotation(XYZ.BasisZ, angle).OfVector(backCentre);
            XYZ move = new XYZ(-turned.X, -turned.Y, 0);
            if (move.GetLength() > 1e-9) ElementTransformUtils.MoveElement(doc, fi.Id, move);
            return fi;
        }

        private static XYZ Flat(XYZ v) { var f = new XYZ(v.X, v.Y, 0); return f.GetLength() > 1e-9 ? f.Normalize() : XYZ.BasisY; }

        private static List<XYZ> Corners(BoundingBoxXYZ b)
        {
            var list = new List<XYZ>();
            foreach (double x in new[] { b.Min.X, b.Max.X }) foreach (double y in new[] { b.Min.Y, b.Max.Y }) foreach (double z in new[] { b.Min.Z, b.Max.Z })
                list.Add(b.Transform.OfPoint(new XYZ(x, y, z)));
            return list;
        }

        private static FamilySymbol Symbol(Document doc, string family, string type) =>
            new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(x => x.Family?.Name == family && string.Equals(x.Name, type, StringComparison.OrdinalIgnoreCase));

        private static bool SetText(Element e, string name, string value)
        {
            Parameter p = e.LookupParameter(name);
            if (p == null || p.IsReadOnly || p.StorageType != StorageType.String) return false;
            return p.Set(value);
        }

        // ---------------------------------------------------------------------------------------------------------
        // pack: shop-drawing views and sheets

        private JObject Pack(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") ?? true;
            string prefix = Parameters.Value<string>("view_prefix") ?? "";
            if (prefix.Trim().Length == 0) throw new InvalidOperationException("The views need their name prefix (CW <label>)");
            int scale = Parameters.Value<int?>("scale") ?? 0;
            if (scale <= 0) throw new InvalidOperationException("The sheets' scale is needed");
            double margin = Ft(Parameters.Value<double?>("margin_mm") ?? 0);
            var tbSpec = Parameters["title_block"] as JObject ?? new JObject();
            string tbFamily = tbSpec.Value<string>("family") ?? "", tbType = tbSpec.Value<string>("type") ?? "";
            FamilySymbol titleBlock = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().Cast<FamilySymbol>()
                .FirstOrDefault(s => s.FamilyName == tbFamily && s.Name == tbType);
            ViewFamilyType sectionType = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                .FirstOrDefault(v => v.ViewFamily == ViewFamily.Section) ?? throw new InvalidOperationException("The model has no section view type");

            // the placed units by their assembly mark
            var units = new Dictionary<string, FamilyInstance>();
            var notes = new JArray();
            foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Casework).WhereElementIsNotElementType().OfType<FamilyInstance>())
            {
                string m = fi.LookupParameter("FMC_Assembly_Mark")?.AsString() ?? "";
                if (m.Length == 0) continue;
                if (units.ContainsKey(m)) notes.Add($"{m} is on more than one unit; the first is drawn");
                else units[m] = fi;
            }

            var sheetsOut = new JArray();
            var viewsOut = new JArray();
            var exportIds = new List<ElementId>();
            var failures = new FmcFailures();
            int removed = 0;
            JObject schedOut = null;
            using (var group = new TransactionGroup(doc, "Formcraft: casework shop drawings"))
            {
                group.Start();
                using (var t = new Transaction(doc, "FMC casework shop drawings"))
                {
                    failures.Attach(t);
                    t.Start();
                    // this label's views from last time go first (their viewports with them)
                    foreach (View v in new FilteredElementCollector(doc).OfClass(typeof(ViewSection)).Cast<View>().Where(v => !v.IsTemplate && v.Name.StartsWith(prefix, StringComparison.Ordinal)).ToList())
                    { doc.Delete(v.Id); removed++; }

                    var sheets = new Dictionary<string, ViewSheet>();
                    ViewSheet SheetFor(string number, string name)
                    {
                        if (sheets.TryGetValue(number, out ViewSheet s)) return s;
                        s = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().FirstOrDefault(x => x.SheetNumber == number);
                        bool created = s == null;
                        if (created)
                        {
                            if (titleBlock == null) throw new InvalidOperationException($"{tbFamily} : {tbType} isn't loaded: load the kit's title block first");
                            s = ViewSheet.Create(doc, titleBlock.Id);
                            s.SheetNumber = number;
                            s.Name = name;
                        }
                        sheets[number] = s;
                        sheetsOut.Add(new JObject { ["number"] = number, ["name"] = s.Name, ["created"] = created });
                        exportIds.Add(s.Id);
                        return s;
                    }
                    var sheetSpecs = (Parameters["sheets"] as JArray ?? new JArray()).OfType<JObject>().ToDictionary(s => s.Value<string>("number") ?? "", s => s);
                    foreach (var spec in sheetSpecs.Values) SheetFor(spec.Value<string>("number"), spec.Value<string>("name") ?? "");
                    doc.Regenerate();

                    foreach (JObject v in (Parameters["views"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string mark = v.Value<string>("mark") ?? "", number = v.Value<string>("sheet") ?? "";
                        if (!units.TryGetValue(mark, out FamilyInstance fi)) { notes.Add($"{mark} isn't in the model (no unit with that FMC_Assembly_Mark): place it first"); continue; }
                        try
                        {
                            ViewSection view = ViewSection.CreateSection(doc, sectionType.Id, Elevation(fi, margin));
                            view.Name = prefix + mark;
                            // the register's scale first; the register's view template (if it is in the model) over it
                            view.Scale = scale;
                            view.CropBoxActive = true;
                            string template = sheetSpecs.TryGetValue(number, out JObject spec) ? spec.Value<string>("view_template") ?? "" : "";
                            View vt = template.Length == 0 ? null : new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(x => x.IsTemplate && x.Name == template);
                            if (template.Length > 0 && vt == null) notes.Add($"View template {template} isn't in the model, so {mark}'s view has none");
                            if (vt != null) view.ViewTemplateId = vt.Id;
                            ViewSheet sheet = SheetFor(number, spec?.Value<string>("name") ?? "");
                            var c = v["centre"] as JArray;
                            XYZ at = SheetOrigin(doc, sheet) + new XYZ(Ft(c[0].Value<double>()), Ft(c[1].Value<double>()), 0);
                            if (!Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id)) { notes.Add($"{mark}'s view can't go on {number}"); continue; }
                            Viewport.Create(doc, sheet.Id, view.Id, at);
                            viewsOut.Add(new JObject { ["mark"] = mark, ["view"] = view.Name, ["sheet"] = number });
                        }
                        catch (Exception e) { notes.Add($"{mark}: {e.Message}"); }
                    }

                    if (Parameters["schedule"] is JObject sch)
                    {
                        string name = sch.Value<string>("name") ?? "";
                        ViewSchedule schedule = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>().FirstOrDefault(s => !s.IsTemplate && s.Name == name);
                        if (schedule == null) schedOut = new JObject { ["name"] = name, ["result"] = "not in the model: it comes with the kit's template (load its views)" };
                        else
                        {
                            ViewSheet sheet = SheetFor(sch.Value<string>("sheet") ?? "", sch.Value<string>("sheet_name") ?? "");
                            bool there = new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>().Any(i => i.ScheduleId == schedule.Id);
                            if (!there)
                            {
                                doc.Regenerate();
                                var a = sch["at"] as JArray;
                                XYZ at = SheetOrigin(doc, sheet) + (a != null ? new XYZ(Ft(a[0].Value<double>()), Ft(a[1].Value<double>()), 0) : XYZ.Zero);
                                ScheduleSheetInstance.Create(doc, sheet.Id, schedule.Id, at);
                            }
                            schedOut = new JObject { ["name"] = name, ["sheet"] = sheet.SheetNumber, ["result"] = there ? "already on its sheet" : "placed" };
                        }
                    }
                    t.Commit();
                }
                if (dry) group.RollBack(); else group.Assimilate();
            }

            JToken exported = null;
            if (!dry && Parameters["export"] is JObject ex && exportIds.Count > 0)
            {
                string folder = ex.Value<string>("folder") ?? "", file = ex.Value<string>("file") ?? "";
#if REVIT2022_OR_GREATER
                try
                {
                    Directory.CreateDirectory(folder);
                    var options = new PDFExportOptions { FileName = file, Combine = true, PaperFormat = ExportPaperFormat.Default, ZoomType = ZoomType.Zoom, ZoomPercentage = 100 };
                    bool ok = doc.Export(folder, exportIds, options);
                    exported = new JObject { ["file"] = Path.Combine(folder, file + ".pdf"), ["result"] = ok ? "exported" : "Revit didn't export it" };
                }
                catch (Exception e) { exported = new JObject { ["file"] = file + ".pdf", ["result"] = "failed: " + e.Message }; }
#else
                exported = new JObject { ["file"] = file + ".pdf", ["result"] = "PDF export needs Revit 2022 or later" };
#endif
            }
            return new JObject
            {
                ["dry_run"] = dry, ["views"] = viewsOut, ["sheets"] = sheetsOut, ["schedule"] = schedOut, ["removed"] = removed, ["exported"] = exported,
                ["notes"] = notes, ["warnings"] = new JArray(failures.Warnings), ["errors"] = new JArray(failures.Errors), ["rolled_back"] = failures.RolledBack,
            };
        }

        /// <summary>A section box looking at the unit's front from the room: its whole box with a margin, uncut.</summary>
        private static BoundingBoxXYZ Elevation(FamilyInstance fi, double margin)
        {
            BoundingBoxXYZ bb = fi.get_BoundingBox(null) ?? throw new InvalidOperationException("the unit has no extent");
            XYZ facing = Flat(fi.FacingOrientation);
            XYZ up = XYZ.BasisZ;
            XYZ right = up.CrossProduct(facing);
            var corners = Corners(bb);
            XYZ origin = new XYZ((bb.Min.X + bb.Max.X) / 2, (bb.Min.Y + bb.Max.Y) / 2, bb.Min.Z);
            double P(XYZ c, XYZ axis) => (c - origin).DotProduct(axis);
            var t = Transform.Identity;
            t.Origin = origin; t.BasisX = right; t.BasisY = up; t.BasisZ = facing;
            return new BoundingBoxXYZ
            {
                Transform = t,
                Min = new XYZ(corners.Min(c => P(c, right)) - margin, corners.Min(c => P(c, up)) - margin, corners.Min(c => P(c, facing)) - margin),
                Max = new XYZ(corners.Max(c => P(c, right)) + margin, corners.Max(c => P(c, up)) + margin, corners.Max(c => P(c, facing)) + margin),
            };
        }

        /// <summary>The sheet's lower-left corner: its title block's box, or the sheet origin without one.</summary>
        private static XYZ SheetOrigin(Document doc, ViewSheet sheet)
        {
            Element tb = new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().FirstElement();
            BoundingBoxXYZ b = tb?.get_BoundingBox(sheet);
            return b == null ? XYZ.Zero : new XYZ(b.Min.X, b.Min.Y, 0);
        }
    }
}
