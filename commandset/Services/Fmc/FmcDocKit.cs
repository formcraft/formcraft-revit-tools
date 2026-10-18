using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc ops for profiles, switches and kit materials (FAM-040). profile_lines draws a profile family's closed loop
    /// as detail lines and arcs in its Ref. Level plan; set_visible_param ties a solid's Visible to a Yes/No parameter
    /// (so one formula picks which sweep shows); add_material makes a kit material, textures included, from what the
    /// server resolved in the kit's library, and can make it a Material parameter's value. Each answers create, update
    /// or skip like the other ops, and names what it draws so a second run finds it.
    /// </summary>
    public static class FmcDocKit
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);

        private static XYZ Pt(JToken p) => new XYZ(Mm(p[0].Value<double>()), Mm(p[1].Value<double>()), 0);

        // ---- profile_lines ------------------------------------------------------------------------------------------

        public static (string, string) ProfileLines(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            View plan = views.FirstOrDefault(v => v.Name == "Ref. Level") ?? views.FirstOrDefault(v => v.ViewType == ViewType.FloorPlan)
                ?? throw new InvalidOperationException("No Ref. Level plan to draw the profile in (open a profile family template)");

            // The loop in the plan: x across, y up, as a profile family draws it. The server checked it is closed; the
            // last point is snapped to the start so Revit sees the loop exactly closed.
            XYZ start = Pt(op["start"]);
            var segments = (op["segments"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (segments.Count == 0) throw new InvalidOperationException("a profile needs segments");
            var curves = new List<Curve>();
            XYZ from = start;
            for (int k = 0; k < segments.Count; k++)
            {
                XYZ to = k == segments.Count - 1 ? start : Pt(segments[k]["to"]);
                curves.Add(segments[k]["through"] is JArray through ? Arc.Create(from, to, Pt(through)) : (Curve)Line.CreateBound(from, to));
                from = to;
            }

            string subName = op.Value<string>("subcategory");
            GraphicsStyle style = string.IsNullOrEmpty(subName) ? null : FmcDocLod.Subcategory(doc, subName).GetGraphicsStyle(GraphicsStyleType.Projection);

            var existing = FmcDocLod.AllNamed(doc, name).OfType<CurveElement>().ToList();
            if (existing.Count > 0)
            {
                bool same = existing.Count == curves.Count && curves.All(c => existing.Any(e => SameCurve(e.GeometryCurve, c)));
                int restyled = 0;
                if (style != null)
                    foreach (CurveElement e in existing) if (e.LineStyle?.Id != style.Id) { e.LineStyle = style; restyled++; }
                if (restyled > 0) return ("update", restyled + " line(s) on " + subName + (same ? "" : "; the loop exists with another shape: left as it is (rename to redraw)"));
                return ("skip", same ? "" : "exists with another shape: left as it is (rename to redraw)");
            }

            foreach (Curve c in curves)
            {
                DetailCurve dc = doc.FamilyCreate.NewDetailCurve(plan, c);
                if (style != null) dc.LineStyle = style;
                FmcDocGeometry.Label(dc, name);
            }
            int arcs = curves.Count(c => c is Arc);
            return ("create", curves.Count + " detail curve(s), " + arcs + " arc(s), closed, in " + plan.Name);
        }

        private static bool SameCurve(Curve a, Curve b)
        {
            if (a == null || (a is Arc) != (b is Arc)) return false;
            XYZ a0 = a.GetEndPoint(0), a1 = a.GetEndPoint(1), b0 = b.GetEndPoint(0), b1 = b.GetEndPoint(1);
            bool ends = (a0.IsAlmostEqualTo(b0) && a1.IsAlmostEqualTo(b1)) || (a0.IsAlmostEqualTo(b1) && a1.IsAlmostEqualTo(b0));
            return ends && (!(a is Arc) || a.Evaluate(0.5, true).IsAlmostEqualTo(b.Evaluate(0.5, true)));
        }

        // ---- set_visible_param --------------------------------------------------------------------------------------

        public static (string, string) VisibleParam(Document doc, JObject op)
        {
            string solid = op.Value<string>("solid"), param = op.Value<string>("param");
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter fp = fm.get_Parameter(param) ?? throw new InvalidOperationException("No parameter " + param);
            if (fp.Definition.GetDataType() != SpecTypeId.Boolean.YesNo) throw new InvalidOperationException(param + " isn't a Yes/No parameter");
            var items = FmcDocLod.AllNamed(doc, solid).Where(e => e is GenericForm || e is CurveElement || e is FamilyInstance).ToList();
            if (items.Count == 0) throw new InvalidOperationException("Nothing named " + solid);
            int changed = 0;
            foreach (Element e in items)
            {
                // The Visible check box under Graphics (IS_VISIBLE_PARAM), not the visibility settings (GEOM_VISIBILITY_PARAM).
                Parameter visible = e.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM) ?? throw new InvalidOperationException(solid + " has no Visible parameter");
                if (fm.GetAssociatedFamilyParameter(visible)?.Id == fp.Id) continue;
                if (!fm.CanElementParameterBeAssociated(visible)) throw new InvalidOperationException(solid + "'s Visible can't be tied to a parameter");
                fm.AssociateElementParameterToFamilyParameter(visible, fp);
                changed++;
            }
            return changed == 0 ? ("skip", "") : ("update", "Visible ← " + param + (items.Count > 1 ? " on " + changed + " element(s)" : ""));
        }

        // ---- add_material -------------------------------------------------------------------------------------------

        public static (string, string) AddMaterial(Document doc, JObject op)
        {
            // The server puts the resolved kit material on the op; without it Revit has nothing to go on (rule 7).
            JObject kit = op["material"] as JObject ?? throw new InvalidOperationException("the server didn't resolve " + op.Value<string>("name") + " from the kit's material library");
            FmcMaterialKit.Outcome made = FmcMaterialKit.Ensure(doc, kit);
            var notes = new List<string>(made.Changes);

            string paramName = op.Value<string>("param");
            int typesSet = 0;
            if (!string.IsNullOrEmpty(paramName))
            {
                FamilyManager fm = doc.FamilyManager;
                FamilyParameter fp = fm.get_Parameter(paramName) ?? throw new InvalidOperationException("No parameter " + paramName);
                if (fp.Definition.GetDataType() != SpecTypeId.Reference.Material) throw new InvalidOperationException(paramName + " isn't a Material parameter");
                if (!string.IsNullOrEmpty(fp.Formula)) throw new InvalidOperationException(paramName + " has a formula, so its value can't be set");
                FamilyType keep = fm.CurrentType;
                foreach (FamilyType t in fm.Types.Cast<FamilyType>().ToList())
                {
                    if (t.AsElementId(fp) == made.Material.Id) continue;
                    fm.CurrentType = t;
                    fm.Set(fp, made.Material.Id);
                    typesSet++;
                }
                if (keep != null && fm.CurrentType?.Name != keep.Name) fm.CurrentType = keep;
                if (typesSet > 0) notes.Add(paramName + " = " + made.Material.Name + " in " + typesSet + " type(s)");
            }
            notes.AddRange(made.Warnings.Select(w => "warning: " + w));
            string result = made.Created ? "create" : (made.Changes.Count > 0 || typesSet > 0) ? "update" : "skip";
            return (result, string.Join("; ", notes));
        }
    }
}
