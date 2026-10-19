using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc apply (plan B1b): runs a batch of named ops on a session's family document in one TransactionGroup. Each op
    /// answers create, update or skip, so a second run of the same batch changes nothing. The dry run is the real run rolled
    /// back, so its diff is what Revit actually did, warnings included. Any error rolls the whole batch back and names the op.
    /// The server has already validated every op (names, dictionary GUIDs, units in mm).
    /// </summary>
    public static class FmcDocOps
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);

        /// <summary>Collects Revit's warnings instead of showing dialogs; errors make the transaction fail.</summary>
        private sealed class Collector : IFailuresPreprocessor
        {
            public readonly List<string> Warnings = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                {
                    if (f.GetSeverity() == FailureSeverity.Warning) { Warnings.Add(f.GetDescriptionText()); a.DeleteWarning(f); }
                }
                return FailureProcessingResult.Continue;
            }
        }

        /// <param name="progressFile">Where to write per-op progress (FmcDocProgress, F-029); empty writes none.</param>
        public static JObject Apply(Document doc, JArray ops, bool dry, string sharedParameterFile, string progressFile = "")
        {
            if (!doc.IsFamilyDocument) throw new InvalidOperationException("B1 ops build families; project templates come in B5.");
            var results = new JArray();
            var warnings = new List<string>();
            var app = doc.Application;
            IDisposable sp = null;
            var progress = new JObject { ["state"] = "running", ["started"] = DateTime.UtcNow.ToString("o"), ["dry_run"] = dry, ["ops_total"] = ops.Count, ["op"] = 0, ["done"] = 0 };
            FmcDocProgress.Write(progressFile, progress);
            JArray sides = new JArray();
            using (var group = new TransactionGroup(doc, "Formcraft: build"))
            {
                group.Start();
                int i = 0;
                try
                {
                    // F-037: the kit's file only for this batch; the person's comes back in finally
                    sp = FmcSharedParams.Use(app, sharedParameterFile);
                    foreach (JObject op in ops.OfType<JObject>())
                    {
                        i++;
                        progress["op"] = i; progress["kind"] = op.Value<string>("op"); progress["name"] = op.Value<string>("name"); progress["done"] = i - 1;
                        FmcDocProgress.Write(progressFile, progress);
                        var collector = new Collector();
                        using (var t = new Transaction(doc, op.Value<string>("op") + " " + op.Value<string>("name")))
                        {
                            var fho = t.GetFailureHandlingOptions();
                            fho.SetFailuresPreprocessor(collector);
                            t.SetFailureHandlingOptions(fho);
                            t.Start();
                            var (result, detail) = Run(doc, op);
                            var status = t.Commit();
                            if (status != TransactionStatus.Committed) throw new InvalidOperationException("Revit refused it (" + status + ")");
                            results.Add(new JObject { ["op"] = op.Value<string>("op"), ["name"] = op.Value<string>("name"), ["result"] = result, ["detail"] = detail });
                            // An op's own warnings (a texture not on disk) travel in its detail as "warning: …"; list them too.
                            warnings.AddRange((detail ?? "").Split(new[] { "; " }, StringSplitOptions.RemoveEmptyEntries).Where(x => x.StartsWith("warning: "))
                                .Select(x => $"op {i} ({op.Value<string>("op")} {op.Value<string>("name")}): {x.Substring(9)}"));
                        }
                        warnings.AddRange(collector.Warnings.Select(w => $"op {i} ({op.Value<string>("op")} {op.Value<string>("name")}): {w}"));
                    }

                    // F-026: a labelled dimension whose plane ended on the other side of its reference
                    var (wrong, _, _) = FmcDimSides.Check(doc);
                    foreach (JObject w in wrong)
                    {
                        sides.Add(w);
                        warnings.Add($"dimension {w.Value<string>("a")}-{w.Value<string>("b")} ({w.Value<string>("label")}): {w.Value<string>("b")} is now on the other side of {w.Value<string>("a")} than drawn ({w.Value<double>("now_mm")} mm along {w.Value<string>("axis")})");
                    }
                    if (dry) group.RollBack(); else group.Assimilate();
                }
                catch (Exception e)
                {
                    if (group.HasStarted() && !group.HasEnded()) group.RollBack();
                    progress["state"] = "failed"; progress["error"] = e.Message;
                    FmcDocProgress.Write(progressFile, progress);
                    throw new InvalidOperationException($"op {i} failed, nothing was changed: {e.Message}");
                }
                finally
                {
                    sp?.Dispose();
                }
            }
            var summary = new JObject
            {
                ["created"] = results.Count(r => r.Value<string>("result") == "create"),
                ["updated"] = results.Count(r => r.Value<string>("result") == "update"),
                ["skipped"] = results.Count(r => r.Value<string>("result") == "skip"),
                ["warnings"] = warnings.Count,
            };
            progress["state"] = "finished"; progress["done"] = results.Count; progress["result"] = summary;
            FmcDocProgress.Write(progressFile, progress);
            return new JObject
            {
                ["dry_run"] = dry, ["ops"] = results, ["warnings"] = new JArray(warnings),
                ["created"] = summary["created"], ["updated"] = summary["updated"], ["skipped"] = summary["skipped"],
                ["dimension_sides"] = sides,
                ["shared_parameter_file"] = FmcSharedParams.Status(app),
            };
        }

        private static (string Result, string Detail) Run(Document doc, JObject op)
        {
            switch (op.Value<string>("op"))
            {
                case "set_category": return SetCategory(doc, op);
                case "set_family_params": return SetFamilyParams(doc, op);
                case "add_ref_plane": return AddRefPlane(doc, op);
                case "add_family_param": return AddFamilyParam(doc, op);
                case "add_shared_param": return AddSharedParam(doc, op);
                case "set_formula": return SetFormula(doc, op);
                case "add_type": return AddType(doc, op);
                case "set_type_value": return SetTypeValue(doc, op);
                case "add_dimension": return AddDimension(doc, op);
                case "extrusion": return FmcDocGeometry.Extrusion(doc, op, false);
                case "void_extrusion": return FmcDocGeometry.Extrusion(doc, op, true);
                case "set_material_param": return FmcDocGeometry.MaterialParam(doc, op);
                case "set_visibility": return FmcDocGeometry.Visibility(doc, op);
                case "add_connector": return FmcDocMep.AddConnector(doc, op);
                case "link_connector_param": return FmcDocMep.LinkConnectorParam(doc, op);
                case "add_subcategory": return FmcDocLod.AddSubcategory(doc, op);
                case "set_subcategory": return FmcDocLod.SetSubcategory(doc, op);
                case "sweep": return FmcDocLod.MakeSweep(doc, op, false);
                case "void_sweep": return FmcDocLod.MakeSweep(doc, op, true);
                case "revolution": return FmcDocLod.MakeRevolution(doc, op);
                case "import_part": return FmcDocRhino.ImportPart(doc, op);
                case "blend": return FmcDocLod.MakeBlend(doc, op);
                case "symbolic_lines": return FmcDocRecipe.SymbolicLines(doc, op);
                case "lock_face": return FmcDocLod.LockFace(doc, op);
                case "name_template_plane": return FmcDocPlanes.NameTemplatePlane(doc, op);
                case "add_eq_dimension": return FmcDocLod.EqDimension(doc, op);
                case "load_family": return FmcDocLod.LoadFamily(doc, op);
                case "place_nested": return FmcDocLod.PlaceNested(doc, op);
                case "profile_lines": return FmcDocKit.ProfileLines(doc, op);
                case "set_visible_param": return FmcDocKit.VisibleParam(doc, op);
                case "add_material": return FmcDocKit.AddMaterial(doc, op);
                case "array": return FmcDocRecipe.MakeArray(doc, op);
                case "delete_template_element": return FmcDocRecipe.DeleteTemplateElement(doc, op);
                case "set_default_size": return FmcDocRecipe.SetDefaultSize(doc, op);
                case "set_type_image": return FmcDocInspect.SetTypeImage(doc, op);
                default: throw new InvalidOperationException("unknown op " + op.Value<string>("op"));
            }
        }

        private static (string, string) SetCategory(Document doc, JObject op)
        {
            string want = op.Value<string>("name");
            Category cat = want.StartsWith("OST_") && Enum.TryParse(want, out BuiltInCategory bic)
                ? Category.GetCategory(doc, bic)
                : doc.Settings.Categories.Cast<Category>().FirstOrDefault(c => string.Equals(c.Name, want, StringComparison.OrdinalIgnoreCase));
            if (cat == null) throw new InvalidOperationException("No category " + want);
            if (doc.OwnerFamily.FamilyCategory?.Id == cat.Id) return ("skip", cat.Name);
            string from = doc.OwnerFamily.FamilyCategory?.Name ?? "";
            doc.OwnerFamily.FamilyCategory = cat;
            return ("update", from + " → " + cat.Name);
        }

        private static (string, string) SetFamilyParams(Document doc, JObject op)
        {
            var changed = new List<string>();
            void Flag(string key, BuiltInParameter bip)
            {
                if (op[key] == null) return;
                Parameter p = doc.OwnerFamily.get_Parameter(bip);
                if (p == null || p.IsReadOnly) return;
                int want = op.Value<bool>(key) ? 1 : 0;
                if (p.AsInteger() == want) return;
                p.Set(want);
                changed.Add(key + "=" + (want == 1));
            }
            Flag("work_plane_based", BuiltInParameter.FAMILY_WORK_PLANE_BASED);
            Flag("always_vertical", BuiltInParameter.FAMILY_ALWAYS_VERTICAL);
            Flag("shared", BuiltInParameter.FAMILY_SHARED);
            Flag("room_calculation_point", BuiltInParameter.ROOM_CALCULATION_POINT);
            // Part Type (STD-002 5.2): a board must be Panelboard, Switchboard or Other Panel, or Revit gives it no
            // Distribution System and refuses it as a circuit's panel.
            string partType = op.Value<string>("part_type") ?? "";
            if (partType.Length > 0)
            {
                if (!System.Enum.TryParse(partType.Replace(" ", ""), true, out PartType pt))
                    throw new InvalidOperationException("Part Type " + partType + " isn't one Revit knows");
                Parameter p = doc.OwnerFamily.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE)
                    ?? throw new InvalidOperationException("This family's category has no Part Type (set_category first: a board is Electrical Equipment)");
                if (p.IsReadOnly) throw new InvalidOperationException("Part Type is read-only in this family");
                if (p.AsInteger() != (int)pt)
                {
                    p.Set((int)pt);
                    changed.Add("part_type=" + pt);
                }
            }
            return changed.Count == 0 ? ("skip", "") : ("update", string.Join(", ", changed));
        }

        private static View PlanView(Document doc, string name)
        {
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            return views.FirstOrDefault(v => v.Name == (string.IsNullOrEmpty(name) ? "Ref. Level" : name))
                ?? views.FirstOrDefault(v => v.ViewType == ViewType.FloorPlan)
                ?? throw new InvalidOperationException("No view " + name + " to draw in");
        }

        private static ReferencePlane Plane(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name);

        private static (string, string) AddRefPlane(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            var from = (JArray)op["from"]; var to = (JArray)op["to"];
            View view = PlanView(doc, op.Value<string>("view"));
            // In plan, [x, y]; in an elevation or section, [across, up] in that view (Front: [x, z]), so level planes
            // (sill, head, top of leaf) can be drawn and dimensioned too.
            bool upright = view.ViewType == ViewType.Elevation || view.ViewType == ViewType.Section;
            XYZ P(JArray q) => upright
                ? view.RightDirection * Mm(q[0].Value<double>()) + view.UpDirection * Mm(q[1].Value<double>())
                : new XYZ(Mm(q[0].Value<double>()), Mm(q[1].Value<double>()), 0);
            XYZ a = P(from), b = P(to);
            ReferencePlane plane = Plane(doc, name);
            string result = "skip", detail = "";
            if (plane == null)
            {
                plane = doc.FamilyCreate.NewReferencePlane(a, b, view.ViewDirection.Negate(), view);
                plane.Name = name;
                result = "create";
            }
            else if (!plane.BubbleEnd.IsAlmostEqualTo(a) || !plane.FreeEnd.IsAlmostEqualTo(b))
            {
                detail = "exists in another place: left as it is (moving planes comes with lock_alignment, B1c)";
            }
            string reference = op.Value<string>("is_reference");
            if (!string.IsNullOrEmpty(reference) && Enum.TryParse(reference, out FamilyInstanceReferenceType kind))
            {
                Parameter p = plane.get_Parameter(BuiltInParameter.ELEM_REFERENCE_NAME);
                if (p != null && !p.IsReadOnly && p.AsInteger() != (int)kind) { p.Set((int)kind); if (result == "skip") result = "update"; detail = (detail + " is reference " + reference).Trim(); }
            }
            return (result, detail);
        }

        private static ForgeTypeId Spec(string type)
        {
            switch (type)
            {
                case "Length": return SpecTypeId.Length;
                case "Number": return SpecTypeId.Number;
                case "Integer": return SpecTypeId.Int.Integer;
                case "YesNo": return SpecTypeId.Boolean.YesNo;
                case "Text": return SpecTypeId.String.Text;
                case "Material": return SpecTypeId.Reference.Material;
                case "Area": return SpecTypeId.Area;
                case "Volume": return SpecTypeId.Volume;
                case "Angle": return SpecTypeId.Angle;
                case "Voltage": return SpecTypeId.ElectricalPotential;
                case "ApparentPower": return SpecTypeId.ApparentPower;
                case "NumberOfPoles": return SpecTypeId.Int.NumberOfPoles;
                case "PipeSize": return SpecTypeId.PipeSize;
                case "Flow": return SpecTypeId.Flow;
                case "LoadClassification": return SpecTypeId.Reference.LoadClassification;
                default: throw new InvalidOperationException("unknown data type " + type);
            }
        }

        private static ForgeTypeId Group(string group)
        {
            switch (group)
            {
                case "Constraints": return GroupTypeId.Constraints;
                case "Data": return GroupTypeId.Data;
                case "Text": return GroupTypeId.Text;
                case "Materials": return GroupTypeId.Materials;
                case "IdentityData": return GroupTypeId.IdentityData;
                case "Graphics": return GroupTypeId.Graphics;
                case "Electrical": return GroupTypeId.Electrical;
                case "ElectricalLoads": return GroupTypeId.ElectricalLoads;
                case "Mechanical": return GroupTypeId.Mechanical;
                case "Plumbing": return GroupTypeId.Plumbing;
                case "General": return GroupTypeId.General;
                default: return GroupTypeId.Geometry;
            }
        }

        private static (string, string) AddFamilyParam(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            string name = op.Value<string>("name");
            bool instance = op.Value<bool?>("instance") == true;
            FamilyParameter p = fm.get_Parameter(name);
            if (p == null) { fm.AddParameter(name, Group(op.Value<string>("group")), Spec(op.Value<string>("type")), instance); return ("create", op.Value<string>("type")); }
            if (p.IsInstance == instance) return ("skip", "");
            if (instance) fm.MakeInstance(p); else fm.MakeType(p);
            return ("update", instance ? "now instance" : "now type");
        }

        private static (string, string) AddSharedParam(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            Guid guid = Guid.Parse(op.Value<string>("guid"));
            if (fm.GetParameters().Any(x => x.IsShared && x.GUID == guid)) return ("skip", "");
            DefinitionFile df = doc.Application.OpenSharedParameterFile() ?? throw new InvalidOperationException("The kit's shared parameter file isn't set");
            ExternalDefinition def = df.Groups.SelectMany(g => g.Definitions.Cast<ExternalDefinition>()).FirstOrDefault(d => d.GUID == guid)
                ?? throw new InvalidOperationException("GUID " + guid + " isn't in " + Path.GetFileName(doc.Application.SharedParametersFilename));
            fm.AddParameter(def, Group(op.Value<string>("group") ?? "Data"), op.Value<bool?>("instance") == true);
            return ("create", def.Name);
        }

        private static (string, string) SetFormula(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter p = fm.get_Parameter(op.Value<string>("name")) ?? throw new InvalidOperationException("No parameter " + op.Value<string>("name"));
            string formula = op.Value<string>("formula") ?? "";
            if ((p.Formula ?? "") == formula) return ("skip", "");
            fm.SetFormula(p, formula.Length == 0 ? null : formula);
            return ("update", formula);
        }

        private static (string, string) AddType(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            string name = op.Value<string>("name");
            if (fm.Types.Cast<FamilyType>().Any(t => t.Name == name)) return ("skip", "");
            fm.NewType(name);
            return ("create", "");
        }

        private static (string, string) SetTypeValue(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            FamilyType type = fm.Types.Cast<FamilyType>().FirstOrDefault(t => t.Name == op.Value<string>("type")) ?? throw new InvalidOperationException("No type " + op.Value<string>("type"));
            FamilyParameter p = fm.get_Parameter(op.Value<string>("param")) ?? throw new InvalidOperationException("No parameter " + op.Value<string>("param"));
            fm.CurrentType = type;
            JToken v = op["value"];
            ForgeTypeId spec = p.Definition.GetDataType();
            switch (p.StorageType)
            {
                case StorageType.Double:
                {
                    double raw = v.Value<double>();
                    double want = spec == SpecTypeId.Length || spec == SpecTypeId.PipeSize ? Mm(raw)
                        : spec == SpecTypeId.Angle ? raw * Math.PI / 180
                        : spec == SpecTypeId.ElectricalPotential ? UnitUtils.ConvertToInternalUnits(raw, UnitTypeId.Volts)
                        : spec == SpecTypeId.ApparentPower ? UnitUtils.ConvertToInternalUnits(raw, UnitTypeId.VoltAmperes)
                        : spec == SpecTypeId.Flow ? UnitUtils.ConvertToInternalUnits(raw, UnitTypeId.LitersPerSecond)
                        : raw;
                    double? now = type.AsDouble(p);
                    if (now.HasValue && Math.Abs(now.Value - want) < 1e-9) return ("skip", "");
                    fm.Set(p, want);
                    break;
                }
                case StorageType.Integer:
                {
                    int want = v.Type == JTokenType.Boolean ? (v.Value<bool>() ? 1 : 0) : v.Value<int>();
                    if (type.AsInteger(p) == want) return ("skip", "");
                    fm.Set(p, want);
                    break;
                }
                case StorageType.String:
                {
                    string want = v.ToString();
                    if (type.AsString(p) == want) return ("skip", "");
                    fm.Set(p, want);
                    break;
                }
                default: throw new InvalidOperationException(p.Definition.Name + " can't be set by value");
            }
            return ("update", v.ToString());
        }

        private static (string, string) AddDimension(Document doc, JObject op)
        {
            var between = (JArray)op["between"];
            ReferencePlane a = Plane(doc, between[0].ToString()) ?? throw new InvalidOperationException("No reference plane " + between[0]);
            ReferencePlane b = Plane(doc, between[1].ToString()) ?? throw new InvalidOperationException("No reference plane " + between[1]);
            View view = PlanView(doc, op.Value<string>("view"));
            string label = op.Value<string>("label");
            FamilyParameter p = string.IsNullOrEmpty(label) ? null : doc.FamilyManager.get_Parameter(label) ?? throw new InvalidOperationException("No parameter " + label);
            // Already there: a dimension in this view referencing both planes.
            Dimension existing = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Dimension)).Cast<Dimension>().FirstOrDefault(d =>
            {
                var ids = d.References.Cast<Reference>().Select(r => r.ElementId).ToList();
                return ids.Contains(a.Id) && ids.Contains(b.Id);
            });
            if (existing != null)
            {
                if (p == null || existing.FamilyLabel?.Id == p.Id) return ("skip", "");
                existing.FamilyLabel = p;
                return ("update", "labelled " + label);
            }
            XYZ dir = (a.FreeEnd - a.BubbleEnd).Normalize();
            XYZ across = b.BubbleEnd - a.BubbleEnd;
            double offset = Mm(op.Value<double?>("offset") ?? 300);
            XYZ start = a.BubbleEnd + dir * offset;
            XYZ normal = dir.CrossProduct(view.ViewDirection).Normalize();
            XYZ end = start + normal * across.DotProduct(normal);
            if (start.DistanceTo(end) < 1e-6) throw new InvalidOperationException(a.Name + " and " + b.Name + " are not apart");
            var refs = new ReferenceArray();
            refs.Append(a.GetReference());
            refs.Append(b.GetReference());
            Dimension dim = doc.FamilyCreate.NewLinearDimension(view, Line.CreateBound(start, end), refs);
            // F-026: keep the side b was drawn on, before the label can move it
            if (p != null) FmcDimSides.Record(dim, a, b);
            if (p != null) dim.FamilyLabel = p;
            return ("create", p != null ? "labelled " + label : "");
        }
    }
}
