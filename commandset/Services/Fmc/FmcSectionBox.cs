using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Section boxes (owner 27 Oct: "use section boxes like a mad person, for detail, for focus, narrowing down"). One
    /// box spec, used by modify_model's section_box and box_views and by see_view's box. Lengths mm, world coordinates.
    /// <para>Where the box starts (combine them; each widens it): ids, category (with level: on that level only), room
    /// (id, number or name), box_mm [[x, y, z], [x, y, z]], from_view (another 3D view's box), cut_line_mm (a vertical
    /// cut along a plan line, keep left|right, depth_mm), level (a storey slice: from the level to the next one,
    /// to_level, height_mm, or cut_mm above it). Nothing given: the view's own box, else the whole building.</para>
    /// <para>Then, in order: margin_mm (number or [x, y, z]; default 300 around elements, 200 around a room),
    /// grow_mm {top, bottom, left|west, right|east, front|south, back|north} (negative shrinks), top_mm / bottom_mm
    /// (absolute heights), slice {at_mm, keep: below|above}, move_mm [x, y, z]. along (an element id) or angle_deg
    /// turns the box to an element's direction or an angle in plan.</para>
    /// </summary>
    internal static class FmcBox
    {
        private static double Ft(double mm) => mm / 304.8;
        private static double Mm(double ft) => Math.Round(ft * 304.8, 1);

        private static readonly BuiltInCategory[] NotBuilding =
        {
            BuiltInCategory.OST_Toposolid, BuiltInCategory.OST_Topography, BuiltInCategory.OST_Site, BuiltInCategory.OST_Planting,
            BuiltInCategory.OST_Entourage, BuiltInCategory.OST_Parking, BuiltInCategory.OST_RvtLinks, BuiltInCategory.OST_Cameras,
            BuiltInCategory.OST_Levels, BuiltInCategory.OST_Grids, BuiltInCategory.OST_VolumeOfInterest, BuiltInCategory.OST_SectionBox,
            BuiltInCategory.OST_PointClouds, BuiltInCategory.OST_Mass,
        };

        /// <summary>An element id or a unique id.</summary>
        public static ElementId Id(Document doc, JToken t)
        {
            string s = t?.ToString().Trim() ?? "";
            if (long.TryParse(s, out long v)) return new ElementId(v);
            return doc.GetElement(s)?.Id ?? throw new InvalidOperationException($"{s} isn't in this model");
        }

        public static Level LevelOf(Document doc, JToken t)
        {
            string s = t?.ToString() ?? "";
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
            return levels.FirstOrDefault(l => string.Equals(l.Name, s, StringComparison.OrdinalIgnoreCase))
                ?? (long.TryParse(s, out long v) ? levels.FirstOrDefault(l => l.Id.Value == v) : null)
                ?? throw new InvalidOperationException($"no level {s} (levels: {string.Join(", ", levels.Select(l => l.Name))})");
        }

        public static Room RoomOf(Document doc, JToken t)
        {
            string s = t?.ToString().Trim() ?? "";
            var rooms = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).OfType<Room>().Where(r => r.Area > 0).ToList();
            return (long.TryParse(s, out long v) ? rooms.FirstOrDefault(r => r.Id.Value == v) : null)
                ?? rooms.FirstOrDefault(r => string.Equals(r.Number, s, StringComparison.OrdinalIgnoreCase))
                ?? rooms.FirstOrDefault(r => string.Equals(r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(), s, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"no placed room {s} (give its id, number or name)");
        }

        /// <summary>The 8 world corners of a box (with its transform).</summary>
        public static IEnumerable<XYZ> Corners(BoundingBoxXYZ b)
        {
            Transform t = b.Transform ?? Transform.Identity;
            foreach (double x in new[] { b.Min.X, b.Max.X })
                foreach (double y in new[] { b.Min.Y, b.Max.Y })
                    foreach (double z in new[] { b.Min.Z, b.Max.Z })
                        yield return t.OfPoint(new XYZ(x, y, z));
        }

        /// <summary>The building's extent: every model element but the site, datums, links and cameras.</summary>
        public static BoundingBoxXYZ Building(Document doc)
        {
            var skip = new HashSet<long>(NotBuilding.Select(c => (long)c));
            double[] lo = { double.MaxValue, double.MaxValue, double.MaxValue }, hi = { double.MinValue, double.MinValue, double.MinValue };
            foreach (Element e in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                Category c = e.Category;
                if (c == null || c.CategoryType != CategoryType.Model || skip.Contains(c.Id.Value) || e is ImportInstance || e.ViewSpecific) continue;
                BoundingBoxXYZ b = e.get_BoundingBox(null);
                if (b == null) continue;
                lo[0] = Math.Min(lo[0], b.Min.X); lo[1] = Math.Min(lo[1], b.Min.Y); lo[2] = Math.Min(lo[2], b.Min.Z);
                hi[0] = Math.Max(hi[0], b.Max.X); hi[1] = Math.Max(hi[1], b.Max.Y); hi[2] = Math.Max(hi[2], b.Max.Z);
            }
            if (lo[0] == double.MaxValue) throw new InvalidOperationException("the model has nothing to put a box around");
            return new BoundingBoxXYZ { Min = new XYZ(lo[0], lo[1], lo[2]), Max = new XYZ(hi[0], hi[1], hi[2]) };
        }

        /// <summary>The box the spec describes. current: the view's own box, the start when the spec names nothing.</summary>
        public static BoundingBoxXYZ Resolve(Document doc, JObject s, Func<JToken, ElementId> id, BoundingBoxXYZ current, out string what)
        {
            id = id ?? (t => Id(doc, t));
            var words = new List<string>();

            // the frame: turned to an element, an angle, or the cut line
            double angle = 0;
            if (s["along"] != null)
            {
                Element a = doc.GetElement(id(s["along"])) ?? throw new InvalidOperationException("along: no such element");
                XYZ d = a.Location is LocationCurve lc ? (lc.Curve.GetEndPoint(1) - lc.Curve.GetEndPoint(0))
                    : a is FamilyInstance fi ? fi.HandOrientation : a is Wall w ? w.Orientation.CrossProduct(XYZ.BasisZ) : XYZ.BasisX;
                angle = Math.Atan2(d.Y, d.X);
                words.Add($"along {a.Category?.Name} {a.Id.Value}");
            }
            else if (s["angle_deg"] != null) angle = s.Value<double>("angle_deg") * Math.PI / 180;
            List<XYZ> cut = null;
            if (s["cut_line_mm"] is JArray cl)
            {
                cut = cl.OfType<JArray>().Select(p => new XYZ(Ft(p[0].Value<double>()), Ft(p[1].Value<double>()), 0)).ToList();
                if (cut.Count != 2 || cut[0].IsAlmostEqualTo(cut[1])) throw new InvalidOperationException("cut_line_mm is two different points [[x, y], [x, y]]");
                angle = Math.Atan2(cut[1].Y - cut[0].Y, cut[1].X - cut[0].X);
            }
            Transform frame = Transform.CreateRotation(XYZ.BasisZ, angle);
            Transform inv = frame.Inverse;

            double[] lo = { double.MaxValue, double.MaxValue, double.MaxValue }, hi = { double.MinValue, double.MinValue, double.MinValue };
            bool any = false;
            void Take(IEnumerable<XYZ> world)
            {
                foreach (XYZ w in world)
                {
                    XYZ p = inv.OfPoint(w);
                    lo[0] = Math.Min(lo[0], p.X); lo[1] = Math.Min(lo[1], p.Y); lo[2] = Math.Min(lo[2], p.Z);
                    hi[0] = Math.Max(hi[0], p.X); hi[1] = Math.Max(hi[1], p.Y); hi[2] = Math.Max(hi[2], p.Z);
                    any = true;
                }
            }
            double defaultMargin = 0;

            if (s["ids"] is JArray ids && ids.Count > 0)
            {
                var els = ids.Select(t => doc.GetElement(id(t))).Where(e => e != null).ToList();
                foreach (Element e in els) { var b = e.get_BoundingBox(null); if (b != null) Take(Corners(b)); }
                if (!any) throw new InvalidOperationException("ids: these elements have no extent to box");
                words.Add($"{els.Count} element(s)"); defaultMargin = 300;
            }
            if (s["category"] != null)
            {
                var cats = (s["category"] is JArray ca ? ca.Select(x => x.ToString()) : new[] { s.Value<string>("category") }).ToList();
                Level onLevel = s["level"] != null ? LevelOf(doc, s["level"]) : null;
                int n = 0;
                foreach (string cname in cats)
                {
                    Category cat = doc.Settings.Categories.Cast<Category>().FirstOrDefault(c => string.Equals(c.Name, cname, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(c.BuiltInCategory.ToString(), cname, StringComparison.OrdinalIgnoreCase) || string.Equals("OST_" + cname, c.BuiltInCategory.ToString(), StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"no category {cname}");
                    foreach (Element e in new FilteredElementCollector(doc).OfCategoryId(cat.Id).WhereElementIsNotElementType())
                    {
                        if (onLevel != null && e.LevelId != onLevel.Id) continue;
                        var b = e.get_BoundingBox(null); if (b == null) continue;
                        Take(Corners(b)); n++;
                    }
                }
                if (n == 0) throw new InvalidOperationException($"no {string.Join(", ", cats)}{(onLevel != null ? " on " + onLevel.Name : "")} to box");
                words.Add($"{n} {string.Join("/", cats)}"); defaultMargin = 300;
            }
            if (s["room"] != null)
            {
                Room r = RoomOf(doc, s["room"]);
                var b = r.get_BoundingBox(null) ?? throw new InvalidOperationException($"room {r.Number} has no extent");
                Take(Corners(b));
                words.Add($"room {r.Number} {r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString()}".Trim()); defaultMargin = 200;
            }
            if (s["box_mm"] is JArray bm)
            {
                var p = bm.OfType<JArray>().Select(q => new XYZ(Ft(q[0].Value<double>()), Ft(q[1].Value<double>()), q.Count > 2 ? Ft(q[2].Value<double>()) : 0)).ToList();
                if (p.Count != 2) throw new InvalidOperationException("box_mm is [[x, y, z], [x, y, z]]");
                Take(Corners(new BoundingBoxXYZ { Min = new XYZ(Math.Min(p[0].X, p[1].X), Math.Min(p[0].Y, p[1].Y), Math.Min(p[0].Z, p[1].Z)), Max = new XYZ(Math.Max(p[0].X, p[1].X), Math.Max(p[0].Y, p[1].Y), Math.Max(p[0].Z, p[1].Z)) }));
                words.Add("a given box");
            }
            if (s["from_view"] != null)
            {
                View3D fv = FmcViewImageHandler.ViewOf(doc, s.Value<string>("from_view")) as View3D ?? throw new InvalidOperationException("from_view is a 3D view");
                if (!fv.IsSectionBoxActive) throw new InvalidOperationException($"{fv.Name} has no section box on");
                Take(Corners(fv.GetSectionBox()));
                words.Add($"the box of {fv.Name}");
            }
            BoundingBoxXYZ building = null;
            BoundingBoxXYZ Bld() => building ?? (building = Building(doc));
            if (cut != null)
            {
                // the cut face on the line; the box reaches depth_mm (default the building) to the kept side
                XYZ a = inv.OfPoint(cut[0]), b = inv.OfPoint(cut[1]);
                double y0 = a.Y;
                var bp = Corners(Bld()).Select(inv.OfPoint).ToList();
                bool left = !string.Equals(s.Value<string>("keep"), "right", StringComparison.OrdinalIgnoreCase);
                double depth = s["depth_mm"] != null ? Ft(s.Value<double>("depth_mm")) : Math.Max(Ft(1000), left ? bp.Max(p => p.Y) - y0 : y0 - bp.Min(p => p.Y));
                double z0 = bp.Min(p => p.Z), z1 = bp.Max(p => p.Z);
                Take(new[] { frame.OfPoint(new XYZ(Math.Min(a.X, b.X), left ? y0 : y0 - depth, z0)), frame.OfPoint(new XYZ(Math.Max(a.X, b.X), left ? y0 + depth : y0, z1)) });
                words.Add($"a cut along the line, {(left ? "left" : "right")} side kept");
            }
            if (!any)
            {
                if (current != null && s["level"] == null) { Take(Corners(current)); words.Add("the view's box"); }
                else { Take(Corners(Bld())); words.Add("the building"); }
            }

            // margin, then the storey slice
            JToken m = s["margin_mm"];
            double mx = defaultMargin, my = defaultMargin, mz = defaultMargin;
            if (m is JArray ma && ma.Count == 3) { mx = ma[0].Value<double>(); my = ma[1].Value<double>(); mz = ma[2].Value<double>(); }
            else if (m != null) mx = my = mz = m.Value<double>();
            lo[0] -= Ft(mx); lo[1] -= Ft(my); lo[2] -= Ft(mz); hi[0] += Ft(mx); hi[1] += Ft(my); hi[2] += Ft(mz);
            if (s["level"] != null && s["category"] == null)
            {
                Level l = LevelOf(doc, s["level"]);
                var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(x => x.Elevation).ToList();
                double top = s["to_level"] != null ? LevelOf(doc, s["to_level"]).Elevation
                    : s["cut_mm"] != null ? l.Elevation + Ft(s.Value<double>("cut_mm"))
                    : s["height_mm"] != null ? l.Elevation + Ft(s.Value<double>("height_mm"))
                    : levels.FirstOrDefault(x => x.Elevation > l.Elevation + 1e-6)?.Elevation ?? l.Elevation + Ft(3000);
                lo[2] = l.Elevation + Ft(s.Value<double?>("below_mm") is double bl ? -bl : -50); hi[2] = top;
                words.Add(s["cut_mm"] != null ? $"{l.Name} cut at {s.Value<double>("cut_mm")} mm" : $"storey {l.Name}");
            }
            if (s["grow_mm"] is JObject g)
            {
                double G(params string[] keys) => keys.Select(k => g.Value<double?>(k)).FirstOrDefault(v => v.HasValue) is double v ? Ft(v) : 0;
                hi[2] += G("top"); lo[2] -= G("bottom");
                lo[0] -= G("left", "west"); hi[0] += G("right", "east");
                lo[1] -= G("front", "south"); hi[1] += G("back", "north");
            }
            if (s["top_mm"] != null) hi[2] = Ft(s.Value<double>("top_mm"));
            if (s["bottom_mm"] != null) lo[2] = Ft(s.Value<double>("bottom_mm"));
            if (s["slice"] is JObject sl)
            {
                double at = Ft(sl.Value<double?>("at_mm") ?? throw new InvalidOperationException("slice needs at_mm (a height)"));
                if (string.Equals(sl.Value<string>("keep"), "above", StringComparison.OrdinalIgnoreCase)) lo[2] = at; else hi[2] = at;
                words.Add($"sliced at {sl.Value<double>("at_mm")} mm");
            }
            if (s["move_mm"] is JArray mv)
            {
                XYZ d = inv.OfVector(new XYZ(Ft(mv[0].Value<double>()), Ft(mv[1].Value<double>()), mv.Count > 2 ? Ft(mv[2].Value<double>()) : 0));
                lo[0] += d.X; hi[0] += d.X; lo[1] += d.Y; hi[1] += d.Y; lo[2] += d.Z; hi[2] += d.Z;
            }
            for (int i = 0; i < 3; i++)
                if (hi[i] - lo[i] < Ft(10)) throw new InvalidOperationException($"the box has no {"xyz"[i]} size left ({Mm(lo[i])} to {Mm(hi[i])} mm): check top/bottom, slice and grow");
            what = string.Join(", ", words);
            return new BoundingBoxXYZ { Transform = frame, Min = new XYZ(lo[0], lo[1], lo[2]), Max = new XYZ(hi[0], hi[1], hi[2]) };
        }

        /// <summary>The box's world extent in mm, [[min], [max]] (a turned box: what it covers).</summary>
        public static JArray Extent(BoundingBoxXYZ b)
        {
            var c = Corners(b).ToList();
            return new JArray(new JArray(Mm(c.Min(p => p.X)), Mm(c.Min(p => p.Y)), Mm(c.Min(p => p.Z))), new JArray(Mm(c.Max(p => p.X)), Mm(c.Max(p => p.Y)), Mm(c.Max(p => p.Z))));
        }

        /// <summary>
        /// Puts the box on a view: a 3D view's section box; a plan's crop (view_range true: its view range too); a
        /// section's or elevation's crop (far_clip true: its depth too). Returns what was done.
        /// </summary>
        public static string Apply(View v, BoundingBoxXYZ b, JObject s)
        {
            if (v is View3D v3)
            {
                v3.IsSectionBoxActive = true;
                v3.SetSectionBox(b);
                if (s?["show"] != null) try { v3.SetCategoryHidden(new ElementId(BuiltInCategory.OST_SectionBox), !s.Value<bool>("show")); } catch (Exception) { }
                return "section box";
            }
            if (!(v is ViewPlan || v is ViewSection)) throw new InvalidOperationException($"{v.Name} ({v.ViewType}) takes no box: use a 3D view, a plan, a section or an elevation");
            BoundingBoxXYZ crop = v.CropBox;
            Transform ct = crop.Transform ?? Transform.Identity, ci = ct.Inverse;
            var local = Corners(b).Select(ci.OfPoint).ToList();
            var nb = new BoundingBoxXYZ
            {
                Transform = ct,
                Min = new XYZ(local.Min(p => p.X), local.Min(p => p.Y), crop.Min.Z),
                Max = new XYZ(local.Max(p => p.X), local.Max(p => p.Y), crop.Max.Z),
            };
            var did = new List<string> { "crop" };
            if (v is ViewSection && s?.Value<bool?>("far_clip") == true)
            {
                // the view looks along -Z of its crop frame: the far side is the smallest local Z
                double far = -local.Min(p => p.Z);
                if (far > 0)
                {
                    v.get_Parameter(BuiltInParameter.VIEWER_BOUND_FAR_CLIPPING)?.Set(1);
                    v.get_Parameter(BuiltInParameter.VIEWER_BOUND_OFFSET_FAR)?.Set(far);
                    did.Add($"far clip {Mm(far)} mm");
                }
            }
            v.CropBoxActive = true;
            v.CropBox = nb;
            if (s?["show"] != null) v.CropBoxVisible = s.Value<bool>("show");
            if (v is ViewPlan plan && s?.Value<bool?>("view_range") == true && plan.GenLevel != null)
            {
                double baseZ = plan.GenLevel.Elevation, zlo = Corners(b).Min(p => p.Z) - baseZ, zhi = Corners(b).Max(p => p.Z) - baseZ;
                PlanViewRange r = plan.GetViewRange();
                double cutAt = Math.Min(Math.Max(r.GetOffset(PlanViewPlane.CutPlane), zlo), zhi);
                foreach (var pl in new[] { PlanViewPlane.TopClipPlane, PlanViewPlane.CutPlane, PlanViewPlane.BottomClipPlane, PlanViewPlane.ViewDepthPlane })
                    r.SetLevelId(pl, plan.GenLevel.Id);
                r.SetOffset(PlanViewPlane.TopClipPlane, zhi); r.SetOffset(PlanViewPlane.CutPlane, cutAt);
                r.SetOffset(PlanViewPlane.BottomClipPlane, zlo); r.SetOffset(PlanViewPlane.ViewDepthPlane, zlo);
                plan.SetViewRange(r);
                did.Add($"view range {Mm(zlo)} to {Mm(zhi)} mm");
            }
            return string.Join(", ", did);
        }
    }

    public partial class FmcModelEditHandler
    {
        /// <summary>section_box, box_views and site_floor (owner 27 Oct); then display_mode; null for any other op.</summary>
        private JObject BoxOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "section_box":
                {
                    var views = new List<View>();
                    bool made3d = false;
                    foreach (JToken t in op["views"] as JArray ?? (op["view"] != null ? new JArray(op["view"]) : new JArray()))
                        views.Add(string.Equals(t.ToString(), "active", StringComparison.OrdinalIgnoreCase) ? _uidoc?.ActiveView ?? throw new InvalidOperationException("no active view") : ViewOf(doc, t, made));
                    if (op.Value<bool?>("off") == true)
                    {
                        if (views.Count == 0) throw new InvalidOperationException("section_box off needs view or views");
                        foreach (View v in views) { if (v is View3D v3) v3.IsSectionBoxActive = false; else v.CropBoxActive = false; }
                        return new JObject { ["off"] = new JArray(views.Select(v => v.Name)) };
                    }
                    if (views.Count == 0)
                    {
                        // no view named: a new 3D view, like Selection Box in Revit
                        views.Add(New3D(doc, op.Value<string>("name"), op));
                        created.Add(views[0].Id); made3d = true;
                    }
                    var rows = new JArray();
                    foreach (View v in views)
                    {
                        BoundingBoxXYZ current = v is View3D cv && cv.IsSectionBoxActive ? cv.GetSectionBox() : null;
                        BoundingBoxXYZ b = FmcBox.Resolve(doc, op, t => Ref(doc, t, made), current, out string what);
                        string did = FmcBox.Apply(v, b, op);
                        if (v is View3D v3 && (op["from"] != null || made3d) && !v3.IsPerspective)
                            v3.SetOrientation(FmcViewImageHandler.Orientation(op.Value<string>("from") ?? "iso", FmcBox.Corners(b).Aggregate(XYZ.Zero, (a, p) => a + p) / 8));
                        if (made3d && op["name"] == null) try { v.Name = Unique(doc, "FMC Box - " + what); } catch (Exception) { }
                        rows.Add(new JObject { ["view"] = v.Id.Value, ["name"] = v.Name, ["did"] = did, ["around"] = what, ["box_mm"] = FmcBox.Extent(b) });
                    }
                    if (op.Value<bool?>("open") == true) _openView = views[0];
                    return new JObject { ["boxed"] = rows };
                }
                case "box_views":
                {
                    // one 3D view per room, level or element, each boxed to it (an existing view of the same name is re-boxed)
                    string per = op.Value<string>("per") ?? throw new InvalidOperationException("box_views needs per: room, level or element");
                    string prefix = op.Value<string>("prefix") ?? "FMC Box";
                    var items = new List<(string name, string key, JToken value)>();
                    var given = op["items"] as JArray;
                    switch (per)
                    {
                        case "room":
                            foreach (Room r in given != null ? given.Select(t => FmcBox.RoomOf(doc, t)) : new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).OfType<Room>().Where(r => r.Area > 0).OrderBy(r => r.Number))
                                items.Add(($"{prefix} - {r.Number} {r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString()}".Trim(), "room", r.Id.Value));
                            break;
                        case "level":
                            foreach (Level l in given != null ? given.Select(t => LevelOf(doc, t)) : new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation))
                                items.Add(($"{prefix} - {l.Name}", "level", l.Id.Value));
                            break;
                        case "element":
                            foreach (JToken t in given ?? throw new InvalidOperationException("box_views per element needs items (ids)"))
                            {
                                Element e = doc.GetElement(Ref(doc, t, made)) ?? throw new InvalidOperationException($"{t} isn't in this model");
                                items.Add(($"{prefix} - {e.Category?.Name} {e.Name} {e.Id.Value}", "ids", new JArray(e.Id.Value)));
                            }
                            break;
                        default: throw new InvalidOperationException("per is room, level or element");
                    }
                    if (items.Count == 0) throw new InvalidOperationException($"no {per}s to box");
                    if (items.Count > 200) throw new InvalidOperationException($"{items.Count} views is too many in one op (200 at most): give items");
                    var rows = new JArray();
                    foreach (var (vname, key, value) in items)
                    {
                        var spec = (JObject)op.DeepClone();
                        foreach (string k in new[] { "room", "level", "ids", "category", "items", "per" }) spec.Remove(k);
                        spec[key] = value;
                        View3D v = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(x => !x.IsTemplate && x.Name == vname);
                        bool isNew = v == null;
                        if (isNew) { v = New3D(doc, vname, op); created.Add(v.Id); }
                        BoundingBoxXYZ b = FmcBox.Resolve(doc, spec, t => Ref(doc, t, made), null, out string what);
                        FmcBox.Apply(v, b, spec);
                        v.SetOrientation(FmcViewImageHandler.Orientation(op.Value<string>("from") ?? "iso", FmcBox.Corners(b).Aggregate(XYZ.Zero, (a, p) => a + p) / 8));
                        rows.Add(new JObject { ["view"] = v.Id.Value, ["name"] = v.Name, ["new"] = isNew, ["around"] = what });
                    }
                    return new JObject { ["views"] = rows, ["count"] = rows.Count };
                }
                case "site_floor":
                {
                    // a floor (patio, path, slab) sitting on the toposolid's surface and cutting it (Revit's excavation)
                    Level level = LevelOf(doc, op["level"]);
                    var loops = Loops(op).Select(l => CurveLoop.CreateViaTransform(l, Transform.CreateTranslation(new XYZ(0, 0, level.Elevation)))).ToList();
                    var pts = loops[0].Select(c => c.GetEndPoint(0)).ToList();
                    XYZ centre = pts.Aggregate(XYZ.Zero, (a, p) => a + p) / pts.Count;
                    Toposolid topo = op["topo"] != null ? doc.GetElement(Ref(doc, op["topo"], made)) as Toposolid ?? throw new InvalidOperationException("topo isn't a toposolid")
                        : new FilteredElementCollector(doc).OfClass(typeof(Toposolid)).Cast<Toposolid>().FirstOrDefault(t => { var b = t.get_BoundingBox(null); return b != null && centre.X >= b.Min.X && centre.X <= b.Max.X && centre.Y >= b.Min.Y && centre.Y <= b.Max.Y; });
                    double z = level.Elevation;
                    var notes = new JArray();
                    if (topo != null)
                    {
                        string at = op.Value<string>("at") ?? "centre";
                        var heights = (at == "centre" ? new List<XYZ> { centre } : pts.Concat(new[] { centre }).ToList()).Select(p => TopZ(topo, p)).Where(h => h.HasValue).Select(h => h.Value).ToList();
                        if (heights.Count == 0) notes.Add("the toposolid isn't under the outline: the floor sits on the level");
                        else z = at == "highest" ? heights.Max() : at == "lowest" ? heights.Min() : at == "average" ? heights.Average() : heights[0];
                    }
                    else notes.Add("no toposolid under the outline: the floor sits on the level");
                    Floor f = Floor.Create(doc, loops, TypeOf<FloorType>(doc, op), level.Id);
                    created.Add(f.Id);
                    double top = z + Ft(op.Value<double?>("offset_mm") ?? 0);
                    f.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(top - level.Elevation);
                    bool excavated = false;
                    if (topo != null && (op.Value<bool?>("cut") ?? true))
                    {
                        doc.Regenerate();
                        if (topo.CanBeExcavatedBy(f.Id)) { topo.ExcavateBy(f.Id); excavated = true; }
                        else notes.Add("Revit doesn't let this floor cut the toposolid");
                    }
                    return new JObject { ["floor"] = f.Id.Value, ["top_mm"] = Mm(top), ["topo"] = topo?.Id.Value, ["excavated"] = excavated, ["notes"] = notes.Count > 0 ? notes : null };
                }
                default: return DisplayOp(doc, name, op, made, created);
            }
        }

        /// <summary>The toposolid's top surface height at a plan point, null when it isn't there.</summary>
        private static double? TopZ(Element topo, XYZ at)
        {
            BoundingBoxXYZ b = topo.get_BoundingBox(null);
            if (b == null) return null;
            var line = Line.CreateBound(new XYZ(at.X, at.Y, b.Max.Z + 1), new XYZ(at.X, at.Y, b.Min.Z - 1));
            double? best = null;
            foreach (Solid s in Solids(topo.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Fine })))
            {
                var hit = s.IntersectWithCurve(line, new SolidCurveIntersectionOptions());
                for (int i = 0; i < hit.SegmentCount; i++)
                {
                    Curve c = hit.GetCurveSegment(i);
                    double z = Math.Max(c.GetEndPoint(0).Z, c.GetEndPoint(1).Z);
                    if (!best.HasValue || z > best.Value) best = z;
                }
            }
            return best;
        }

        private static View3D New3D(Document doc, string name, JObject op)
        {
            var vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().FirstOrDefault(t => t.ViewFamily == ViewFamily.ThreeDimensional)
                ?? throw new InvalidOperationException("the model has no 3D view type");
            View3D v = op.Value<bool?>("perspective") == true ? View3D.CreatePerspective(doc, vft.Id) : View3D.CreateIsometric(doc, vft.Id);
            if (!string.IsNullOrWhiteSpace(name)) v.Name = Unique(doc, name);
            return v;
        }

        private static string Unique(Document doc, string name)
        {
            name = new string(name.Select(c => "{}[]|;<>?`~\\:".IndexOf(c) >= 0 ? '-' : c).ToArray()).Trim();
            if (name.Length > 120) name = name.Substring(0, 120);
            var taken = new HashSet<string>(new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Select(v => v.Name));
            if (!taken.Contains(name)) return name;
            for (int i = 2; ; i++) if (!taken.Contains($"{name} ({i})")) return $"{name} ({i})";
        }
    }
}
