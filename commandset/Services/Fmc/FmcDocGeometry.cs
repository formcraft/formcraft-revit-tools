using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc geometry ops (plan B1c): extrusions and voids locked to named reference planes, the material parameter, the
    /// visibility, and the flex check. A solid made by an op keeps its op name in extensible storage, so a second run finds
    /// it and skips (solids have no name of their own in Revit).
    /// </summary>
    public static class FmcDocGeometry
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static readonly Guid SchemaId = new Guid("6b1a3f0e-4c2d-4f7a-9a51-2f8e0d9c7b31");

        private static Schema NameSchema()
        {
            Schema s = Schema.Lookup(SchemaId);
            if (s != null) return s;
            var b = new SchemaBuilder(SchemaId);
            b.SetSchemaName("FMC_OpName");
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Public);
            b.SetVendorId("Formcraft");
            b.AddSimpleField("Name", typeof(string));
            return b.Finish();
        }

        public static string NameOf(Element e)
        {
            Schema s = Schema.Lookup(SchemaId);
            if (s == null) return "";
            Entity en = e.GetEntity(s);
            return en.IsValid() ? en.Get<string>("Name") ?? "" : "";
        }

        /// <summary>Stores the op name on an element (solids, connectors), so a second run finds it.</summary>
        public static void Label(Element e, string name) => Name(e, name);

        private static void Name(Element e, string name)
        {
            Schema s = NameSchema();
            var en = new Entity(s);
            en.Set("Name", name);
            e.SetEntity(en);
        }

        public static GenericForm Solid(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>().FirstOrDefault(f => NameOf(f) == name);

        private static ReferencePlane Plane(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name)
            ?? throw new InvalidOperationException("No reference plane " + name);

        private static View ViewNamed(Document doc, string name, ViewType kind)
        {
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            return views.FirstOrDefault(v => v.Name == name) ?? views.FirstOrDefault(v => v.ViewType == kind)
                ?? throw new InvalidOperationException("No " + kind + " view in the family");
        }

        /// <summary>Where a vertical plane sits in plan: x for a left/right plane, y for a front/back plane.</summary>
        private static (bool IsX, double At) PlanPosition(ReferencePlane p)
        {
            XYZ d = (p.FreeEnd - p.BubbleEnd).Normalize();
            return Math.Abs(d.Y) > Math.Abs(d.X) ? (true, p.BubbleEnd.X) : (false, p.BubbleEnd.Y);
        }

        public static (string, string) Extrusion(Document doc, JObject op, bool isVoid)
        {
            string name = op.Value<string>("name");
            GenericForm existing = Solid(doc, name);
            double start = Mm(op.Value<double?>("start") ?? 0), end = Mm(op.Value<double?>("end") ?? 1000);
            if (existing is Extrusion ex)
            {
                if (Math.Abs(ex.StartOffset - start) < 1e-9 && Math.Abs(ex.EndOffset - end) < 1e-9) return ("skip", "");
                ex.StartOffset = start; ex.EndOffset = end;
                return ("update", "start/end changed (the profile is left as it is)");
            }

            var loop = new CurveArray();
            string[] rect = (op["rect"] as JArray)?.Select(x => x.ToString()).ToArray();
            ReferencePlane[] sides = null;
            if (rect != null && rect.Length == 4)
            {
                sides = rect.Select(r => Plane(doc, r)).ToArray();   // left, right, front, back
                double x1 = PlanPosition(sides[0]).At, x2 = PlanPosition(sides[1]).At, y1 = PlanPosition(sides[2]).At, y2 = PlanPosition(sides[3]).At;
                var c = new[] { new XYZ(x1, y1, 0), new XYZ(x2, y1, 0), new XYZ(x2, y2, 0), new XYZ(x1, y2, 0) };
                for (int k = 0; k < 4; k++) loop.Append(Line.CreateBound(c[k], c[(k + 1) % 4]));
            }
            // F-059: sketch "front" draws [x, z] in the front elevation with depth toward the viewer (-y); "right" draws
            // [y, z] with depth along +x; "plan" (default) draws [x, y] with depth up (z). Before, every extrusion was in plan.
            string sk = (op.Value<string>("sketch") ?? "plan").ToLowerInvariant();
            if (rect != null && sk != "plan") throw new InvalidOperationException("rect (four planes) works with sketch plan only");
            else if (rect == null)
            {
                var pts = (op["points"] as JArray ?? new JArray()).Select(p => sk == "front" ? new XYZ(Mm(p[0].Value<double>()), 0, Mm(p[1].Value<double>()))
                    : sk == "right" ? new XYZ(0, Mm(p[0].Value<double>()), Mm(p[1].Value<double>())) : new XYZ(Mm(p[0].Value<double>()), Mm(p[1].Value<double>()), 0)).ToList();
                if (pts.Count < 3) throw new InvalidOperationException("an extrusion needs rect (four planes) or at least three points");
                for (int k = 0; k < pts.Count; k++) loop.Append(Line.CreateBound(pts[k], pts[(k + 1) % pts.Count]));
            }
            var profile = new CurveArrArray();
            profile.Append(loop);
            XYZ normal = sk == "front" ? XYZ.BasisY.Negate() : sk == "right" ? XYZ.BasisX : XYZ.BasisZ;
            SketchPlane sketch = SketchPlane.Create(doc, Autodesk.Revit.DB.Plane.CreateByNormalAndOrigin(normal, XYZ.Zero));
            Extrusion made = doc.FamilyCreate.NewExtrusion(!isVoid, profile, sketch, end - start);
            made.StartOffset = start; made.EndOffset = end;
            Name(made, name);

            // Lock each side to its plane (in plan), and the top to a level plane in an elevation when one is named.
            var locked = new List<string>();
            doc.Regenerate();
            if (sides != null)
            {
                View plan = ViewNamed(doc, op.Value<string>("view") ?? "Ref. Level", ViewType.FloorPlan);
                foreach (ReferencePlane side in sides)
                    if (LockFace(doc, plan, made, side.GetReference(), side.Normal)) locked.Add(side.Name);
            }
            string top = op.Value<string>("end_plane");
            if (!string.IsNullOrEmpty(top))
            {
                ReferencePlane tp = Plane(doc, top);
                View front = ViewNamed(doc, "Front", ViewType.Elevation);
                if (LockFace(doc, front, made, tp.GetReference(), XYZ.BasisZ)) locked.Add(top);
            }
            return ("create", (isVoid ? "void" : "solid") + (sk != "plan" ? ", sketched " + sk : "") + (locked.Count > 0 ? ", locked to " + string.Join(", ", locked) : ""));
        }

        /// <summary>Aligns and locks the solid's planar face that faces the same way as the plane and lies on it.</summary>
        internal static bool LockFace(Document doc, View view, GenericForm form, Reference planeRef, XYZ normal)
        {
            var options = new Options { ComputeReferences = true, View = view, IncludeNonVisibleObjects = true };
            foreach (GeometryObject g in form.get_Geometry(options))
            {
                if (!(g is Autodesk.Revit.DB.Solid solid)) continue;
                foreach (Face f in solid.Faces)
                {
                    if (!(f is PlanarFace pf) || f.Reference == null) continue;
                    if (!pf.FaceNormal.IsAlmostEqualTo(normal) && !pf.FaceNormal.IsAlmostEqualTo(normal.Negate())) continue;
                    Element pe = doc.GetElement(planeRef);
                    if (pe is ReferencePlane rp && Math.Abs((pf.Origin - rp.BubbleEnd).DotProduct(rp.Normal)) > 1e-6) continue;
                    try
                    {
                        Dimension a = doc.FamilyCreate.NewAlignment(view, planeRef, f.Reference);
                        a.IsLocked = true;
                        return true;
                    }
                    catch (Exception) { return false; }
                }
            }
            return false;
        }

        public static (string, string) MaterialParam(Document doc, JObject op)
        {
            GenericForm form = Solid(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No solid " + op.Value<string>("name"));
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter fp = fm.get_Parameter(op.Value<string>("param")) ?? throw new InvalidOperationException("No parameter " + op.Value<string>("param"));
            Parameter mat = form.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM) ?? throw new InvalidOperationException("The solid has no material parameter");
            if (fm.GetAssociatedFamilyParameter(mat)?.Id == fp.Id) return ("skip", "");
            fm.AssociateElementParameterToFamilyParameter(mat, fp);
            return ("update", "material from " + fp.Definition.Name);
        }

        public static (string, string) Visibility(Document doc, JObject op)
        {
            GenericForm form = Solid(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No solid " + op.Value<string>("name"));
            FamilyElementVisibility v = form.GetVisibility();
            var changed = new List<string>();
            void Flag(string key, Func<bool> get, Action<bool> set)
            {
                if (op[key] == null) return;
                bool want = op.Value<bool>(key);
                if (get() == want) return;
                set(want);
                changed.Add(key + "=" + want);
            }
            var flags = new (string key, Func<bool> get, Action<bool> set)[]
            {
                ("coarse", () => v.IsShownInCoarse, x => v.IsShownInCoarse = x),
                ("medium", () => v.IsShownInMedium, x => v.IsShownInMedium = x),
                ("fine", () => v.IsShownInFine, x => v.IsShownInFine = x),
                ("plan_rcp", () => v.IsShownInTopBottom, x => v.IsShownInTopBottom = x),
                ("front_back", () => v.IsShownInFrontBack, x => v.IsShownInFrontBack = x),
                ("left_right", () => v.IsShownInLeftRight, x => v.IsShownInLeftRight = x),
            };
            // Turn things on before turning others off: Revit refuses any moment where every detail level is off
            // ("Cannot make this element invisible in all levels of detail"), even if the next flag would fix it.
            foreach (var f in flags) if (op[f.key] != null && op.Value<bool>(f.key)) Flag(f.key, f.get, f.set);
            foreach (var f in flags) if (op[f.key] != null && !op.Value<bool>(f.key)) Flag(f.key, f.get, f.set);
            bool levelsLeft = v.IsShownInCoarse || v.IsShownInMedium || v.IsShownInFine;
            if (!levelsLeft) throw new InvalidOperationException("at least one of coarse, medium and fine must stay on (Revit rule)");
            if (changed.Count == 0) return ("skip", "");
            form.SetVisibility(v);
            return ("update", string.Join(", ", changed));
        }

        private sealed class ErrorCollector : IFailuresPreprocessor
        {
            public readonly List<string> Errors = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                {
                    if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                    else Errors.Add(f.GetDescriptionText());
                }
                return Errors.Count > 0 ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }

        /// <summary>
        /// Flex: every type in turn, regenerated; constraint errors per type, and the labelled dimensions whose plane ended
        /// on the other side of its reference in that type (F-026, F-039). Nothing is kept.
        /// </summary>
        public static JObject Flex(Document doc)
        {
            FamilyManager fm = doc.FamilyManager;
            var results = new JArray();
            int sidesChecked = 0, sidesUnrecorded = 0;
            using (var group = new TransactionGroup(doc, "Formcraft: flex"))
            {
                group.Start();
                foreach (FamilyType type in fm.Types.Cast<FamilyType>().Where(t => !string.IsNullOrWhiteSpace(t.Name)).ToList())
                {
                    var c = new ErrorCollector();
                    using (var t = new Transaction(doc, "flex " + type.Name))
                    {
                        var fho = t.GetFailureHandlingOptions();
                        fho.SetFailuresPreprocessor(c);
                        t.SetFailureHandlingOptions(fho);
                        t.Start();
                        string error = "";
                        var wrong = new List<JObject>();
                        try
                        {
                            fm.CurrentType = type;
                            doc.Regenerate();
                            var sides = FmcDimSides.Check(doc);
                            wrong = sides.Wrong;
                            sidesChecked = Math.Max(sidesChecked, sides.Checked);
                            sidesUnrecorded = Math.Max(sidesUnrecorded, sides.Unrecorded);
                        }
                        catch (Exception e) { error = e.Message; }
                        var status = t.Commit();
                        if (status != TransactionStatus.Committed && error.Length == 0 && c.Errors.Count == 0) error = "Revit couldn't regenerate it (" + status + ")";
                        var all = c.Errors.Concat(error.Length > 0 ? new[] { error } : new string[0]).ToList();
                        results.Add(new JObject { ["type"] = type.Name, ["ok"] = all.Count == 0, ["errors"] = new JArray(all), ["dimension_sides"] = new JArray(wrong) });
                    }
                }
                group.RollBack();
            }
            return new JObject
            {
                ["types"] = results, ["ok"] = results.All(r => r.Value<bool>("ok")),
                ["dimension_sides"] = new JObject { ["checked"] = sidesChecked, ["unrecorded"] = sidesUnrecorded },
            };
        }
    }
}
