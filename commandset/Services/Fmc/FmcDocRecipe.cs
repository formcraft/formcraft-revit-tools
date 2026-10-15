using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc recipe ops from the Ogala field review (run 9): arrays tied to an Integer count, symbolic lines that follow
    /// reference planes and parameters (plan swings and fold symbols per leaf), template clean-up by match, and the default
    /// size set before any plane (F-026). Each op answers create, update or skip like the others and names what it makes
    /// in extensible storage, so a second run finds it. The dry run is the real run rolled back (FmcDocOps.Apply).
    /// <para>Reliable in the API: copies (ElementTransformUtils.CopyElement), Yes/No switches with formulas, Visible tied to
    /// a parameter, deletes by match, setting a type's lengths. To be confirmed in Revit (the retest): LinearArray.Create in
    /// a family with BaseArray.Label, aligning symbolic line ends and arc centres to planes (NewAlignment with end-point and
    /// centre references), and the radial dimension labelled with a parameter.</para>
    /// </summary>
    public static class FmcDocRecipe
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double Rad(double deg) => deg * Math.PI / 180.0;

        // ---- switches -------------------------------------------------------------------------------------------------

        /// <summary>
        /// A Yes/No parameter with this formula, made or brought up to date. It is an instance parameter when the formula
        /// names an instance parameter (a type parameter's formula can't read one).
        /// </summary>
        internal static (FamilyParameter Param, string Change) Switch(Document doc, string name, string formula)
        {
            FamilyManager fm = doc.FamilyManager;
            bool instance = fm.GetParameters().Any(p => p.IsInstance && p.Definition.Name != name && formula.Contains(p.Definition.Name));
            FamilyParameter sw = fm.get_Parameter(name);
            var changes = new List<string>();
            if (sw == null)
            {
                sw = fm.AddParameter(name, GroupTypeId.Graphics, SpecTypeId.Boolean.YesNo, instance);
                changes.Add("made " + name);
            }
            else
            {
                if (sw.Definition.GetDataType() != SpecTypeId.Boolean.YesNo) throw new InvalidOperationException(name + " exists and isn't a Yes/No parameter");
                if (sw.IsInstance != instance)
                {
                    if (!string.IsNullOrEmpty(sw.Formula)) fm.SetFormula(sw, null);
                    if (instance) fm.MakeInstance(sw); else fm.MakeType(sw);
                    changes.Add(name + (instance ? " now instance" : " now type"));
                }
            }
            if ((sw.Formula ?? "") != formula) { fm.SetFormula(sw, formula); changes.Add(name + " = " + formula); }
            return (sw, string.Join(", ", changes));
        }

        /// <summary>Ties an element's Visible (IS_VISIBLE_PARAM) to a Yes/No parameter; false when it already is.</summary>
        internal static bool TieVisible(Document doc, Element e, FamilyParameter sw)
        {
            FamilyManager fm = doc.FamilyManager;
            Parameter visible = e.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM)
                ?? throw new InvalidOperationException((FmcDocGeometry.NameOf(e) is string n && n.Length > 0 ? n : e.Name) + " has no Visible parameter");
            if (fm.GetAssociatedFamilyParameter(visible)?.Id == sw.Id) return false;
            if (!fm.CanElementParameterBeAssociated(visible)) throw new InvalidOperationException("the Visible of " + e.Name + " can't be tied to a parameter");
            fm.AssociateElementParameterToFamilyParameter(visible, sw);
            return true;
        }

        private static FamilyParameter IntegerParam(Document doc, string name)
        {
            FamilyParameter p = doc.FamilyManager.get_Parameter(name) ?? throw new InvalidOperationException("No parameter " + name);
            if (p.Definition.GetDataType() != SpecTypeId.Int.Integer) throw new InvalidOperationException(name + " isn't an Integer parameter");
            return p;
        }

        private static FamilyParameter LengthParam(Document doc, string name)
        {
            FamilyParameter p = doc.FamilyManager.get_Parameter(name) ?? throw new InvalidOperationException("No parameter " + name);
            if (p.Definition.GetDataType() != SpecTypeId.Length) throw new InvalidOperationException(name + " isn't a Length parameter");
            return p;
        }

        // ---- array ----------------------------------------------------------------------------------------------------

        private static XYZ Direction(string d) => d == "x" ? XYZ.BasisX : d == "y" ? XYZ.BasisY : d == "z" ? XYZ.BasisZ
            : throw new InvalidOperationException("direction is x, y or z");

        public static (string, string) MakeArray(Document doc, JObject op)
        {
            string name = op.Value<string>("name"), solidName = op.Value<string>("solid");
            GenericForm solid = FmcDocGeometry.Solid(doc, solidName) ?? throw new InvalidOperationException("No solid " + solidName);
            FamilyParameter count = IntegerParam(doc, op.Value<string>("count_param"));
            XYZ dir = Direction(op.Value<string>("direction"));
            return (op.Value<string>("mode") ?? "copies") == "linear"
                ? Linear(doc, op, name, solid, count, dir)
                : Copies(doc, op, name, solidName, solid, count, dir);
        }

        /// <summary>
        /// The reliable mode: max - 1 copies of the solid at spacing_mm, named "[solid] #k" (the solid is member 1). Copy k
        /// shows when count &gt; k - 1, through a Yes/No parameter "[array] Show k"; a solid whose Visible was already tied to a
        /// switch (a design movement) keeps it: and(switch, count > k - 1). Each copy is locked again to the planes the solid
        /// is locked to across the array direction, so copies follow Width (or Height) like the solid. The spacing itself
        /// is fixed: let the count follow the size with a formula (e.g. rounddown(Height / 100 mm)).
        /// </summary>
        private static (string, string) Copies(Document doc, JObject op, string name, string solidName, GenericForm solid, FamilyParameter count, XYZ dir)
        {
            FamilyManager fm = doc.FamilyManager;
            int max = op.Value<int?>("max") ?? 12;
            double? spacing = op.Value<double?>("spacing_mm");
            if (!spacing.HasValue || Math.Abs(spacing.Value) < 1e-9) throw new InvalidOperationException("copies need spacing_mm");
            double step = Mm(spacing.Value);
            Parameter ownVisible = solid.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM);
            FamilyParameter own = ownVisible == null ? null : fm.GetAssociatedFamilyParameter(ownVisible);
            var locks = Locks(doc, solid).Where(l => Math.Abs(l.Plane.Normal.DotProduct(dir)) < 0.99).ToList();

            int made = 0, relocked = 0, switches = 0, tied = 0;
            var notes = new List<string>();
            for (int k = 2; k <= max; k++)
            {
                string label = solidName + " #" + k;
                GenericForm copy = FmcDocGeometry.Solid(doc, label);
                if (copy == null)
                {
                    ElementId id = ElementTransformUtils.CopyElement(doc, solid.Id, dir * (step * (k - 1)))
                        .FirstOrDefault(i => doc.GetElement(i) is GenericForm) ?? throw new InvalidOperationException("Revit didn't copy " + solidName);
                    copy = (GenericForm)doc.GetElement(id);
                    FmcDocGeometry.Label(copy, label);   // the copy carries the solid's name until now
                    made++;
                    if (locks.Count > 0)
                    {
                        doc.Regenerate();
                        foreach (var l in locks)
                        {
                            if (FmcDocGeometry.LockFace(doc, l.View, copy, l.Plane.GetReference(), l.Plane.Normal)) relocked++;
                            else notes.Add("warning: " + label + " isn't locked to " + l.Plane.Name + " like " + solidName);
                        }
                    }
                }
                string formula = count.Definition.Name + " > " + (k - 1);
                if (own != null && own.Definition.Name != name + " Show " + k) formula = "and(" + own.Definition.Name + ", " + formula + ")";
                var (sw, change) = Switch(doc, name + " Show " + k, formula);
                if (change.Length > 0) switches++;
                if (TieVisible(doc, copy, sw)) tied++;
            }
            for (int k = max + 1; FmcDocGeometry.Solid(doc, solidName + " #" + k) != null; k++)
                notes.Add("warning: " + solidName + " #" + k + " is above max " + max + ": left as it is");

            string result = made > 0 ? "create" : (switches > 0 || tied > 0) ? "update" : "skip";
            var detail = new List<string>();
            if (made > 0) detail.Add(made + " copies of " + solidName + " every " + spacing.Value + " mm along " + op.Value<string>("direction") + (relocked > 0 ? ", " + relocked + " lock(s) carried" : ""));
            if (switches > 0 || tied > 0) detail.Add("member k shows when " + count.Definition.Name + " > k - 1 (" + (max - 1) + " switches)");
            detail.AddRange(notes);
            return (result, string.Join("; ", detail));
        }

        /// <summary>The planes a solid is aligned and locked to, with the view each lock is in.</summary>
        private static List<(ReferencePlane Plane, View View)> Locks(Document doc, Element form)
        {
            var list = new List<(ReferencePlane, View)>();
            foreach (Dimension d in new FilteredElementCollector(doc).OfClass(typeof(Dimension)).Cast<Dimension>())
            {
                try
                {
                    if (d.NumberOfSegments != 0 || !d.IsLocked || d.View == null) continue;
                    var ids = d.References.Cast<Reference>().Select(r => r.ElementId).ToList();
                    if (!ids.Contains(form.Id)) continue;
                    ReferencePlane rp = ids.Select(i => doc.GetElement(i)).OfType<ReferencePlane>().FirstOrDefault();
                    if (rp != null) list.Add((rp, d.View));
                }
                catch (Exception) { /* spot dimensions and the like have no references to read */ }
            }
            return list;
        }

        /// <summary>
        /// Revit's own array (to be confirmed in Revit): LinearArray.Create on the solid, the array's count labelled with
        /// count_param (BaseArray.Label), and the spacing fixed (spacing_mm), driven by a Length parameter (a dimension
        /// between member 1 and member 2, labelled), or spread between two planes (the last member locked to the second).
        /// </summary>
        private static (string, string) Linear(Document doc, JObject op, string name, GenericForm solid, FamilyParameter count, XYZ dir)
        {
            LinearArray existing = new FilteredElementCollector(doc).OfClass(typeof(LinearArray)).Cast<LinearArray>()
                .FirstOrDefault(a => a.GetOriginalMemberIds().Contains(solid.Id));
            if (existing != null)
            {
                if (existing.Label?.Id == count.Id) return ("skip", "");
                existing.Label = count;
                return ("update", "count labelled " + count.Definition.Name);
            }
            View view = Math.Abs(dir.Z) > 0.5 ? FmcDocLod.ViewFor(doc, "front") : FmcDocLod.ViewFor(doc, "plan");
            int n = Math.Max(2, doc.FamilyManager.CurrentType?.AsInteger(count) ?? 2);
            var ids = new List<ElementId> { solid.Id };
            var notes = new List<string>();
            LinearArray arr;
            if (op["between"] is JArray between)
            {
                ReferencePlane a = FmcDocLod.PlaneNamed(doc, between[0].ToString()), b = FmcDocLod.PlaneNamed(doc, between[1].ToString());
                if (Math.Abs(a.Normal.DotProduct(dir)) < 0.99 || Math.Abs(b.Normal.DotProduct(dir)) < 0.99)
                    throw new InvalidOperationException(a.Name + " and " + b.Name + " must face along " + op.Value<string>("direction"));
                double span = (b.BubbleEnd - a.BubbleEnd).DotProduct(dir);
                arr = Create(doc, view, ids, n, dir * span, ArrayAnchorMember.Last);
                doc.Regenerate();
                GenericForm last = Members(doc, arr).OrderBy(m => Along(m, dir)).Last();
                if (!FmcDocGeometry.LockFace(doc, view, last, b.GetReference(), b.Normal))
                    notes.Add("warning: the last member isn't locked to " + b.Name + " (lock " + FmcDocGeometry.NameOf(solid) + " to " + a.Name + " first)");
                notes.Add("spread between " + a.Name + " and " + b.Name);
            }
            else
            {
                string spacingParam = op.Value<string>("spacing_param");
                FamilyParameter sp = string.IsNullOrEmpty(spacingParam) ? null : LengthParam(doc, spacingParam);
                double step = sp != null ? (doc.FamilyManager.CurrentType?.AsDouble(sp) ?? 0) : Mm(op.Value<double?>("spacing_mm") ?? 0);
                if (Math.Abs(step) < 1e-9) throw new InvalidOperationException("the spacing is 0 (spacing_mm, or the current type's " + spacingParam + ")");
                arr = Create(doc, view, ids, n, dir * step, ArrayAnchorMember.Second);
                if (sp != null)
                {
                    doc.Regenerate();
                    GenericForm second = Members(doc, arr).Where(m => m.Id != solid.Id).OrderBy(m => Math.Abs(Along(m, dir) - Along(solid, dir))).First();
                    if (!LabelSpacing(doc, view, solid, second, dir, sp)) notes.Add("warning: the spacing isn't labelled " + spacingParam + " (dimension it by hand)");
                    else notes.Add("spacing labelled " + spacingParam);
                }
                else notes.Add("every " + op.Value<double>("spacing_mm") + " mm");
            }
            try { arr.Label = count; }
            catch (Exception e) { throw new InvalidOperationException("Revit didn't label the array's count with " + count.Definition.Name + " (" + e.Message + "): use mode copies"); }
            return ("create", "linear array of " + FmcDocGeometry.NameOf(solid) + ", count labelled " + count.Definition.Name + "; " + string.Join("; ", notes));
        }

        private static LinearArray Create(Document doc, View view, ICollection<ElementId> ids, int n, XYZ translation, ArrayAnchorMember anchor)
        {
            try { return LinearArray.Create(doc, view, ids, n, translation, anchor); }
            catch (Exception e) { throw new InvalidOperationException("Revit didn't make the linear array (" + e.Message + "): use mode copies"); }
        }

        private static IEnumerable<GenericForm> Members(Document doc, BaseArray arr) =>
            arr.GetOriginalMemberIds().Concat(arr.GetCopiedMemberIds()).Select(i => doc.GetElement(i)).OfType<GenericForm>();

        private static double Along(Element e, XYZ dir)
        {
            BoundingBoxXYZ bb = e.get_BoundingBox(null);
            return bb == null ? 0 : ((bb.Min + bb.Max) / 2).DotProduct(dir);
        }

        /// <summary>A dimension between the faces of two members that face along the array, labelled with the spacing.</summary>
        private static bool LabelSpacing(Document doc, View view, GenericForm first, GenericForm second, XYZ dir, FamilyParameter sp)
        {
            PlanarFace f1 = FaceAlong(first, dir, view), f2 = FaceAlong(second, dir, view);
            if (f1 == null || f2 == null) return false;
            try
            {
                var refs = new ReferenceArray();
                refs.Append(f1.Reference);
                refs.Append(f2.Reference);
                XYZ end = f1.Origin + dir * (f2.Origin - f1.Origin).DotProduct(dir);
                Dimension dim = doc.FamilyCreate.NewLinearDimension(view, Line.CreateBound(f1.Origin, end), refs);
                dim.FamilyLabel = sp;
                return true;
            }
            catch (Exception) { return false; }
        }

        private static PlanarFace FaceAlong(GenericForm form, XYZ dir, View view)
        {
            var options = new Options { ComputeReferences = true, View = view, IncludeNonVisibleObjects = true };
            foreach (GeometryObject g in form.get_Geometry(options))
                if (g is Autodesk.Revit.DB.Solid s)
                    foreach (Face f in s.Faces)
                        if (f is PlanarFace pf && pf.Reference != null && pf.FaceNormal.IsAlmostEqualTo(dir)) return pf;
            return null;
        }

        // ---- delete_template_element ----------------------------------------------------------------------------------

        private static string KindOf(Element e)
        {
            switch (e)
            {
                case GenericForm g: return g.IsSolid ? "solid" : "void";
                case SymbolicCurve _: return "symbolic_line";
                case DetailCurve _: return "detail_line";
                case ModelCurve _: return "model_line";
                case FamilyInstance _: return "nested_family";
                case Opening _: return "opening";
                default: return null;
            }
        }

        private static Category SubcategoryOf(Element e)
        {
            switch (e)
            {
                case GenericForm g: return g.Subcategory;
                case CurveElement c: return (c.LineStyle as GraphicsStyle)?.GraphicsStyleCategory;
                default: return null;
            }
        }

        private static bool Same(string a, string b) => string.Equals(a ?? "", b ?? "", StringComparison.OrdinalIgnoreCase);

        private static bool InCategory(Document doc, Element e, string want)
        {
            Category cat = want.StartsWith("OST_") && Enum.TryParse(want, out BuiltInCategory bic) ? Category.GetCategory(doc, bic) : null;
            Category sub = SubcategoryOf(e);
            foreach (Category c in new[] { e.Category, sub?.Parent, e is FamilyInstance fi ? fi.Symbol?.Family?.FamilyCategory : null })
            {
                if (c == null) continue;
                if (cat != null ? c.Id == cat.Id : Same(c.Name, want)) return true;
            }
            return false;
        }

        private static string Describe(Element e)
        {
            string sub = SubcategoryOf(e)?.Name;
            string what = e is FamilyInstance fi ? fi.Symbol?.Family?.Name + " : " + fi.Name : e.Name;
            return KindOf(e) + " " + what + (string.IsNullOrEmpty(sub) ? "" : " on " + sub) + " (id " + e.Id + ")";
        }

        /// <summary>
        /// Deletes what the template ships and the recipe replaces (Metric Door.rft's frame, panel and swing lines), matched
        /// by kind, category, subcategory and name, never by id. Elements an op made (they carry an op name) are never
        /// matched. Nothing left to match is a skip, so a second run changes nothing; more than max matches is refused.
        /// </summary>
        public static (string, string) DeleteTemplateElement(Document doc, JObject op)
        {
            string kind = op.Value<string>("kind") ?? "any";
            string cat = op.Value<string>("category"), sub = op.Value<string>("subcategory"), elName = op.Value<string>("element_name");
            if (kind == "any" && string.IsNullOrEmpty(sub) && string.IsNullOrEmpty(elName))
                throw new InvalidOperationException("say what goes: a kind, a subcategory or an element_name");
            int max = op.Value<int?>("max") ?? 10;
            var hits = new FilteredElementCollector(doc).WhereElementIsNotElementType().ToElements()
                .Where(e => KindOf(e) is string k && (kind == "any" || k == kind))
                .Where(e => FmcDocGeometry.NameOf(e).Length == 0)
                .Where(e => string.IsNullOrEmpty(sub) || Same(SubcategoryOf(e)?.Name, sub))
                .Where(e => string.IsNullOrEmpty(cat) || InCategory(doc, e, cat))
                .Where(e => string.IsNullOrEmpty(elName) || Same(e.Name, elName) || (e is FamilyInstance fi && Same(fi.Symbol?.Family?.Name, elName)))
                .ToList();
            if (hits.Count == 0) return ("skip", "nothing matches (already gone)");
            var what = hits.Select(Describe).ToList();
            if (hits.Count > max)
                throw new InvalidOperationException(hits.Count + " elements match, more than max " + max + ": narrow the match (" + string.Join(", ", what.Take(5)) + (what.Count > 5 ? ", …" : "") + ")");
            ICollection<ElementId> gone = doc.Delete(hits.Select(e => e.Id).ToList());
            int dependent = Math.Max(0, gone.Count - hits.Count);
            return ("update", "deleted " + hits.Count + ": " + string.Join(", ", what) + (dependent > 0 ? " (and " + dependent + " dependent: dimensions, locks, labels)" : ""));
        }

        // ---- set_default_size -----------------------------------------------------------------------------------------

        /// <summary>
        /// F-026: the current type's lengths (Width, Height…) set before any plane is drawn, so planes and labelled
        /// dimensions are made at the recipe's size, not the template's. Names a type to make current (made when missing).
        /// </summary>
        public static (string, string) SetDefaultSize(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            string typeName = op.Value<string>("type");
            string result = "skip";
            var changed = new List<string>();
            if (!string.IsNullOrEmpty(typeName))
            {
                FamilyType t = fm.Types.Cast<FamilyType>().FirstOrDefault(x => x.Name == typeName);
                if (t == null) { t = fm.NewType(typeName); result = "create"; changed.Add("type " + typeName); }
                if (fm.CurrentType?.Name != typeName) { fm.CurrentType = t; if (result == "skip") result = "update"; changed.Add(typeName + " is current"); }
            }
            FamilyType type = fm.CurrentType ?? throw new InvalidOperationException("The family has no current type: name one in type");
            foreach (var kv in (op["values"] as JObject) ?? new JObject())
            {
                FamilyParameter p = fm.get_Parameter(kv.Key) ?? throw new InvalidOperationException("No parameter " + kv.Key);
                if (p.Definition.GetDataType() != SpecTypeId.Length) throw new InvalidOperationException(kv.Key + " isn't a Length parameter");
                if (p.IsReporting) throw new InvalidOperationException(kv.Key + " is a reporting parameter");
                if (!string.IsNullOrEmpty(p.Formula)) throw new InvalidOperationException(kv.Key + " has a formula (" + p.Formula + "), so its value can't be set");
                double want = Mm(kv.Value.Value<double>());
                double? now = type.AsDouble(p);
                if (now.HasValue && Math.Abs(now.Value - want) < 1e-9) continue;
                fm.Set(p, want);
                changed.Add(kv.Key + " = " + kv.Value + " mm");
                if (result == "skip") result = "update";
            }
            return (result, (type.Name ?? "") + (changed.Count > 0 ? ": " + string.Join(", ", changed) : ""));
        }

        // ---- symbolic_lines -------------------------------------------------------------------------------------------

        private sealed class End
        {
            public XYZ P;
            public List<ReferencePlane> Planes = new List<ReferencePlane>();
        }

        /// <summary>
        /// Symbolic lines and an arc in plan, front or right, per detail level, on a subcategory. The fixed form (points, an
        /// arc with a point centre) draws as before. Ends given as {planes: [a, b]} are drawn where the planes cross and
        /// locked to them; a line whose ends share a plane is locked to it; an arc's centre on planes is locked there and
        /// radius_param labels a radial dimension. show_if ties the set's Visible to a formula. repeat draws the set for
        /// k = 1..max ("[name] #k", {k} in plane names replaced by k) and set k shows when count_param &gt; k - 1.
        /// </summary>
        public static (string, string) SymbolicLines(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            string showIf = op.Value<string>("show_if");
            if (string.IsNullOrWhiteSpace(showIf)) showIf = null;
            if (!(op["repeat"] is JObject repeat))
            {
                var (r, notes) = DrawSet(doc, op, name, 0, showIf, "Show " + name);
                return (r, string.Join("; ", notes));
            }
            FamilyParameter count = IntegerParam(doc, repeat.Value<string>("count_param"));
            int max = repeat.Value<int?>("max") ?? 2;
            var results = new List<string>();
            var details = new List<string>();
            for (int k = 1; k <= max; k++)
            {
                string formula = count.Definition.Name + " > " + (k - 1);
                if (showIf != null) formula = "and(" + showIf + ", " + formula + ")";
                var (r, notes) = DrawSet(doc, op, name + " #" + k, k, formula, "Show " + name + " " + k);
                results.Add(r);
                details.AddRange(notes.Select(x => x.StartsWith("warning: ") ? "warning: #" + k + " " + x.Substring(9) : "#" + k + " " + x));
            }
            string result = results.Contains("create") ? "create" : results.Contains("update") ? "update" : "skip";
            return (result, string.Join("; ", details));
        }

        private static (string, List<string>) DrawSet(Document doc, JObject op, string label, int k, string formula, string switchName)
        {
            var notes = new List<string>();
            var curves = FmcDocLod.AllNamed(doc, label).OfType<CurveElement>().ToList();
            string result = "skip";
            if (curves.Count == 0) { curves = Draw(doc, op, label, k, notes); result = "create"; }
            else notes.Add("exists");
            if (formula != null)
            {
                var (sw, change) = Switch(doc, switchName, formula);
                int tied = 0;
                foreach (CurveElement c in curves) if (TieVisible(doc, c, sw)) tied++;
                if ((change.Length > 0 || tied > 0) && result == "skip") result = "update";
                if (change.Length > 0) notes.Add(change);
            }
            return (result, notes);
        }

        private static List<CurveElement> Draw(Document doc, JObject op, string label, int k, List<string> notes)
        {
            string plane = op.Value<string>("view") ?? "plan";
            double at = op.Value<double?>("at") ?? 0;
            Plane sketchPlane = FmcDocLod.PlaneOf(plane, at);
            SketchPlane sketch = SketchPlane.Create(doc, sketchPlane);

            End Resolve(JToken t)
            {
                if (t is JArray xy) return new End { P = FmcDocLod.To3D(plane, xy.Select(v => v.Value<double>()).ToArray(), at) };
                var names = ((t as JObject)?["planes"] as JArray ?? throw new InvalidOperationException("an end is [x, y] or {planes: [a, b]}"))
                    .Select(x => x.ToString().Replace("{k}", k.ToString())).ToList();
                var planes = names.Select(n => FmcDocLod.PlaneNamed(doc, n)).ToList();
                return new End { P = Crossing(planes[0], planes[1], sketchPlane), Planes = planes };
            }

            var lines = new List<(Curve Curve, End A, End B)>();
            if (op["points"] is JArray pts && pts.Count >= 2)
            {
                var ends = pts.Select(Resolve).ToList();
                for (int i = 0; i + 1 < ends.Count; i++) lines.Add((Line.CreateBound(ends[i].P, ends[i + 1].P), ends[i], ends[i + 1]));
            }
            if (op["lines"] is JArray ls)
                foreach (JObject l in ls.OfType<JObject>())
                {
                    End a = Resolve(l["from"]), b = Resolve(l["to"]);
                    if (a.P.IsAlmostEqualTo(b.P)) throw new InvalidOperationException("a line in " + label + " has no length here");
                    lines.Add((Line.CreateBound(a.P, b.P), a, b));
                }
            Curve arcCurve = null;
            End center = null;
            JObject arc = op["arc"] as JObject;
            if (arc != null)
            {
                center = Resolve(arc["center"]);
                XYZ ax, ay;
                switch (plane)
                {
                    case "front": ax = XYZ.BasisX; ay = XYZ.BasisZ; break;
                    case "right": ax = XYZ.BasisY; ay = XYZ.BasisZ; break;
                    default: ax = XYZ.BasisX; ay = XYZ.BasisY; break;
                }
                double s = Rad(arc.Value<double>("start_deg")), e = Rad(arc.Value<double>("end_deg"));
                if (e < s) { double t = s; s = e; e = t; }
                arcCurve = Arc.Create(center.P, Mm(arc.Value<double>("radius")), s, e, ax, ay);
            }
            if (lines.Count == 0 && arcCurve == null) throw new InvalidOperationException("give points, lines or arc");

            Category sub = FmcDocLod.Subcategory(doc, op.Value<string>("subcategory"));
            GraphicsStyle style = sub.GetGraphicsStyle(GraphicsStyleType.Projection);
            var vis = new FamilyElementVisibility(FamilyElementVisibilityType.ViewSpecific);
            if (op["coarse"] != null) vis.IsShownInCoarse = op.Value<bool>("coarse");
            if (op["medium"] != null) vis.IsShownInMedium = op.Value<bool>("medium");
            if (op["fine"] != null) vis.IsShownInFine = op.Value<bool>("fine");
            SymbolicCurve Make(Curve c)
            {
                SymbolicCurve sc = doc.FamilyCreate.NewSymbolicCurve(c, sketch);
                sc.LineStyle = style;
                sc.SetVisibility(vis);
                FmcDocGeometry.Label(sc, label);
                return sc;
            }
            var made = lines.Select(l => (Curve: Make(l.Curve), l.A, l.B)).ToList();
            SymbolicCurve arcMade = arcCurve == null ? null : Make(arcCurve);

            // Constraints, once the curves exist: each lock that fails is a warning, the lines stay (they just don't follow).
            int locked = 0;
            bool parametric = made.Any(m => m.A.Planes.Count > 0 || m.B.Planes.Count > 0) || (center?.Planes.Count ?? 0) > 0 || arc?.Value<string>("radius_param") != null;
            if (parametric)
            {
                doc.Regenerate();
                View view = FmcDocLod.ViewFor(doc, plane);
                foreach (var m in made)
                {
                    Curve g = m.Curve.GeometryCurve;
                    var shared = m.A.Planes.Where(x => m.B.Planes.Any(y => y.Id == x.Id)).ToList();
                    foreach (ReferencePlane pl in shared)
                        if (Align(doc, view, pl.GetReference(), g.Reference ?? new Reference(m.Curve), "the line on " + pl.Name, notes)) locked++;
                    for (int i = 0; i < 2; i++)
                        foreach (ReferencePlane at2 in (i == 0 ? m.A : m.B).Planes.Where(x => shared.All(y => y.Id != x.Id)))
                            if (Align(doc, view, at2.GetReference(), g.GetEndPointReference(i), "an end on " + at2.Name, notes)) locked++;
                }
                if (arcMade != null)
                {
                    foreach (ReferencePlane pl in center.Planes)
                        if (Align(doc, view, pl.GetReference(), arcMade.CenterPointReference, "the arc's centre on " + pl.Name, notes)) locked++;
                    string radiusParam = arc.Value<string>("radius_param");
                    if (!string.IsNullOrEmpty(radiusParam))
                    {
                        FamilyParameter rp = LengthParam(doc, radiusParam);
                        try
                        {
                            Curve g = arcMade.GeometryCurve;
                            Dimension dim = doc.FamilyCreate.NewRadialDimension(view, g.Reference ?? new Reference(arcMade), g.Evaluate(0.5, true));
                            dim.FamilyLabel = rp;
                            notes.Add("radius labelled " + radiusParam);
                        }
                        catch (Exception e) { notes.Add("warning: the radius isn't labelled " + radiusParam + " (" + e.Message + ")"); }
                    }
                }
            }
            int n = made.Count + (arcMade == null ? 0 : 1);
            notes.Insert(0, n + " symbolic curve(s) in " + plane + " on " + sub.Name + (locked > 0 ? ", " + locked + " lock(s)" : ""));
            var all = made.Select(m => (CurveElement)m.Curve).ToList();
            if (arcMade != null) all.Add(arcMade);
            return all;
        }

        /// <summary>Where two reference planes cross the sketch plane (three planes meet in a point).</summary>
        private static XYZ Crossing(ReferencePlane a, ReferencePlane b, Plane s)
        {
            XYZ n1 = a.Normal, n2 = b.Normal, n3 = s.Normal;
            double d1 = n1.DotProduct(a.BubbleEnd), d2 = n2.DotProduct(b.BubbleEnd), d3 = n3.DotProduct(s.Origin);
            XYZ c23 = n2.CrossProduct(n3), c31 = n3.CrossProduct(n1), c12 = n1.CrossProduct(n2);
            double det = n1.DotProduct(c23);
            if (Math.Abs(det) < 1e-9) throw new InvalidOperationException(a.Name + " and " + b.Name + " don't cross in this view");
            return (c23 * d1 + c31 * d2 + c12 * d3) / det;
        }

        private static bool Align(Document doc, View view, Reference planeRef, Reference curveRef, string what, List<string> notes)
        {
            try
            {
                Dimension d = doc.FamilyCreate.NewAlignment(view, planeRef, curveRef);
                d.IsLocked = true;
                return true;
            }
            catch (Exception e)
            {
                notes.Add("warning: " + what + " isn't locked (" + e.Message + ")");
                return false;
            }
        }
    }
}
