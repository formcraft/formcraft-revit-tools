using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc LOD 400 pack (Family Authoring Standard, sections 1-3): object subcategories with line weights, swept,
    /// revolved and blended solids (sweeps take point profiles or a loaded FMC_Profile_* family), symbolic lines and arcs
    /// per view and detail level (door swings, opening lines), face locks to named planes, EQ dimensions, and nested
    /// families placed with their parameters associated. Every op answers create, update or skip, like the others, and
    /// names what it makes in extensible storage so a second run finds it.
    /// </summary>
    public static class FmcDocLod
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double Rad(double deg) => deg * Math.PI / 180.0;

        private static List<double[]> Points(JToken t) =>
            (t as JArray ?? new JArray()).Select(p => ((JArray)p).Select(v => v.Value<double>()).ToArray()).ToList();

        /// <summary>A 2D point in a view plane → model XYZ. plan: (x, y) at z = at; front: (x, z) at y = at; right: (y, z) at x = at.</summary>
        internal static XYZ To3D(string plane, double[] p, double at)
        {
            switch (plane)
            {
                case "front": return new XYZ(Mm(p[0]), Mm(at), Mm(p[1]));
                case "right": return new XYZ(Mm(at), Mm(p[0]), Mm(p[1]));
                default: return new XYZ(Mm(p[0]), Mm(p[1]), Mm(at));
            }
        }

        internal static Plane PlaneOf(string plane, double at)
        {
            switch (plane)
            {
                case "front": return Plane.CreateByNormalAndOrigin(XYZ.BasisY, new XYZ(0, Mm(at), 0));
                case "right": return Plane.CreateByNormalAndOrigin(XYZ.BasisX, new XYZ(Mm(at), 0, 0));
                default: return Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, Mm(at)));
            }
        }

        private static CurveArray Polyline(IList<XYZ> pts, bool closed)
        {
            var arr = new CurveArray();
            int n = closed ? pts.Count : pts.Count - 1;
            for (int k = 0; k < n; k++) arr.Append(Line.CreateBound(pts[k], pts[(k + 1) % pts.Count]));
            return arr;
        }

        private static Element Named(Document doc, string name) =>
            new FilteredElementCollector(doc).WhereElementIsNotElementType().FirstOrDefault(e => FmcDocGeometry.NameOf(e) == name);

        internal static List<Element> AllNamed(Document doc, string name) =>
            new FilteredElementCollector(doc).WhereElementIsNotElementType().Where(e => FmcDocGeometry.NameOf(e) == name).ToList();

        internal static Category Subcategory(Document doc, string name)
        {
            Category parent = doc.OwnerFamily.FamilyCategory ?? throw new InvalidOperationException("Set the family category first");
            foreach (Category c in parent.SubCategories) if (string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)) return c;
            throw new InvalidOperationException("No subcategory " + name + " (add_subcategory makes it)");
        }

        // ---- subcategories ------------------------------------------------------------------------------------------

        public static (string, string) AddSubcategory(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            Category parent = doc.OwnerFamily.FamilyCategory ?? throw new InvalidOperationException("Set the family category first");
            Category sub = null;
            foreach (Category c in parent.SubCategories) if (string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)) sub = c;
            string result = "skip";
            if (sub == null) { sub = doc.Settings.Categories.NewSubcategory(parent, name); result = "create"; }
            var changed = new List<string>();
            // Owner 26 Oct, FAM-044: families drew in near-white lines on pen 1 (half-toned in plans and legends). Black or
            // dark grey lines on the rule's pens, unless the recipe marks a deliberate exception (keep_graphics)
            if (op.Value<bool?>("keep_graphics") != true) op = FmcFamilyGraphics.Apply(name, op);
            int? proj = op.Value<int?>("line_weight_projection"), cut = op.Value<int?>("line_weight_cut");
            if (proj.HasValue && sub.GetLineWeight(GraphicsStyleType.Projection) != proj.Value) { sub.SetLineWeight(proj.Value, GraphicsStyleType.Projection); changed.Add("projection " + proj); }
            if (cut.HasValue)
            {
                try { if (sub.GetLineWeight(GraphicsStyleType.Cut) != cut.Value) { sub.SetLineWeight(cut.Value, GraphicsStyleType.Cut); changed.Add("cut " + cut); } }
                catch (Exception) { changed.Add("cut weight not available for this category"); }
            }
            if (op["color"] is JArray rgb && rgb.Count == 3)
            {
                var want = new Color((byte)rgb[0].Value<int>(), (byte)rgb[1].Value<int>(), (byte)rgb[2].Value<int>());
                Color has = sub.LineColor;
                if (has == null || !has.IsValid || has.Red != want.Red || has.Green != want.Green || has.Blue != want.Blue) { sub.LineColor = want; changed.Add("colour"); }
            }
            string material = op.Value<string>("material");
            if (!string.IsNullOrEmpty(material))
            {
                Material m = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x => x.Name == material)
                    ?? throw new InvalidOperationException("No material " + material + " in the family");
                if (sub.Material?.Id != m.Id) { sub.Material = m; changed.Add("material " + material); }
            }
            if (result == "skip" && changed.Count > 0) result = "update";
            return (result, string.Join(", ", changed));
        }

        public static (string, string) SetSubcategory(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            Category sub = Subcategory(doc, op.Value<string>("subcategory"));
            var items = AllNamed(doc, name);
            if (items.Count == 0) throw new InvalidOperationException("Nothing named " + name);
            int changed = 0;
            foreach (Element e in items) if (Assign(e, sub)) changed++;
            return changed == 0 ? ("skip", "") : ("update", changed + " element(s) on " + sub.Name);
        }

        private static bool Assign(Element e, Category sub)
        {
            switch (e)
            {
                case GenericForm f:
                    if (f.Subcategory?.Id == sub.Id) return false;
                    f.Subcategory = sub; return true;
                case CurveElement c:
                    GraphicsStyle gs = sub.GetGraphicsStyle(GraphicsStyleType.Projection);
                    if (c.LineStyle?.Id == gs.Id) return false;
                    c.LineStyle = gs; return true;
                default:
                    throw new InvalidOperationException(e.GetType().Name + " can't take a subcategory");
            }
        }

        // ---- solids ---------------------------------------------------------------------------------------------------

        public static (string, string) MakeSweep(Document doc, JObject op, bool isVoid)
        {
            string name = op.Value<string>("name");
            if (FmcDocGeometry.Solid(doc, name) != null) return ("skip", "exists (edit the profile or path by hand, or rename to rebuild)");
            // The parametric path: corners on named planes, each segment locked (FmcDocSweep)
            if (op["path_planes"] is JArray) return FmcDocSweep.Make(doc, op, isVoid);
            string plane = op.Value<string>("path_plane") ?? "plan";
            double at = op.Value<double?>("at") ?? 0;
            var path = Points(op["path"]).Select(p => To3D(plane, p, at)).ToList();
            if (path.Count < 2) throw new InvalidOperationException("a sweep path needs two or more points (or path_planes)");
            CurveArray pathCurves = Polyline(path, false);
            SketchPlane sketch = SketchPlane.Create(doc, PlaneOf(plane, at));

            SweepProfile profile = ProfileFor(doc, op, path[0], (path[1] - path[0]).Normalize(), out string detail);
            Autodesk.Revit.DB.Sweep made = doc.FamilyCreate.NewSweep(!isVoid, pathCurves, sketch, profile, 0, ProfilePlaneLocation.Start);
            FmcDocGeometry.Label(made, name);
            ApplySubcategory(doc, made, op);
            return ("create", (isVoid ? "void sweep, " : "sweep, ") + detail + ", path " + path.Count + " points in " + plane);
        }

        /// <summary>
        /// The sweep's profile: a loaded FMC_Profile_* family type, or a closed loop of points drawn on the plane across
        /// the path at its start (x across the path, y up).
        /// </summary>
        internal static SweepProfile ProfileFor(Document doc, JObject op, XYZ start, XYZ dir, out string detail)
        {
            SweepProfile profile;
            string profileFamily = op.Value<string>("profile_family");
            if (!string.IsNullOrEmpty(profileFamily))
            {
                string typeName = op.Value<string>("profile_type");
                FamilySymbol symbol = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                    .Where(s => s.Family?.Name == profileFamily)
                    .FirstOrDefault(s => string.IsNullOrEmpty(typeName) || s.Name == typeName)
                    ?? throw new InvalidOperationException("No profile " + profileFamily + (string.IsNullOrEmpty(typeName) ? "" : " : " + typeName) + " (load_family first)");
                profile = doc.Application.Create.NewFamilySymbolProfile(symbol);
                detail = "profile " + profileFamily + " : " + symbol.Name;
            }
            else
            {
                var pts = Points(op["profile"]);
                if (pts.Count < 3) throw new InvalidOperationException("a profile needs three or more points");
                // Local profile coordinates: x across the path, y up. Revit 2025 NewSweep refuses a curve-loop profile drawn
                // on the plane across the path ("One of the conditions for the inputs was not satisfied", F-065): the loop
                // must be drawn flat in XY at the origin, and Revit carries it to the path start itself. Measured 18 Oct:
                // on a horizontal path Revit maps the loop's X to world up and its Y across the path; on a vertical path
                // X and Y stay X and Y. So x/y swap on paths that don't start vertical.
                bool vertical = Math.Abs(dir.DotProduct(XYZ.BasisZ)) > 0.7;
                var loop = pts.Select(p => vertical ? new XYZ(Mm(p[0]), Mm(p[1]), 0) : new XYZ(Mm(p[1]), Mm(p[0]), 0)).ToList();
                var arr = new CurveArrArray();
                arr.Append(Polyline(loop, true));
                profile = doc.Application.Create.NewCurveLoopsProfile(arr);
                detail = pts.Count + "-point profile";
            }
            return profile;
        }

        public static (string, string) MakeRevolution(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            if (FmcDocGeometry.Solid(doc, name) != null) return ("skip", "exists");
            var axisAt = (op["axis_at"] as JArray)?.Select(v => v.Value<double>()).ToArray() ?? new[] { 0.0, 0.0 };
            // axis z (default): axis_at [x, y], profile [r, z]. axis y (faces the viewer): axis_at [x, z], profile [r, d] with d
            // toward the viewer (-y). axis x: axis_at [y, z], profile [r, d] with d along +x.
            string ax = (op.Value<string>("axis") ?? "z").ToLowerInvariant();
            XYZ origin; XYZ dir; Func<double[], XYZ> at; XYZ sketchNormal;
            if (ax == "y") { origin = new XYZ(Mm(axisAt[0]), 0, Mm(axisAt[1])); dir = XYZ.BasisY.Negate(); sketchNormal = XYZ.BasisZ; at = p => origin + new XYZ(Mm(p[0]), -Mm(p[1]), 0); }
            else if (ax == "x") { origin = new XYZ(0, Mm(axisAt[0]), Mm(axisAt[1])); dir = XYZ.BasisX; sketchNormal = XYZ.BasisZ; at = p => origin + new XYZ(Mm(p[1]), Mm(p[0]), 0); }
            else { origin = new XYZ(Mm(axisAt[0]), Mm(axisAt[1]), 0); dir = XYZ.BasisZ; sketchNormal = XYZ.BasisY; at = p => origin + new XYZ(Mm(p[0]), 0, Mm(p[1])); }
            var loop = Points(op["profile"]).Select(at).ToList();
            var arr = new CurveArrArray();
            arr.Append(Polyline(loop, true));
            SketchPlane sketch = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(sketchNormal, origin));
            Line axis = Line.CreateBound(origin, origin + dir);
            double a0 = Rad(op.Value<double?>("start_deg") ?? 0), a1 = Rad(op.Value<double?>("end_deg") ?? 360);
            Autodesk.Revit.DB.Revolution made = doc.FamilyCreate.NewRevolution(true, arr, sketch, axis, a0, a1);
            FmcDocGeometry.Label(made, name);
            ApplySubcategory(doc, made, op);
            return ("create", "revolution about the " + ax + " axis at " + axisAt[0] + ", " + axisAt[1]);
        }

        public static (string, string) MakeBlend(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            if (FmcDocGeometry.Solid(doc, name) != null) return ("skip", "exists");
            double z0 = op.Value<double?>("start") ?? 0, z1 = op.Value<double?>("end") ?? 1000;
            var bottom = Points(op["base"]).Select(p => To3D("plan", p, z0)).ToList();
            var top = Points(op["top"]).Select(p => To3D("plan", p, z1)).ToList();
            SketchPlane sketch = SketchPlane.Create(doc, PlaneOf("plan", 0));
            Autodesk.Revit.DB.Blend made = doc.FamilyCreate.NewBlend(true, Polyline(top, true), Polyline(bottom, true), sketch);
            made.BottomOffset = Mm(z0);
            made.TopOffset = Mm(z1);
            FmcDocGeometry.Label(made, name);
            ApplySubcategory(doc, made, op);
            return ("create", "blend " + bottom.Count + " → " + top.Count + " sides");
        }

        internal static void ApplySubcategory(Document doc, GenericForm form, JObject op)
        {
            string sub = op.Value<string>("subcategory");
            if (!string.IsNullOrEmpty(sub)) Assign(form, Subcategory(doc, sub));
        }

        // symbolic_lines (fixed and parametric: ends on planes, a labelled radius, per-leaf repeats) is in FmcDocRecipe.

        // ---- constraints ----------------------------------------------------------------------------------------------

        internal static ReferencePlane PlaneNamed(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name)
            ?? throw new InvalidOperationException("No reference plane " + name);

        internal static View ViewFor(Document doc, string kind)
        {
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            if (kind == "front") return views.FirstOrDefault(v => v.Name == "Front") ?? views.First(v => v.ViewType == ViewType.Elevation);
            if (kind == "right") return views.FirstOrDefault(v => v.Name == "Right") ?? views.First(v => v.ViewType == ViewType.Elevation);
            return views.FirstOrDefault(v => v.Name == "Ref. Level") ?? views.First(v => v.ViewType == ViewType.FloorPlan);
        }

        public static (string, string) LockFace(Document doc, JObject op)
        {
            GenericForm form = FmcDocGeometry.Solid(doc, op.Value<string>("solid")) ?? throw new InvalidOperationException("No solid " + op.Value<string>("solid"));
            ReferencePlane plane = PlaneNamed(doc, op.Value<string>("plane"));
            View view = ViewFor(doc, op.Value<string>("view") ?? "plan");
            // Already locked: a locked alignment in this view between the plane and the solid.
            bool exists = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Dimension)).Cast<Dimension>()
                .Any(d => d.NumberOfSegments == 0 && d.IsLocked && d.References.Cast<Reference>().Select(r => r.ElementId).Contains(plane.Id)
                          && d.References.Cast<Reference>().Select(r => r.ElementId).Contains(form.Id));
            if (exists) return ("skip", "");
            doc.Regenerate();
            if (!FmcDocGeometry.LockFace(doc, view, form, plane.GetReference(), plane.Normal))
                throw new InvalidOperationException("no face of " + op.Value<string>("solid") + " lies on " + plane.Name + " in " + view.Name);
            return ("create", "locked to " + plane.Name);
        }

        public static (string, string) EqDimension(Document doc, JObject op)
        {
            var planes = ((JArray)op["planes"]).Select(x => PlaneNamed(doc, x.ToString())).ToList();
            string viewName = op.Value<string>("view");
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            View view = views.FirstOrDefault(v => v.Name == (string.IsNullOrEmpty(viewName) ? "Ref. Level" : viewName))
                ?? views.First(v => v.ViewType == ViewType.FloorPlan);
            var ids = planes.Select(p => p.Id).ToList();
            bool exists = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Dimension)).Cast<Dimension>()
                .Any(d => d.NumberOfSegments > 1 && d.AreSegmentsEqual && ids.All(id => d.References.Cast<Reference>().Any(r => r.ElementId == id)));
            if (exists) return ("skip", "");
            var refs = new ReferenceArray();
            foreach (ReferencePlane p in planes) refs.Append(p.GetReference());
            // Same construction as add_dimension: along the first plane by the offset, then across to the last plane.
            ReferencePlane a = planes[0], b = planes[planes.Count - 1];
            XYZ dir = (a.FreeEnd - a.BubbleEnd).Normalize();
            XYZ start = a.BubbleEnd + dir * Mm(op.Value<double?>("offset") ?? 600);
            XYZ normal = dir.CrossProduct(view.ViewDirection).Normalize();
            XYZ end = start + normal * (b.BubbleEnd - a.BubbleEnd).DotProduct(normal);
            if (start.DistanceTo(end) < 1e-6) throw new InvalidOperationException(a.Name + " and " + b.Name + " are not apart");
            Dimension dim = doc.FamilyCreate.NewLinearDimension(view, Line.CreateBound(start, end), refs);
            dim.AreSegmentsEqual = true;
            return ("create", "EQ across " + string.Join(", ", planes.Select(p => p.Name)) + " in " + view.Name);
        }

        // ---- nested families ------------------------------------------------------------------------------------------

        /// <summary>Loads a family without overwriting one already in the document or its parameter values (also fmc_room_build).</summary>
        internal sealed class NoOverwrite : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues) { overwriteParameterValues = false; return false; }
            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            { source = FamilySource.Family; overwriteParameterValues = false; return false; }
        }

        public static (string, string) LoadFamily(Document doc, JObject op)
        {
            string name = op.Value<string>("name"), path = op.Value<string>("path");
            bool shared = op.Value<bool?>("shared") == true;
            Family loaded = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().FirstOrDefault(f => f.Name == name);
            if (loaded != null) return ("skip", Joined("already loaded", SharedNote(loaded, shared)));
            if (!System.IO.File.Exists(path)) throw new InvalidOperationException("No file " + path);
            if (!doc.LoadFamily(path, new NoOverwrite(), out Family fam) || fam == null) throw new InvalidOperationException("Revit didn't load " + path);
            string note = SharedNote(fam, shared);
            if (fam.Name != name) return ("create", Joined("loaded as " + fam.Name + " (the op calls it " + name + ")", note));
            return ("create", Joined("loaded " + fam.Name, note));
        }

        private static string Joined(string a, string b) => string.IsNullOrEmpty(b) ? a : a + "; " + b;

        /// <summary>
        /// A nested family asked for as shared (hardware that schedules on its own) must be one. Revit 2025 is expected to
        /// show the Shared flag on the loaded Family element; if it doesn't, the op says so and the retest checks by hand.
        /// </summary>
        private static string SharedNote(Family fam, bool wantShared)
        {
            if (!wantShared) return "";
            Parameter p = fam.get_Parameter(BuiltInParameter.FAMILY_SHARED);
            if (p == null) return "warning: Revit doesn't show here whether " + fam.Name + " is shared; check it by hand (Family Category and Parameters > Shared)";
            if (p.AsInteger() != 1)
                throw new InvalidOperationException(fam.Name + " isn't a shared family: rebuild it with set_family_params shared: true, or load it without shared");
            return "shared";
        }

        public static (string, string) PlaceNested(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            FamilyInstance inst = Named(doc, name) as FamilyInstance;
            string result = "skip";
            var notes = new List<string>();
            if (inst == null)
            {
                string famName = op.Value<string>("family"), typeName = op.Value<string>("type");
                FamilySymbol symbol = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                    .FirstOrDefault(s => s.Family?.Name == famName && s.Name == typeName)
                    ?? throw new InvalidOperationException("No type " + famName + " : " + typeName + " (load_family first)");
                if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
                var at = (op["at"] as JArray)?.Select(v => v.Value<double>()).ToArray() ?? new[] { 0.0, 0.0, 0.0 };
                XYZ p = new XYZ(Mm(at[0]), Mm(at[1]), Mm(at.Length > 2 ? at[2] : 0));
                inst = doc.FamilyCreate.NewFamilyInstance(p, symbol, StructuralType.NonStructural);
                double rot = op.Value<double?>("rotate_deg") ?? 0;
                if (Math.Abs(rot) > 1e-9) ElementTransformUtils.RotateElement(doc, inst.Id, Line.CreateBound(p, p + XYZ.BasisZ), Rad(rot));
                FmcDocGeometry.Label(inst, name);
                result = "create";
                // QS03: lock a new component to the host's planes, so it moves with the host's sizes
                if (op["lock"] is JObject lk) notes.AddRange(LockNested(doc, inst, lk));
            }
            FamilyManager fm = doc.FamilyManager;
            if (op["params"] is JObject map)
            {
                foreach (var kv in map)
                {
                    Parameter np = inst.LookupParameter(kv.Key);
                    FamilyParameter hp = fm.get_Parameter(kv.Value.ToString());
                    if (np == null) { notes.Add(kv.Key + " isn't an instance parameter of the nested family (make it one, or use a type parameter by hand)"); continue; }
                    if (hp == null) { notes.Add("no parameter " + kv.Value); continue; }
                    if (fm.GetAssociatedFamilyParameter(np)?.Id == hp.Id) continue;
                    if (!fm.CanElementParameterBeAssociated(np)) { notes.Add(kv.Key + " can't be associated"); continue; }
                    fm.AssociateElementParameterToFamilyParameter(np, hp);
                    notes.Add(kv.Key + " ← " + hp.Definition.Name);
                    if (result == "skip") result = "update";
                }
            }
            return (result, string.Join("; ", notes));
        }

        /// <summary>
        /// QS03: a nested component's Center (Left/Right), Center (Front/Back) and Bottom references moved onto host planes
        /// (x, y) and a host plane or level (z), then locked. The component is drawn with its centre and bottom at its own
        /// origin (its recipe marks those planes as references), so moving its origin onto the plane puts the reference there.
        /// Which of its two centre references takes an x or y lock follows its rotation: the one facing the host plane.
        /// </summary>
        private static IEnumerable<string> LockNested(Document doc, FamilyInstance inst, JObject lk)
        {
            var notes = new List<string>();
            View plan = ViewFor(doc, "plan"), front = ViewFor(doc, "front");
            foreach (string axis in new[] { "x", "y", "z" })
            {
                // a plane name, or { plane, ref }: which of the component's references sits on the plane
                JToken lt = lk[axis];
                if (lt == null || lt.Type == JTokenType.Null) continue;
                string pn = lt.Type == JTokenType.Object ? lt.Value<string>("plane") : lt.Value<string>();
                string refName = lt.Type == JTokenType.Object ? lt.Value<string>("ref") : null;
                if (string.IsNullOrEmpty(pn)) continue;
                Reference hostRef; XYZ hostPoint, hostNormal;
                ReferencePlane rp = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(r => r.Name == pn);
                if (rp != null)
                {
                    Plane pl = rp.GetPlane();
                    hostRef = rp.GetReference(); hostPoint = pl.Origin; hostNormal = pl.Normal.Normalize();
                }
                else
                {
                    Level lv = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(l => l.Name == pn)
                        ?? throw new InvalidOperationException("No reference plane or level " + pn + " to lock " + FmcDocGeometry.NameOf(inst) + " to");
                    hostRef = lv.GetPlaneReference(); hostPoint = new XYZ(0, 0, lv.Elevation); hostNormal = XYZ.BasisZ;
                }
                Transform tr = inst.GetTransform();
                FamilyInstanceReferenceType kind = !string.IsNullOrEmpty(refName) ? (FamilyInstanceReferenceType)Enum.Parse(typeof(FamilyInstanceReferenceType), refName)
                    : axis == "z" ? FamilyInstanceReferenceType.Bottom
                    : Math.Abs(tr.BasisX.DotProduct(hostNormal)) > 0.99 ? FamilyInstanceReferenceType.CenterLeftRight
                    : Math.Abs(tr.BasisY.DotProduct(hostNormal)) > 0.99 ? FamilyInstanceReferenceType.CenterFrontBack
                    : throw new InvalidOperationException(pn + " isn't parallel to either centre plane of " + FmcDocGeometry.NameOf(inst) + " (check rotate_deg)");
                Reference ir = inst.GetReferences(kind).FirstOrDefault()
                    ?? throw new InvalidOperationException(FmcDocGeometry.NameOf(inst) + " has no " + kind + " reference: mark that plane in the component's recipe");
                // where that reference sits in the component (mm along its own x, y or z from its origin): the generator
                // wrote the component, so the recipe carries it; 0 for the centre references and a bottom at the origin
                double refAt = lt.Type == JTokenType.Object ? (lt.Value<double?>("at") ?? 0) : 0;
                XYZ localAxis;
                if (kind == FamilyInstanceReferenceType.CenterLeftRight || kind == FamilyInstanceReferenceType.Left || kind == FamilyInstanceReferenceType.Right) localAxis = tr.BasisX;
                else if (kind == FamilyInstanceReferenceType.CenterFrontBack || kind == FamilyInstanceReferenceType.Front || kind == FamilyInstanceReferenceType.Back) localAxis = tr.BasisY;
                else localAxis = tr.BasisZ;
                XYZ refPoint = tr.Origin + localAxis.Multiply(Mm(refAt));
                double d = (hostPoint - refPoint).DotProduct(hostNormal);
                if (Math.Abs(d) > 1e-9) { ElementTransformUtils.MoveElement(doc, inst.Id, hostNormal.Multiply(d)); doc.Regenerate(); }
                try
                {
                    Dimension al = doc.FamilyCreate.NewAlignment(axis == "z" ? front : plan, hostRef, ir);
                    if (al != null && !al.IsLocked) al.IsLocked = true;
                    notes.Add(axis + " locked to " + pn);
                }
                catch (Exception e)
                {
                    notes.Add(axis + " on " + pn + " but not locked: " + e.Message);
                }
            }
            return notes;
        }
    }
}
