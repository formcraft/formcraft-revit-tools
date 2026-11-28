using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Family editor ops on an fmc_doc session (fmc_fam_param, fmc_fam_type, fmc_fam_ref are thin wrappers over them):
    /// parameters (rename, regroup, reporting, formula, remove), types (rename, delete, flex matrix) and reference planes
    /// (rename, move, delete). Each answers create, update, skip or delete inside FmcDocOps.Apply's transaction, so the dry
    /// run is the real run rolled back and says what would go with a deleted item. A real run of a delete needs a person's
    /// approval in the pane's queue for exactly this batch (ClaimPersonApproval); the server never sends one without it.
    /// </summary>
    public static class FmcFamEdit
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double ToMm(double v) => UnitUtils.ConvertFromInternalUnits(v, UnitTypeId.Millimeters);

#if REVIT2024_OR_GREATER
        internal static long IdValue(ElementId id) => id.Value;
        private static ElementId IdOf(long v) => new ElementId(v);
#else
        internal static long IdValue(ElementId id) => id.IntegerValue;
        private static ElementId IdOf(long v) => new ElementId((int)v);
#endif

        // ---- the person gate ----------------------------------------------------------------------------------------

        /// <summary>
        /// A real run with a delete op goes ahead only when %APPDATA%\Formcraft\ai_queue holds a person's approval for this
        /// session, these exact ops and this confirm token (the pane's Approve sends the queued batch here). The approval is
        /// marked used before anything changes, so a replay is refused. Throws when there is none.
        /// </summary>
        public static void ClaimPersonApproval(JObject parameters, JArray ops)
        {
            string token = parameters.Value<string>("confirm_token") ?? "";
            string session = parameters.Value<string>("session") ?? "";
            const string refused = "A delete (param_remove, type_delete, plane_delete) runs only on a person's Approve in the Formcraft pane: " +
                "run it as a dry run, then dry_run false with its confirm_token queues it for them. Nothing was changed.";
            if (token.Length == 0) throw new InvalidOperationException(refused);
            string dir = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.ApplicationData), "Formcraft", "ai_queue");
            if (!Directory.Exists(dir)) throw new InvalidOperationException(refused);
            foreach (string file in Directory.GetFiles(dir, "*.json"))
            {
                JObject item;
                try { item = JObject.Parse(File.ReadAllText(file)); } catch (Exception) { continue; }
                if (item.Value<string>("command") != "fmc_doc_apply") continue;
                if (!(item["params"] is JObject p)) continue;
                if (p.Value<string>("confirm_token") != token || p.Value<string>("session") != session) continue;
                if (!JToken.DeepEquals(p["ops"], ops)) continue;
                if (!FmcFamEditRules.PersonApproved(item.Value<string>("status"), item.Value<string>("by"))) continue;
                item["status"] = "used";
                item["at"] = DateTime.UtcNow.ToString("o");
                File.WriteAllText(file, item.ToString());
                return;
            }
            throw new InvalidOperationException(refused);
        }

        public static bool HasDelete(JArray ops) => ops.OfType<JObject>().Any(o => FmcFamEditRules.IsDeleteOp(o.Value<string>("op")));

        public static bool IsFlexMatrix(JArray ops) => ops.Count == 1 && (ops[0] as JObject)?.Value<string>("op") == "type_flex_matrix";

        // ---- ops ------------------------------------------------------------------------------------------------------

        public static (string Result, string Detail) Run(Document doc, JObject op)
        {
            switch (op.Value<string>("op"))
            {
                case "param_rename": return ParamRename(doc, op);
                case "param_regroup": return ParamRegroup(doc, op);
                case "param_set_reporting": return ParamReporting(doc, op);
                case "param_set_formula": return ParamFormula(doc, op);
                case "param_remove": return ParamRemove(doc, op);
                case "type_rename": return TypeRename(doc, op);
                case "type_delete": return TypeDelete(doc, op);
                case "plane_rename": return PlaneRename(doc, op);
                case "plane_move": return PlaneMove(doc, op);
                case "plane_delete": return PlaneDelete(doc, op);
                case "type_flex_matrix": throw new InvalidOperationException("type_flex_matrix is a read: send it on its own");
                default: throw new InvalidOperationException("unknown op " + op.Value<string>("op"));
            }
        }

        private static FamilyParameter FamilyParam(Document doc, string name) =>
            doc.FamilyManager.GetParameters().FirstOrDefault(p => p.Definition.Name == name);

        private static void NotBuiltIn(FamilyParameter p)
        {
            if (IdValue(p.Id) < 0) throw new InvalidOperationException(p.Definition.Name + " is a built-in parameter: Revit doesn't let it change");
        }

        private static (string, string) ParamRename(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            string name = op.Value<string>("name"), to = op.Value<string>("new_name");
            FamilyParameter p = FamilyParam(doc, name);
            if (p == null)
            {
                if (FamilyParam(doc, to) != null) return ("skip", "already " + to);
                throw new InvalidOperationException("No family parameter " + name);
            }
            NotBuiltIn(p);
            if (p.IsShared) throw new InvalidOperationException(name + " is a shared parameter: its name comes from the shared parameter file (the kit's dictionary)");
            string why = FmcFamEditRules.RenameProblem(name, to, fm.GetParameters().Select(x => x.Definition.Name));
            if (why != null) throw new InvalidOperationException(why);
            fm.RenameParameter(p, to);
            return ("update", name + " → " + to);
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
                default: return GroupTypeId.Geometry;  // Dimensions
            }
        }

        private static (string, string) ParamRegroup(Document doc, JObject op)
        {
            FamilyParameter p = FamilyParam(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No family parameter " + op.Value<string>("name"));
            NotBuiltIn(p);
            ForgeTypeId want = Group(op.Value<string>("group"));
            InternalDefinition def = p.Definition as InternalDefinition ?? throw new InvalidOperationException(p.Definition.Name + " can't be regrouped");
            if (def.GetGroupTypeId() == want) return ("skip", "");
            def.SetGroupTypeId(want);
            return ("update", "now under " + op.Value<string>("group"));
        }

        private static (string, string) ParamReporting(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter p = FamilyParam(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No family parameter " + op.Value<string>("name"));
            NotBuiltIn(p);
            bool on = op.Value<bool>("on");
            if (p.IsReporting == on) return ("skip", "");
            if (on)
            {
                if (!string.IsNullOrEmpty(p.Formula)) throw new InvalidOperationException(p.Definition.Name + " has a formula: clear it before making it reporting");
                fm.MakeReporting(p);
            }
            else fm.MakeNonReporting(p);
            return ("update", on ? "now reporting" : "now driving");
        }

        private static (string, string) ParamFormula(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter p = FamilyParam(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No family parameter " + op.Value<string>("name"));
            string formula = op["formula"]?.Type == JTokenType.Null ? "" : (op.Value<string>("formula") ?? "");
            if ((p.Formula ?? "") == formula) return ("skip", "");
            if (formula.Length > 0 && p.IsReporting) throw new InvalidOperationException(p.Definition.Name + " is reporting: make it driving first (param_set_reporting on false)");
            fm.SetFormula(p, formula.Length == 0 ? null : formula);
            return ("update", formula.Length == 0 ? "formula cleared" : formula);
        }

        private static (string, string) ParamRemove(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            string name = op.Value<string>("name");
            FamilyParameter p = FamilyParam(doc, name);
            if (p == null) return ("skip", "not in the family");
            NotBuiltIn(p);
            var users = FmcFamEditRules.FormulasUsing(name, fm.GetParameters().Select(x => new KeyValuePair<string, string>(x.Definition.Name, x.Formula ?? "")));
            if (users.Count > 0) throw new InvalidOperationException("formulas of " + string.Join(", ", users) + " use " + name + ": change them first");
            int labels = new FilteredElementCollector(doc).OfClass(typeof(Dimension)).Cast<Dimension>().Count(d => { try { return d.FamilyLabel?.Id == p.Id; } catch (Exception) { return false; } });
            int associated = p.AssociatedParameters?.Size ?? 0;
            fm.RemoveParameter(p);
            var detail = new List<string> { (p.IsShared ? "shared " : "") + (p.IsInstance ? "instance" : "type") + " parameter removed" };
            if (labels > 0) detail.Add(labels + " dimension(s) lose their label");
            if (associated > 0) detail.Add(associated + " element parameter(s) lose their association");
            return ("delete", string.Join("; ", detail));
        }

        private static List<FamilyType> Types(Document doc) =>
            doc.FamilyManager.Types.Cast<FamilyType>().Where(t => !string.IsNullOrWhiteSpace(t.Name)).ToList();

        private static (string, string) TypeRename(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            string name = op.Value<string>("name"), to = op.Value<string>("new_name");
            var types = Types(doc);
            FamilyType t = types.FirstOrDefault(x => x.Name == name);
            if (t == null)
            {
                if (types.Any(x => x.Name == to)) return ("skip", "already " + to);
                throw new InvalidOperationException("No type " + name);
            }
            string why = FmcFamEditRules.RenameProblem(name, to, types.Select(x => x.Name));
            if (why != null) throw new InvalidOperationException(why);
            fm.CurrentType = t;
            fm.RenameCurrentType(to);
            return ("update", name + " → " + to);
        }

        private static (string, string) TypeDelete(Document doc, JObject op)
        {
            FamilyManager fm = doc.FamilyManager;
            var types = Types(doc);
            FamilyType t = types.FirstOrDefault(x => x.Name == op.Value<string>("name"));
            if (t == null) return ("skip", "not in the family");
            if (!FmcFamEditRules.CanDeleteType(types.Count)) throw new InvalidOperationException(t.Name + " is the family's only type: Revit needs one");
            fm.CurrentType = t;
            fm.DeleteCurrentType();
            FamilyType next = Types(doc).FirstOrDefault();
            if (next != null) fm.CurrentType = next;
            return ("delete", (types.Count - 1) + " type(s) left");
        }

        // ---- reference planes -----------------------------------------------------------------------------------------

        private static ReferencePlane FindPlane(Document doc, JObject op, bool mayBeGone = false)
        {
            string name = (op.Value<string>("name") ?? "").Trim();
            long? id = op.Value<long?>("id");
            ReferencePlane plane = id.HasValue
                ? doc.GetElement(IdOf(id.Value)) as ReferencePlane
                : new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name);
            if (plane == null && !mayBeGone) throw new InvalidOperationException("No reference plane " + (id.HasValue ? "#" + id.Value : name));
            return plane;
        }

        private static void NotOrigin(ReferencePlane plane)
        {
            Parameter origin = plane.get_Parameter(BuiltInParameter.DATUM_PLANE_DEFINES_ORIGIN);
            if (FmcFamEditRules.IsOriginPlaneName(plane.Name) || (origin != null && origin.AsInteger() == 1))
                throw new InvalidOperationException((string.IsNullOrEmpty(plane.Name) ? "#" + IdValue(plane.Id) : plane.Name) + " defines the family's origin: a tool never renames, moves or deletes it");
        }

        private static (string, string) PlaneRename(Document doc, JObject op)
        {
            string to = op.Value<string>("new_name");
            ReferencePlane plane = FindPlane(doc, op, true);
            var all = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().ToList();
            if (plane == null)
            {
                if (op.Value<long?>("id") == null && all.Any(p => p.Name == to)) return ("skip", "already " + to);
                throw new InvalidOperationException("No reference plane " + (op.Value<long?>("id")?.ToString() ?? op.Value<string>("name")));
            }
            if (plane.Name == to) return ("skip", "");
            NotOrigin(plane);
            string why = FmcFamEditRules.RenameProblem(plane.Name, to, all.Select(p => p.Name));
            if (why != null) throw new InvalidOperationException(why);
            string from = string.IsNullOrEmpty(plane.Name) ? "#" + IdValue(plane.Id) : plane.Name;
            plane.Name = to;
            return ("update", from + " → " + to);
        }

        private static (string, string) PlaneMove(Document doc, JObject op)
        {
            ReferencePlane plane = FindPlane(doc, op);
            NotOrigin(plane);
            if (plane.Pinned) throw new InvalidOperationException(plane.Name + " is pinned: a person unpins it first");
            double offset = op.Value<double>("offset_mm");
            XYZ n = plane.Normal.Normalize();
            XYZ before = plane.BubbleEnd;
            ElementTransformUtils.MoveElement(doc, plane.Id, n * Mm(offset));
            doc.Regenerate();
            double moved = ToMm((plane.BubbleEnd - before).DotProduct(n));
            string detail = $"{offset} mm along its normal ({Math.Round(n.X, 3)}, {Math.Round(n.Y, 3)}, {Math.Round(n.Z, 3)})";
            if (Math.Abs(moved - offset) > 0.5) detail += $"; warning: it ended {Math.Round(moved, 1)} mm away (a lock or a labelled dimension holds it)";
            return ("update", detail);
        }

        private static (string, string) PlaneDelete(Document doc, JObject op)
        {
            ReferencePlane plane = FindPlane(doc, op, true);
            if (plane == null) return ("skip", "not in the family");
            NotOrigin(plane);
            if (plane.Pinned) throw new InvalidOperationException(plane.Name + " is pinned: a person unpins it first");
            ElementId pid = plane.Id;
            // what Revit deletes with it, named before it goes (dimensions, alignments and locks that reference it)
            var kinds = new Dictionary<string, int>();
            foreach (ElementId id in plane.GetDependentElements(null))
            {
                if (id == pid) continue;
                string k = doc.GetElement(id)?.GetType().Name ?? "element";
                kinds[k] = kinds.TryGetValue(k, out int c) ? c + 1 : 1;
            }
            int gone = doc.Delete(pid).Count - 1;
            string what = kinds.Count == 0 ? "nothing depends on it" : "depends on it: " + string.Join(", ", kinds.Select(kv => kv.Value + " " + kv.Key));
            return ("delete", what + "; Revit deletes " + Math.Max(0, gone) + " other element(s) with it");
        }

        // ---- the flex matrix (a read) ---------------------------------------------------------------------------------

        private sealed class Errors : IFailuresPreprocessor
        {
            public readonly List<string> List = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                {
                    if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                    else List.Add(f.GetDescriptionText());
                }
                return List.Count > 0 ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }

        /// <summary>
        /// type_flex_matrix: every type (or the ones named) with each parameter at each value from low to high, regenerated
        /// one at a time; every run is rolled back with the whole group, so nothing is kept and nothing is saved.
        /// </summary>
        public static JObject FlexMatrix(Document doc, JObject op, double maxSeconds = 240)
        {
            FamilyManager fm = doc.FamilyManager;
            var only = (op["types"] as JArray)?.Select(x => x.ToString()).ToList();
            var types = Types(doc).Where(t => only == null || only.Count == 0 || only.Contains(t.Name)).ToList();
            var names = ((JArray)op["params"]).Select(x => x.ToString()).ToList();
            var ranges = op["ranges"] as JObject ?? new JObject();
            var clock = System.Diagnostics.Stopwatch.StartNew();
            int regenerations = 0;
            bool stopped = false;
            var byType = new JArray();
            using (var group = new TransactionGroup(doc, "Formcraft: flex matrix"))
            {
                group.Start();
                foreach (FamilyType type in types)
                {
                    var runs = new JArray();
                    foreach (string name in names)
                    {
                        FamilyParameter p = FamilyParam(doc, name);
                        var range = ranges[name] as JObject;
                        if (p == null || range == null) { runs.Add(new JObject { ["param"] = name, ["ok"] = false, ["errors"] = new JArray(p == null ? "no such parameter" : "no range") }); continue; }
                        if (!string.IsNullOrEmpty(p.Formula) || p.IsReporting) { runs.Add(new JObject { ["param"] = name, ["ok"] = true, ["skipped"] = p.IsReporting ? "reporting" : "driven by a formula" }); continue; }
                        foreach (double v in FmcFamEditRules.FlexValues(range.Value<double>("low"), range.Value<double>("high"), range.Value<int?>("steps") ?? 3))
                        {
                            if (clock.Elapsed.TotalSeconds > maxSeconds) { stopped = true; break; }
                            var errors = new Errors();
                            string error = "";
                            using (var t = new Transaction(doc, "flex " + type.Name + " " + name))
                            {
                                var fho = t.GetFailureHandlingOptions();
                                fho.SetFailuresPreprocessor(errors);
                                t.SetFailureHandlingOptions(fho);
                                t.Start();
                                try
                                {
                                    fm.CurrentType = type;
                                    ForgeTypeId spec = p.Definition.GetDataType();
                                    if (p.StorageType == StorageType.Double)
                                        fm.Set(p, spec == SpecTypeId.Length ? Mm(v) : spec == SpecTypeId.Angle ? UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Degrees) : v);
                                    else if (p.StorageType == StorageType.Integer) fm.Set(p, (int)Math.Round(v));
                                    else throw new InvalidOperationException(name + " isn't a number");
                                    doc.Regenerate();
                                    regenerations++;
                                }
                                catch (Exception e) { error = e.Message; }
                                TransactionStatus status;
                                try { status = error.Length > 0 ? t.RollBack() : t.Commit(); } catch (Exception) { status = TransactionStatus.Error; }
                                if (status != TransactionStatus.Committed && error.Length == 0 && errors.List.Count == 0) error = "Revit couldn't regenerate it (" + status + ")";
                            }
                            var all = errors.List.Concat(error.Length > 0 ? new[] { error } : new string[0]).ToList();
                            runs.Add(new JObject { ["param"] = name, ["value"] = v, ["ok"] = all.Count == 0, ["errors"] = new JArray(all) });
                        }
                        if (stopped) break;
                    }
                    byType.Add(new JObject { ["type"] = type.Name, ["runs"] = runs });
                    if (stopped) break;
                }
                group.RollBack();
            }
            var matrix = new JObject { ["types"] = byType, ["regenerations"] = regenerations, ["seconds"] = Math.Round(clock.Elapsed.TotalSeconds, 1) };
            if (stopped) matrix["unfinished"] = $"stopped after {maxSeconds} s: flex fewer types, parameters or steps";
            bool ok = byType.SelectMany(t => (JArray)t["runs"]).All(r => r.Value<bool>("ok"));
            return new JObject
            {
                ["dry_run"] = true, ["created"] = 0, ["updated"] = 0, ["skipped"] = 1, ["warnings"] = new JArray(),
                ["ops"] = new JArray(new JObject { ["op"] = "type_flex_matrix", ["name"] = op.Value<string>("name") ?? "flex matrix", ["result"] = "skip",
                    ["detail"] = ok ? "every run regenerates" : "some runs fail", ["matrix"] = matrix }),
            };
        }

        // ---- report detail (fmc_fam_param list, fmc_fam_ref list) -----------------------------------------------------

        public static void AddReport(Document doc, JObject r)
        {
            if (!doc.IsFamilyDocument) return;
            r["parameter_detail"] = new JArray(doc.FamilyManager.GetParameters().Select(p => new JObject
            {
                ["name"] = p.Definition.Name, ["instance"] = p.IsInstance, ["shared"] = p.IsShared, ["reporting"] = p.IsReporting,
                ["group"] = p.Definition.GetGroupTypeId()?.TypeId ?? "", ["formula"] = p.Formula ?? "", ["built_in"] = IdValue(p.Id) < 0,
            }));
            r["planes"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().Select(p =>
            {
                XYZ n = p.Normal.Normalize();
                Parameter isRef = p.get_Parameter(BuiltInParameter.ELEM_REFERENCE_NAME);
                Parameter origin = p.get_Parameter(BuiltInParameter.DATUM_PLANE_DEFINES_ORIGIN);
                string kind = "";
                if (isRef != null) { int k = isRef.AsInteger(); kind = Enum.IsDefined(typeof(FamilyInstanceReferenceType), k) ? ((FamilyInstanceReferenceType)k).ToString() : k.ToString(); }
                return new JObject
                {
                    ["id"] = IdValue(p.Id), ["name"] = p.Name ?? "", ["is_reference"] = kind, ["defines_origin"] = origin != null && origin.AsInteger() == 1,
                    ["pinned"] = p.Pinned, ["normal"] = new JArray(Math.Round(n.X, 4), Math.Round(n.Y, 4), Math.Round(n.Z, 4)),
                    ["at_mm"] = Math.Round(ToMm(p.BubbleEnd.DotProduct(n)), 1),
                };
            }));
        }
    }
}
