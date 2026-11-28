using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// B15 family editor ops for fmc_fam_dim, fmc_fam_visibility, fmc_fam_material and fmc_fam_category (Family coverage
    /// review 2026-11-28, section 5 item 4; proposal page 11ee5a5f). They run inside FmcDocOps.Apply like every other
    /// fmc_doc op: one transaction each in the batch's TransactionGroup, the dry run is the real run rolled back, and each
    /// answers create, update or skip so a second run changes nothing. Kept in their own file (and dispatched by
    /// <see cref="Handles"/> before FmcDocOps' switch) so they don't touch the other family-editor branches' lines.
    /// </summary>
    public static class FmcDocFamB15
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double ToMm(double v) => UnitUtils.ConvertFromInternalUnits(v, UnitTypeId.Millimeters);

        /// <summary>
        /// The B15 op names, in one place (the server's twin is B15 in server/src/fmc/ops_b15.ts): a rename is one line
        /// here and one there. Layout agreed with Family Editor Bot (dim_*, vis_*, material_*, category_*); its own
        /// param_*, type_* and plane_* ops are not here.
        /// </summary>
        public static class Op
        {
            public const string DimAddAngular = "dim_add_angular";
            public const string DimAddRadial = "dim_add_radial";
            public const string DimUnlock = "dim_unlock";
            public const string VisSet = "vis_set";
            public const string VisMatrix = "vis_matrix";
            public const string MaterialSet = "material_set";
            public const string MaterialPaint = "material_paint";
            public const string MaterialPurge = "material_purge";
            public const string CategorySet = "category_set";
            public const string CategoryFlags = "category_flags";
            public const string SubcategoryRename = "category_sub_rename";
            public const string SubcategoryDelete = "category_sub_delete";
        }

        private static readonly Dictionary<string, Func<Document, JObject, (string, string)>> Table =
            new Dictionary<string, Func<Document, JObject, (string, string)>>
            {
                [Op.DimAddAngular] = AngularDimension,
                [Op.DimAddRadial] = RadialDimension,
                [Op.DimUnlock] = UnlockDimension,
                [Op.VisSet] = ElementVisibility,
                [Op.VisMatrix] = (d, o) => VisibilityMatrix(d),
                [Op.MaterialSet] = MaterialSet,
                [Op.MaterialPaint] = PaintFace,
                [Op.MaterialPurge] = PurgeMaterials,
                [Op.CategorySet] = CategorySet,
                [Op.CategoryFlags] = FamilyFlags,
                [Op.SubcategoryRename] = RenameSubcategory,
                [Op.SubcategoryDelete] = DeleteSubcategory,
            };

        public static bool Handles(string op) => op != null && Table.ContainsKey(op);

        public static (string, string) Run(Document doc, JObject op) =>
            Table.TryGetValue(op.Value<string>("op") ?? "", out var run) ? run(doc, op) : throw new InvalidOperationException("unknown op " + op.Value<string>("op"));

        /// <summary>
        /// What an op acts on: element_ids (element ids in this family document) when given, else targets (op names),
        /// else the op's own name.
        /// </summary>
        private static List<Element> Targets(Document doc, JObject op)
        {
            if (op["element_ids"] is JArray ids && ids.Count > 0)
                return ids.Select(x => doc.GetElement(new ElementId(x.Value<long>())) ?? throw new InvalidOperationException("No element " + x)).ToList();
            var names = op["targets"] is JArray t && t.Count > 0 ? t.Select(x => x.ToString()).ToList() : new List<string> { op.Value<string>("name") };
            var found = new List<Element>();
            foreach (string n in names)
            {
                var items = FmcDocLod.AllNamed(doc, n);
                if (items.Count == 0) throw new InvalidOperationException("Nothing named " + n);
                found.AddRange(items);
            }
            return found;
        }

        // ---- helpers --------------------------------------------------------------------------------------------------

        private static View DimView(Document doc, string name)
        {
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            if (!string.IsNullOrEmpty(name))
            {
                if (name == "plan" || name == "front" || name == "right") return FmcDocLod.ViewFor(doc, name);
                return views.FirstOrDefault(v => v.Name == name) ?? throw new InvalidOperationException("No view " + name);
            }
            return FmcDocLod.ViewFor(doc, "plan");
        }

        private static FamilyParameter Label(Document doc, string label, ForgeTypeId spec, string what)
        {
            if (string.IsNullOrEmpty(label)) return null;
            FamilyParameter p = doc.FamilyManager.get_Parameter(label) ?? throw new InvalidOperationException("No parameter " + label);
            if (p.Definition.GetDataType() != spec) throw new InvalidOperationException(label + " isn't " + what);
            return p;
        }

        private static List<ElementId> RefIds(Dimension d) => d.References.Cast<Reference>().Select(r => r.ElementId).ToList();

        private static string NameOfId(Document doc, ElementId id)
        {
            Element e = doc.GetElement(id);
            if (e == null) return id.ToString();
            if (e is ReferencePlane rp && !string.IsNullOrEmpty(rp.Name)) return rp.Name;
            string n = FmcDocGeometry.NameOf(e);
            return string.IsNullOrEmpty(n) ? e.GetType().Name + " " + id : n;
        }

        // ---- fmc_fam_dim -----------------------------------------------------------------------------------------------

        /// <summary>An angular dimension between two crossing reference planes, its arc centred where they cross.</summary>
        private static (string, string) AngularDimension(Document doc, JObject op)
        {
            var between = (JArray)op["refs"];
            ReferencePlane a = FmcDocLod.PlaneNamed(doc, between[0].ToString()) ?? throw new InvalidOperationException("No reference plane " + between[0]);
            ReferencePlane b = FmcDocLod.PlaneNamed(doc, between[1].ToString()) ?? throw new InvalidOperationException("No reference plane " + between[1]);
            View view = DimView(doc, op.Value<string>("view"));
            FamilyParameter p = Label(doc, op.Value<string>("label"), SpecTypeId.Angle, "an Angle parameter");
            Dimension existing = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Dimension)).Cast<Dimension>()
                .FirstOrDefault(d => d.DimensionShape == DimensionShape.Angular && RefIds(d).Contains(a.Id) && RefIds(d).Contains(b.Id));
            if (existing != null)
            {
                if (p == null || existing.FamilyLabel?.Id == p.Id) return ("skip", "");
                existing.FamilyLabel = p;
                return ("update", "label " + p.Definition.Name);
            }
            // both planes as lines in the view plane; they must cross
            XYZ n = view.ViewDirection;
            XYZ da = (a.FreeEnd - a.BubbleEnd).Normalize(), db = (b.FreeEnd - b.BubbleEnd).Normalize();
            if (Math.Abs(da.CrossProduct(db).DotProduct(n)) < 1e-6) throw new InvalidOperationException(a.Name + " and " + b.Name + " are parallel: an angular dimension needs planes that cross");
            XYZ pa = a.BubbleEnd, pb = b.BubbleEnd;
            // pa + s*da = pb + t*db, solved in the view plane
            XYZ w = pb - pa;
            double s = w.CrossProduct(db).DotProduct(n) / da.CrossProduct(db).DotProduct(n);
            XYZ centre = pa + da * s;
            double r = Mm(op.Value<double?>("radius") ?? 300);
            int qa = op.Value<int?>("side_a") ?? 1, qb = op.Value<int?>("side_b") ?? 1;
            XYZ ea = centre + da * (qa >= 0 ? r : -r), eb = centre + db * (qb >= 0 ? r : -r);
            XYZ mid = ((ea - centre) + (eb - centre));
            if (mid.GetLength() < 1e-9) throw new InvalidOperationException("the arc's ends are opposite: pick other sides (side_a, side_b)");
            XYZ through = centre + mid.Normalize() * r;
            Arc arc = Arc.Create(ea, eb, through);
            Dimension dim = doc.FamilyCreate.NewAngularDimension(view, arc, a.GetReference(), b.GetReference());
            if (dim == null) throw new InvalidOperationException("Revit made no angular dimension between " + a.Name + " and " + b.Name);
            if (p != null) dim.FamilyLabel = p;
            return ("create", "angle " + a.Name + "-" + b.Name + " in " + view.Name + (p != null ? ", label " + p.Definition.Name : ""));
        }

        /// <summary>The arc a radial or diameter dimension points at: a named line set's arc, or a named solid's circular edge.</summary>
        private static (Reference Ref, Element Owner, Arc Arc) ArcReference(Document doc, string target, int index, View view)
        {
            var items = FmcDocLod.AllNamed(doc, target);
            if (items.Count == 0) throw new InvalidOperationException("Nothing named " + target);
            var arcs = new List<(Reference, Element, Arc)>();
            foreach (Element e in items)
            {
                if (e is CurveElement c && c.GeometryCurve is Arc ca && ca.Reference != null) arcs.Add((ca.Reference, e, ca));
                else if (e is GenericForm f)
                {
                    var opts = new Options { ComputeReferences = true, IncludeNonVisibleObjects = false };
                    foreach (GeometryObject g in f.get_Geometry(opts))
                        if (g is Solid so)
                            foreach (Edge edge in so.Edges)
                                if (edge.AsCurve() is Arc ea && edge.Reference != null) arcs.Add((edge.Reference, e, ea));
                }
            }
            if (arcs.Count == 0) throw new InvalidOperationException(target + " has no arc or circular edge to dimension");
            if (index < 0 || index >= arcs.Count) throw new InvalidOperationException(target + " has " + arcs.Count + " arc(s); arc_index " + index + " is out of range");
            return arcs[index];
        }

        private static (string, string) RadialDimension(Document doc, JObject op)
        {
            string target = op.Value<string>("ref");
            bool diameter = op.Value<bool?>("diameter") ?? false;
            View view = DimView(doc, op.Value<string>("view"));
            FamilyParameter p = Label(doc, op.Value<string>("label"), SpecTypeId.Length, "a Length parameter");
            var (reference, owner, arc) = ArcReference(doc, target, op.Value<int?>("arc_index") ?? 0, view);
            DimensionShape shape = diameter ? DimensionShape.Diameter : DimensionShape.Radial;
            Dimension existing = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Dimension)).Cast<Dimension>()
                .FirstOrDefault(d => d.DimensionShape == shape && RefIds(d).Contains(owner.Id));
            if (existing != null)
            {
                if (p == null || existing.FamilyLabel?.Id == p.Id) return ("skip", "");
                existing.FamilyLabel = p;
                return ("update", "label " + p.Definition.Name);
            }
            // the leader ends outside the arc, along the arc's mid direction
            XYZ midDir = (arc.Evaluate(0.5, true) - arc.Center).Normalize();
            XYZ origin = arc.Center + midDir * (arc.Radius + Mm(op.Value<double?>("leader") ?? 200));
            Dimension dim = diameter ? doc.FamilyCreate.NewDiameterDimension(view, reference, origin)
                                     : doc.FamilyCreate.NewRadialDimension(view, reference, origin);
            if (dim == null) throw new InvalidOperationException("Revit made no " + (diameter ? "diameter" : "radial") + " dimension on " + target);
            if (p != null) dim.FamilyLabel = p;
            return ("create", (diameter ? "diameter " : "radius ") + target + " (" + Math.Round(ToMm(arc.Radius * (diameter ? 2 : 1)), 1) + " mm) in " + view.Name + (p != null ? ", label " + p.Definition.Name : ""));
        }

        /// <summary>
        /// Unlocks the locked dimensions between two planes (or all with a label) and says what then floats: each plane
        /// that no other locked or labelled dimension still holds.
        /// </summary>
        private static (string, string) UnlockDimension(Document doc, JObject op)
        {
            var between = op["refs"] as JArray;
            string label = op.Value<string>("label");
            long? id = op.Value<long?>("id");
            var all = new FilteredElementCollector(doc).OfClass(typeof(Dimension)).Cast<Dimension>().ToList();
            List<Dimension> hits;
            if (id.HasValue)
                hits = all.Where(d => d.Id.Value == id.Value).ToList();
            else if (between != null && between.Count == 2)
            {
                ReferencePlane a = FmcDocLod.PlaneNamed(doc, between[0].ToString()) ?? throw new InvalidOperationException("No reference plane " + between[0]);
                ReferencePlane b = FmcDocLod.PlaneNamed(doc, between[1].ToString()) ?? throw new InvalidOperationException("No reference plane " + between[1]);
                hits = all.Where(d => RefIds(d).Contains(a.Id) && RefIds(d).Contains(b.Id)).ToList();
            }
            else if (!string.IsNullOrEmpty(label))
                hits = all.Where(d => d.FamilyLabel?.Definition.Name == label).ToList();
            else throw new InvalidOperationException("dim_unlock needs id, refs [plane, plane] or label");
            if (hits.Count == 0) throw new InvalidOperationException("No dimension matches " + (id.HasValue ? "id " + id : between != null ? string.Join("-", between) : label));
            int unlocked = 0;
            foreach (Dimension d in hits)
            {
                if (d.NumberOfSegments > 1)
                {
                    foreach (DimensionSegment seg in d.Segments) if (seg.IsLocked) { seg.IsLocked = false; unlocked++; }
                }
                else if (d.IsLocked) { d.IsLocked = false; unlocked++; }
            }
            if (unlocked == 0) return ("skip", "not locked");
            var hitIds = new HashSet<ElementId>(hits.Select(h => h.Id));
            var floats = new List<string>();
            foreach (ElementId rid in hits.SelectMany(RefIds).Distinct())
            {
                bool held = all.Any(d => !hitIds.Contains(d.Id) && RefIds(d).Contains(rid) && (d.FamilyLabel != null || IsLocked(d)));
                if (!held) floats.Add(NameOfId(doc, rid));
            }
            return ("update", unlocked + " lock(s) removed; now float: " + (floats.Count == 0 ? "nothing (other dimensions still hold them)" : string.Join(", ", floats)));
        }

        private static bool IsLocked(Dimension d) =>
            d.NumberOfSegments > 1 ? d.Segments.Cast<DimensionSegment>().Any(s => s.IsLocked) : d.IsLocked;

        // ---- fmc_fam_visibility ----------------------------------------------------------------------------------------

        private static FamilyElementVisibility GetVis(Element e)
        {
            switch (e)
            {
                case GenericForm f: return f.GetVisibility();
                case ModelCurve mc: return mc.GetVisibility();
                case SymbolicCurve sc: return sc.GetVisibility();
                case ModelText mt: return mt.GetVisibility();
                default: return null;
            }
        }

        private static void SetVis(Element e, FamilyElementVisibility v)
        {
            switch (e)
            {
                case GenericForm f: f.SetVisibility(v); break;
                case ModelCurve mc: mc.SetVisibility(v); break;
                case SymbolicCurve sc: sc.SetVisibility(v); break;
                case ModelText mt: mt.SetVisibility(v); break;
                default: throw new InvalidOperationException(e.GetType().Name + " has no family visibility settings");
            }
        }

        private static readonly string[] Levels = { "coarse", "medium", "fine" };
        private static readonly string[] Views = { "plan_rcp", "front_back", "left_right" };

        /// <summary>
        /// vis_set: visibility of any solid, model or symbolic line set or model text (set_visibility is solids only).
        /// detail_levels lists the levels it shows in (the others go off), views the views (model elements), only_when_cut
        /// the cut-only flag; param ties its Visible to a Yes/No family parameter. A list left out changes nothing.
        /// </summary>
        private static (string, string) ElementVisibility(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            var items = Targets(doc, op);
            var levels = (op["detail_levels"] as JArray)?.Select(x => x.ToString()).ToList();
            var views = (op["views"] as JArray)?.Select(x => x.ToString()).ToList();
            if (levels != null && levels.Count == 0) throw new InvalidOperationException("detail_levels: at least one of coarse, medium and fine must stay on (Revit rule)");
            string paramName = op.Value<string>("param");
            FamilyParameter yes = null;
            if (!string.IsNullOrEmpty(paramName))
            {
                yes = doc.FamilyManager.get_Parameter(paramName) ?? throw new InvalidOperationException("No parameter " + paramName);
                if (yes.Definition.GetDataType() != SpecTypeId.Boolean.YesNo) throw new InvalidOperationException(paramName + " isn't a Yes/No parameter");
            }
            var changed = new List<string>();
            int touched = 0;
            foreach (Element e in items)
            {
                FamilyElementVisibility v = GetVis(e) ?? throw new InvalidOperationException(name + ": " + e.GetType().Name + " has no family visibility settings");
                var mine = new List<string>();
                bool model = v.VisibilityType == FamilyElementVisibilityType.Model;
                void Flag(string key, bool want, Func<bool> get, Action<bool> set)
                {
                    if (get() == want) return;
                    set(want); mine.Add(key + "=" + want);
                }
                if (levels != null)
                {
                    Flag("coarse", levels.Contains("coarse"), () => v.IsShownInCoarse, x => v.IsShownInCoarse = x);
                    Flag("medium", levels.Contains("medium"), () => v.IsShownInMedium, x => v.IsShownInMedium = x);
                    Flag("fine", levels.Contains("fine"), () => v.IsShownInFine, x => v.IsShownInFine = x);
                }
                bool wantsViews = views != null || op["only_when_cut"] != null;
                if (model)
                {
                    if (views != null)
                    {
                        Flag("plan_rcp", views.Contains("plan_rcp"), () => v.IsShownInTopBottom, x => v.IsShownInTopBottom = x);
                        Flag("front_back", views.Contains("front_back"), () => v.IsShownInFrontBack, x => v.IsShownInFrontBack = x);
                        Flag("left_right", views.Contains("left_right"), () => v.IsShownInLeftRight, x => v.IsShownInLeftRight = x);
                    }
                    if (op["only_when_cut"] != null && op["only_when_cut"].Type != JTokenType.Null)
                        Flag("only_when_cut", op.Value<bool>("only_when_cut"), () => v.IsShownOnlyWhenCut, x => v.IsShownOnlyWhenCut = x);
                }
                else if (wantsViews) mine.Add("warning: " + (FmcDocGeometry.NameOf(e) ?? name) + " is view-specific (symbolic): only the detail levels apply");
                if (!(v.IsShownInCoarse || v.IsShownInMedium || v.IsShownInFine))
                    throw new InvalidOperationException(name + ": at least one of coarse, medium and fine must stay on (Revit rule)");
                if (mine.Any(m => !m.StartsWith("warning: "))) { SetVis(e, v); touched++; }
                if (yes != null)
                {
                    Parameter vis = e.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM) ?? throw new InvalidOperationException(name + " has no Visible parameter");
                    if (doc.FamilyManager.GetAssociatedFamilyParameter(vis)?.Id != yes.Id)
                    {
                        doc.FamilyManager.AssociateElementParameterToFamilyParameter(vis, yes);
                        mine.Add("Visible from " + yes.Definition.Name); touched++;
                    }
                }
                changed.AddRange(mine);
            }
            string detail = string.Join("; ", changed.Distinct());
            return touched == 0 ? ("skip", detail) : ("update", items.Count + " element(s): " + detail);
        }

        /// <summary>
        /// Read-only: every named element's visibility, and the detail levels in which nothing at all is shown (a family
        /// that is empty at Coarse is the usual fault), with a fix to propose. Changes nothing; answers skip.
        /// </summary>
        private static (string, string) VisibilityMatrix(Document doc)
        {
            var rows = new List<string>();
            int coarse = 0, medium = 0, fine = 0, model = 0;
            foreach (Element e in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                FamilyElementVisibility v;
                try { v = GetVis(e); } catch (Exception) { continue; }
                if (v == null) continue;
                string n = FmcDocGeometry.NameOf(e);
                if (string.IsNullOrEmpty(n)) n = e.GetType().Name + " " + e.Id;
                bool isModel = v.VisibilityType == FamilyElementVisibilityType.Model;
                if (isModel) { model++; if (v.IsShownInCoarse) coarse++; if (v.IsShownInMedium) medium++; if (v.IsShownInFine) fine++; }
                rows.Add(n + ": " + (v.IsShownInCoarse ? "C" : "-") + (v.IsShownInMedium ? "M" : "-") + (v.IsShownInFine ? "F" : "-")
                    + (isModel ? " " + (v.IsShownInTopBottom ? "P" : "-") + (v.IsShownInFrontBack ? "FB" : "--") + (v.IsShownInLeftRight ? "LR" : "--") + (v.IsShownOnlyWhenCut ? " cut-only" : "") : " symbolic"));
            }
            var fixes = new List<string>();
            if (model > 0)
            {
                if (coarse == 0) fixes.Add("warning: nothing is shown at Coarse: turn Coarse on for the main body (set_element_visibility coarse: true)");
                if (medium == 0) fixes.Add("warning: nothing is shown at Medium: turn Medium on for the main body");
                if (fine == 0) fixes.Add("warning: nothing is shown at Fine: turn Fine on for the detailed forms");
            }
            return ("skip", string.Join("; ", rows.Concat(fixes)));
        }

        // ---- fmc_fam_material ------------------------------------------------------------------------------------------

        private static Material MaterialNamed(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == name)
            ?? throw new InvalidOperationException("No material " + name + " in the family (add_material brings it in from the kit)");

        /// <summary>
        /// material_set: with param, sets that Material family parameter to the material in every family type; otherwise
        /// sets the targets' own Material (solids). A solid whose Material follows a parameter is left alone unless detach.
        /// </summary>
        private static (string, string) MaterialSet(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            Material m = MaterialNamed(doc, op.Value<string>("material"));
            string paramName = op.Value<string>("param");
            if (!string.IsNullOrEmpty(paramName))
            {
                FamilyManager fm = doc.FamilyManager;
                FamilyParameter fp = fm.get_Parameter(paramName) ?? throw new InvalidOperationException("No parameter " + paramName);
                if (fp.Definition.GetDataType() != SpecTypeId.Reference.Material) throw new InvalidOperationException(paramName + " isn't a Material parameter");
                if (!string.IsNullOrEmpty(fp.Formula)) throw new InvalidOperationException(paramName + " has a formula (" + fp.Formula + "): its value comes from that");
                FamilyType current = fm.CurrentType;
                int set = 0;
                var types = fm.Types.Cast<FamilyType>().Where(t => !string.IsNullOrWhiteSpace(t.Name)).ToList();
                if (types.Count == 0 && current != null) types.Add(current);
                foreach (FamilyType t in types)
                {
                    if (t.AsElementId(fp) == m.Id) continue;
                    fm.CurrentType = t;
                    fm.Set(fp, m.Id);
                    set++;
                }
                if (current != null && fm.CurrentType?.Name != current.Name) fm.CurrentType = current;
                return set == 0 ? ("skip", "") : ("update", paramName + " = " + m.Name + " in " + set + " type(s)");
            }
            var forms = Targets(doc, op).OfType<GenericForm>().ToList();
            if (forms.Count == 0) throw new InvalidOperationException("No solid among " + name + "'s targets");
            int changed = 0;
            var notes = new List<string>();
            foreach (GenericForm f in forms)
            {
                Parameter p = f.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM) ?? throw new InvalidOperationException(name + " has no Material parameter");
                FamilyParameter assoc = doc.FamilyManager.GetAssociatedFamilyParameter(p);
                if (assoc != null)
                {
                    if (op.Value<bool?>("detach") != true) { notes.Add("warning: " + FmcDocGeometry.NameOf(f) + "'s Material follows " + assoc.Definition.Name + ": left as it is (detach: true to set it directly)"); continue; }
                    doc.FamilyManager.AssociateElementParameterToFamilyParameter(p, null);
                    notes.Add("detached from " + assoc.Definition.Name);
                }
                if (p.AsElementId() == m.Id) continue;
                p.Set(m.Id); changed++;
            }
            string detail = string.Join("; ", notes);
            return changed == 0 && !notes.Any(n => n.StartsWith("detached")) ? ("skip", detail) : ("update", (changed + " solid(s) → " + m.Name + "; " + detail).TrimEnd(' ', ';'));
        }

        private static Face FaceOf(GenericForm f, string side)
        {
            XYZ want;
            switch (side)
            {
                case "top": want = XYZ.BasisZ; break;
                case "bottom": want = -XYZ.BasisZ; break;
                case "left": want = -XYZ.BasisX; break;
                case "right": want = XYZ.BasisX; break;
                case "front": want = -XYZ.BasisY; break;
                case "back": want = XYZ.BasisY; break;
                default: throw new InvalidOperationException("face is top, bottom, left, right, front or back");
            }
            Face best = null; double bestArea = 0;
            var opts = new Options { ComputeReferences = true };
            foreach (GeometryObject g in f.get_Geometry(opts))
                if (g is Solid s)
                    foreach (Face face in s.Faces)
                        if (face is PlanarFace pf && pf.FaceNormal.IsAlmostEqualTo(want) && pf.Area > bestArea) { best = pf; bestArea = pf.Area; }
            return best ?? throw new InvalidOperationException("The solid has no flat " + side + " face");
        }

        /// <summary>Paints one flat face of a solid (the largest facing that way) with a family material.</summary>
        private static (string, string) PaintFace(Document doc, JObject op)
        {
            string solid = op.Value<string>("solid"), side = op.Value<string>("face");
            GenericForm f = FmcDocGeometry.Solid(doc, solid) ?? throw new InvalidOperationException("No solid " + solid);
            Material m = MaterialNamed(doc, op.Value<string>("material"));
            Face face = FaceOf(f, side);
            if (doc.IsPainted(f.Id, face) && doc.GetPaintedMaterial(f.Id, face) == m.Id) return ("skip", "");
            doc.Paint(f.Id, face, m.Id);
            return ("update", solid + " " + side + " face painted " + m.Name);
        }

        /// <summary>
        /// Lists the materials nothing in the family uses (no solid, subcategory, painted face or Material parameter value).
        /// Deletes them only with delete: true, and never one in keep.
        /// </summary>
        private static (string, string) PurgeMaterials(Document doc, JObject op)
        {
            bool delete = op.Value<bool?>("delete") ?? false;
            var keep = new HashSet<string>((op["keep"] as JArray)?.Select(x => x.ToString()) ?? Enumerable.Empty<string>());
            var used = new HashSet<ElementId>();
            var opts = new Options();
            foreach (GenericForm f in new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>())
            {
                Parameter p = f.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
                if (p != null && p.AsElementId() != ElementId.InvalidElementId) used.Add(p.AsElementId());
                foreach (GeometryObject g in f.get_Geometry(opts))
                    if (g is Solid s) foreach (Face face in s.Faces) if (doc.IsPainted(f.Id, face)) used.Add(doc.GetPaintedMaterial(f.Id, face));
            }
            Category cat = doc.OwnerFamily.FamilyCategory;
            if (cat != null)
            {
                if (cat.Material != null) used.Add(cat.Material.Id);
                foreach (Category sc in cat.SubCategories) if (sc.Material != null) used.Add(sc.Material.Id);
            }
            FamilyManager fm = doc.FamilyManager;
            foreach (FamilyParameter fp in fm.Parameters)
            {
                if (fp.Definition.GetDataType() != SpecTypeId.Reference.Material) continue;
                foreach (FamilyType t in fm.Types)
                {
                    ElementId id = t.AsElementId(fp);
                    if (id != null && id != ElementId.InvalidElementId) used.Add(id);
                }
            }
            var unused = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>()
                .Where(m => !used.Contains(m.Id) && !keep.Contains(m.Name)).ToList();
            if (unused.Count == 0) return ("skip", "no unused materials");
            string names = string.Join(", ", unused.Select(m => m.Name));
            if (!delete) return ("skip", unused.Count + " unused (not deleted; delete: true removes them): " + names);
            var gone = new List<string>();
            foreach (Material m in unused)
            {
                try { doc.Delete(m.Id); gone.Add(m.Name); }
                catch (Exception e) { gone.Add("warning: " + m.Name + " not deleted (" + e.Message + ")"); }
            }
            return ("update", "purged " + string.Join("; ", gone));
        }

        // ---- fmc_fam_category ------------------------------------------------------------------------------------------

        /// <summary>
        /// category_set: category sets the family category; subcategory makes it if new (under the family category) and,
        /// with targets or element_ids, moves those solids and lines onto it.
        /// </summary>
        private static (string, string) CategorySet(Document doc, JObject op)
        {
            var done = new List<string>();
            string want = op.Value<string>("category");
            if (!string.IsNullOrEmpty(want))
            {
                Category cat = want.StartsWith("OST_") && Enum.TryParse(want, out BuiltInCategory bic)
                    ? Category.GetCategory(doc, bic)
                    : doc.Settings.Categories.Cast<Category>().FirstOrDefault(c => string.Equals(c.Name, want, StringComparison.OrdinalIgnoreCase));
                if (cat == null) throw new InvalidOperationException("No category " + want);
                if (doc.OwnerFamily.FamilyCategory?.Id != cat.Id)
                {
                    string from = doc.OwnerFamily.FamilyCategory?.Name ?? "";
                    doc.OwnerFamily.FamilyCategory = cat;
                    done.Add("category " + from + " → " + cat.Name);
                }
            }
            string subName = op.Value<string>("subcategory");
            if (!string.IsNullOrEmpty(subName))
            {
                Category sub = SubcategoryOrNull(doc, subName);
                if (sub == null) { sub = doc.Settings.Categories.NewSubcategory(doc.OwnerFamily.FamilyCategory, subName); done.Add("subcategory " + subName + " made"); }
                bool hasTargets = (op["element_ids"] is JArray ids && ids.Count > 0) || (op["targets"] is JArray t && t.Count > 0);
                if (hasTargets)
                {
                    int moved = 0;
                    foreach (Element e in Targets(doc, op))
                    {
                        if (e is GenericForm f) { if (f.Subcategory?.Id == sub.Id) continue; f.Subcategory = sub; moved++; }
                        else if (e is CurveElement c)
                        {
                            GraphicsStyle gs = sub.GetGraphicsStyle(GraphicsStyleType.Projection);
                            if (c.LineStyle?.Id == gs.Id) continue;
                            c.LineStyle = gs; moved++;
                        }
                        else throw new InvalidOperationException(e.GetType().Name + " can't take a subcategory");
                    }
                    if (moved > 0) done.Add(moved + " element(s) on " + sub.Name);
                }
            }
            return done.Count == 0 ? ("skip", "") : ("update", string.Join("; ", done));
        }

        private static Parameter FamilyParam(Document doc, BuiltInParameter bip, params string[] names)
        {
            Parameter p = doc.OwnerFamily.get_Parameter(bip);
            if (p != null) return p;
            foreach (string n in names) { p = doc.OwnerFamily.LookupParameter(n); if (p != null) return p; }
            return null;
        }

        /// <summary>The category-and-parameters flags set_family_params doesn't cover: cut with voids, rebar hosting, IFC export.</summary>
        private static (string, string) FamilyFlags(Document doc, JObject op)
        {
            var changed = new List<string>();
            void Flag(string key, BuiltInParameter bip, params string[] names)
            {
                if (op[key] == null || op[key].Type == JTokenType.Null) return;
                Parameter p = FamilyParam(doc, bip, names) ?? throw new InvalidOperationException("This family's category has no " + key.Replace('_', ' '));
                if (p.IsReadOnly) throw new InvalidOperationException(key.Replace('_', ' ') + " is read-only in this family");
                int want = op.Value<bool>(key) ? 1 : 0;
                if (p.AsInteger() == want) return;
                p.Set(want); changed.Add(key + "=" + (want == 1));
            }
            void Text(string key, BuiltInParameter bip, params string[] names)
            {
                string want = op.Value<string>(key);
                if (want == null) return;
                Parameter p = FamilyParam(doc, bip, names) ?? throw new InvalidOperationException("This family has no " + key.Replace('_', ' ') + " parameter");
                if (p.IsReadOnly) throw new InvalidOperationException(key.Replace('_', ' ') + " is read-only in this family");
                if ((p.AsString() ?? "") == want) return;
                p.Set(want); changed.Add(key + "=" + want);
            }
            Flag("cut_with_voids", BuiltInParameter.FAMILY_ALLOW_CUT_WITH_VOIDS, "Cut with Voids When Loaded");
            Flag("can_host_rebar", BuiltInParameter.FAMILY_CAN_HOST_REBAR, "Can Host Rebar");
            Text("ifc_export_as", BuiltInParameter.IFC_EXPORT_ELEMENT_AS, "Export to IFC As", "IfcExportAs");
            Text("ifc_predefined_type", BuiltInParameter.IFC_EXPORT_PREDEFINEDTYPE, "IFC Predefined Type", "IfcExportType");
            return changed.Count == 0 ? ("skip", "") : ("update", string.Join(", ", changed));
        }

        private static Category SubcategoryOrNull(Document doc, string name)
        {
            Category parent = doc.OwnerFamily.FamilyCategory ?? throw new InvalidOperationException("Set the family category first");
            foreach (Category c in parent.SubCategories) if (string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)) return c;
            return null;
        }

        /// <summary>Solids and lines on a subcategory (its projection or cut line style).</summary>
        private static List<Element> UsersOf(Document doc, Category sub)
        {
            var styles = new HashSet<ElementId>();
            foreach (GraphicsStyleType t in new[] { GraphicsStyleType.Projection, GraphicsStyleType.Cut })
            {
                try { GraphicsStyle gs = sub.GetGraphicsStyle(t); if (gs != null) styles.Add(gs.Id); } catch (Exception) { }
            }
            var users = new List<Element>();
            foreach (GenericForm f in new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>())
                if (f.Subcategory?.Id == sub.Id) users.Add(f);
            foreach (CurveElement c in new FilteredElementCollector(doc).OfClass(typeof(CurveElement)).Cast<CurveElement>())
                if (c.LineStyle != null && styles.Contains(c.LineStyle.Id)) users.Add(c);
            return users;
        }

        private static void MoveTo(Element e, Category sub)
        {
            if (e is GenericForm f) f.Subcategory = sub;
            else if (e is CurveElement c) c.LineStyle = sub.GetGraphicsStyle(GraphicsStyleType.Projection);
        }

        private static string Names(Document doc, List<Element> users) =>
            string.Join(", ", users.Select(u => { string n = FmcDocGeometry.NameOf(u); return string.IsNullOrEmpty(n) ? u.GetType().Name + " " + u.Id : n; }).Distinct());

        /// <summary>
        /// Renames a subcategory. Revit has no rename for one, so a new subcategory takes the old one's graphics and
        /// material, every solid and line on the old moves to it, and the old one is deleted. Skip when it's done already.
        /// </summary>
        private static (string, string) RenameSubcategory(Document doc, JObject op)
        {
            string from = op.Value<string>("name"), to = op.Value<string>("to");
            Category old = SubcategoryOrNull(doc, from);
            Category target = SubcategoryOrNull(doc, to);
            if (old == null) { if (target != null) return ("skip", "already " + to); throw new InvalidOperationException("No subcategory " + from); }
            if (target != null && target.Id != old.Id) throw new InvalidOperationException("A subcategory " + to + " exists already: move the elements with set_subcategory, then delete_subcategory " + from);
            if (string.Equals(from, to, StringComparison.Ordinal)) return ("skip", "");
            Category parent = doc.OwnerFamily.FamilyCategory;
            Category made = doc.Settings.Categories.NewSubcategory(parent, to);
            made.SetLineWeight(old.GetLineWeight(GraphicsStyleType.Projection) ?? 1, GraphicsStyleType.Projection);
            try { int? cw = old.GetLineWeight(GraphicsStyleType.Cut); if (cw.HasValue) made.SetLineWeight(cw.Value, GraphicsStyleType.Cut); } catch (Exception) { }
            if (old.LineColor != null && old.LineColor.IsValid) made.LineColor = old.LineColor;
            if (old.Material != null) made.Material = old.Material;
            ElementId pat = old.GetLinePatternId(GraphicsStyleType.Projection);
            if (pat != null && pat != ElementId.InvalidElementId) made.SetLinePatternId(pat, GraphicsStyleType.Projection);
            var users = UsersOf(doc, old);
            foreach (Element e in users) MoveTo(e, made);
            doc.Delete(old.Id);
            return ("update", from + " → " + to + (users.Count > 0 ? "; moved: " + Names(doc, users) : ""));
        }

        /// <summary>
        /// Deletes a subcategory. One that solids or lines use is refused with their names, unless reassign_to names the
        /// subcategory they move to first.
        /// </summary>
        private static (string, string) DeleteSubcategory(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            Category sub = SubcategoryOrNull(doc, name);
            if (sub == null) return ("skip", "no subcategory " + name);
            var users = UsersOf(doc, sub);
            string reassign = op.Value<string>("reassign_to");
            if (users.Count > 0)
            {
                if (string.IsNullOrEmpty(reassign))
                    throw new InvalidOperationException(name + " is used by " + Names(doc, users) + ": pass reassign_to (a subcategory) to move them first");
                Category to = SubcategoryOrNull(doc, reassign) ?? throw new InvalidOperationException("No subcategory " + reassign + " (add_subcategory makes it)");
                foreach (Element e in users) MoveTo(e, to);
            }
            doc.Delete(sub.Id);
            return ("update", "deleted " + name + (users.Count > 0 ? "; moved to " + reassign + ": " + Names(doc, users) : ""));
        }
    }
}
