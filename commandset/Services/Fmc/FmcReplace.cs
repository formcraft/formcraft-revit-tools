using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_replace: preview a structural replacement on a document this session opened with fmc_file open_copy.
    /// One TransactionGroup, always rolled back. There is no apply mode and nothing is saved.
    /// Rows are sequential sub-transactions so a later row can see an earlier row's new element
    /// (a B7 pedestal depends on an earlier pad; a B3 beam meets an earlier beam). A failed row
    /// rolls back only its own sub-transaction. Deletion runs only after every row's create,
    /// verify and rebind gates have passed.
    /// </summary>
    public class FmcReplaceHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft replace preview";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                    Result = FmcReplacePreview.Run(app, target.Doc, Parameters);
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }

    public static class FmcReplacePreview
    {
        public const string TransactionModel = "sequential";
        public const string DeletionPass = "after_all_rows_pass";
        public const string TransactionReason =
            "Rows run as sequential sub-transactions inside one transaction, inside one TransactionGroup. " +
            "Each sub-transaction commits into that transaction, so a later row sees earlier rows' new elements. " +
            "That is required because some B7 pedestals depend on an earlier foundation and some B3 beams meet at a joint with an earlier beam. " +
            "A failed row rolls back only its own sub-transaction, so it does not undo earlier rows or drop the group report. " +
            "Deletion is a second pass: it runs only after every row's create, verify and rebind gates have passed. " +
            "The outer transaction and the group are always rolled back and never committed. There is no apply mode.";

        private static readonly Regex KeynoteRe = new Regex("^[A-Z]\\.[A-Z0-9]{3}_[A-Z0-9]{2}$", RegexOptions.CultureInvariant);

        private static readonly string[] Handled =
        {
            "rebar_host", "rebar_container", "join", "requested_join", "column_attachment", "analytical_association",
        };
        private static readonly string[] NotHandled =
        {
            "hosted_family", "rebar_in_system", "area_reinforcement", "path_reinforcement", "fabric_area", "fabric_sheet", "opening", "annotation", "other",
        };

        public static JObject Run(UIApplication app, Document doc, JObject parameters)
        {
            RefuseUnlessCopy(doc, parameters);
            var inputs = (parameters?["rows"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (inputs.Count == 0) throw new InvalidOperationException("fmc_replace needs rows.");
            double tolerance = parameters.Value<double?>("tolerance_mm") ?? 2;
            if (tolerance <= 0 || tolerance > 50) throw new InvalidOperationException("tolerance_mm must be greater than 0 and at most 50.");

            var rows = inputs.Select(o => new Row(o)).ToList();
            var dup = rows.GroupBy(r => r.Id).FirstOrDefault(g => g.Count() > 1);
            if (dup != null) throw new InvalidOperationException($"Two rows use the id {dup.Key}. Refusing to guess which is which.");
            var seenOld = new HashSet<long>();
            foreach (Row row in rows)
                foreach (long id in row.OldIds)
                    if (!seenOld.Add(id)) throw new InvalidOperationException($"Old id {id} is listed on more than one row. Refusing to delete it twice.");

            var countsBefore = Counts(doc);
            bool modifiedBefore = doc.IsModified;
            var existed = new HashSet<long>();
            foreach (Row row in rows)
                foreach (long id in row.OldIds)
                    if (doc.GetElement(new ElementId(id)) != null) existed.Add(id);

            var createdIds = new List<long>();
            TransactionGroup group = null;
            Transaction tx = null;
            string groupStatus = "not_started";
            string txStatus = "not_started";
            bool parentDead = false;
            try
            {
                group = new TransactionGroup(doc, "fmc_replace preview");
                group.Start();
                tx = new Transaction(doc, "fmc_replace preview");
                tx.Start();
                var failures = tx.GetFailureHandlingOptions();
                failures.SetFailuresPreprocessor(new Quiet());
                failures.SetClearAfterRollback(true);
                tx.SetFailureHandlingOptions(failures);

                foreach (Row row in rows)
                {
                    if (parentDead) { Skip(row, "create", "The preview transaction stopped after an earlier row."); continue; }
                    try { CreateAndVerify(doc, rows, row, tolerance, createdIds); }
                    catch (Exception ex) { parentDead = !Alive(tx); Fail(row, "create", ex.Message); }
                }
                foreach (Row row in rows)
                {
                    if (!row.CreateOk || !row.VerifyOk) { Skip(row, "rebind", "Create or verify did not pass."); continue; }
                    if (parentDead) { Skip(row, "rebind", "The preview transaction stopped after an earlier row."); continue; }
                    try { Rebind(doc, rows, row); }
                    catch (Exception ex) { parentDead = !Alive(tx); Fail(row, "rebind", ex.Message); }
                }
                bool allBound = rows.All(r => r.CreateOk && r.VerifyOk && r.RebindOk);
                foreach (Row row in rows)
                {
                    if (!allBound) { Skip(row, "delete", "Deletion waits until every row's create, verify and rebind gates pass."); Skip(row, "orphans", "Orphan check runs with deletion."); continue; }
                    if (parentDead) { Skip(row, "delete", "The preview transaction stopped after an earlier row."); Skip(row, "orphans", "Orphan check runs with deletion."); continue; }
                    try { DeleteAndOrphans(doc, rows, row); }
                    catch (Exception ex)
                    {
                        parentDead = !Alive(tx);
                        if (row.Gate("delete")["status"]?.ToString() != "fail") Fail(row, "delete", ex.Message);
                        if (row.Gate("orphans")["status"] == null) Skip(row, "orphans", ex.Message);
                        allBound = false;
                    }
                }
            }
            finally
            {
                try
                {
                    if (tx != null && tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    txStatus = tx == null ? "not_started" : tx.GetStatus().ToString();
                }
                catch (Exception ex) { txStatus = "rollback_failed: " + ex.Message; }
                try
                {
                    if (group != null && group.GetStatus() == TransactionStatus.Started) group.RollBack();
                    groupStatus = group == null ? "not_started" : group.GetStatus().ToString();
                }
                catch (Exception ex) { groupStatus = "rollback_failed: " + ex.Message; }
                tx?.Dispose();
                group?.Dispose();
            }

            var countsAfter = Counts(doc);
            var missingOld = existed.Where(id => doc.GetElement(new ElementId(id)) == null).ToList();
            var stillThere = createdIds.Where(id => doc.GetElement(new ElementId(id)) != null).ToList();
            bool countsMatch = SameCounts(countsBefore, countsAfter);
            bool proof = groupStatus == TransactionStatus.RolledBack.ToString()
                && txStatus == TransactionStatus.RolledBack.ToString()
                && countsMatch && missingOld.Count == 0 && stillThere.Count == 0;
            foreach (Row row in rows) row.Finish();
            bool rowsPass = rows.All(r => r.Report.Value<string>("status") == "pass");
            JObject state = FmcTarget.DescribeState(doc);
            state["is_active"] = app?.ActiveUIDocument != null && doc.Equals(app.ActiveUIDocument.Document);
            return new JObject
            {
                ["tool"] = "fmc_replace",
                ["preview_only"] = true,
                ["committed"] = false,
                ["saved"] = false,
                ["synced"] = false,
                ["relinquished"] = false,
                ["transaction"] = new JObject
                {
                    ["model"] = TransactionModel,
                    ["deletion"] = DeletionPass,
                    ["reason"] = TransactionReason,
                },
                ["rebind_policy"] = new JObject
                {
                    ["handled"] = new JArray(Handled),
                    ["not_handled"] = new JArray(NotHandled),
                    ["not_handled_note"] = "A relationship Revit cannot rebind safely fails the row. A hosted family is never rehosted. List an id in expected_deleted_ids only when that cascade is accepted; it is then deleted with the old element and checked against the cascade, not rebound.",
                },
                ["tolerance_mm"] = tolerance,
                ["document"] = state,
                ["rows"] = new JArray(rows.Select(r => r.Report)),
                ["group"] = new JObject
                {
                    ["status"] = rowsPass && proof ? "pass" : "fail",
                    ["rows_pass"] = rowsPass,
                    ["rollback"] = new JObject
                    {
                        ["method"] = "TransactionGroup.RollBack",
                        ["group_status"] = groupStatus,
                        ["transaction_status"] = txStatus,
                        ["committed"] = false,
                        ["saved"] = false,
                        ["is_modified_before"] = modifiedBefore,
                        ["is_modified_after"] = doc.IsModified,
                        ["counts_before"] = countsBefore,
                        ["counts_after"] = countsAfter,
                        ["counts_match"] = countsMatch,
                        ["old_ids"] = new JArray(existed),
                        ["old_ids_present"] = missingOld.Count == 0,
                        ["old_ids_missing"] = new JArray(missingOld),
                        ["new_ids"] = new JArray(createdIds.Distinct()),
                        ["new_ids_absent"] = stillThere.Count == 0,
                        ["new_ids_still_present"] = new JArray(stillThere),
                        ["proof"] = proof,
                    },
                },
            };
        }

        private static void RefuseUnlessCopy(Document doc, JObject parameters)
        {
            if (doc == null) throw new InvalidOperationException("No document.");
            if (doc.IsLinked) throw new InvalidOperationException("A linked document is never modified. fmc_replace was not started.");
            if (string.IsNullOrEmpty(doc.PathName)) throw new InvalidOperationException("fmc_replace refuses an unsaved document. Open a copy with fmc_file open_copy.");
            if (FmcTarget.IsProtected(doc.PathName, FmcTarget.Roots(parameters)))
                throw new InvalidOperationException($"Protected original: {doc.PathName}. fmc_replace was not started. Nothing was saved.");
            if (!FmcVerifySession.Contains(doc))
                throw new InvalidOperationException("fmc_replace runs only on a document this session opened with fmc_file open_copy. This document is not one of those (an original, a live model, or a file opened some other way). Nothing was changed.");
        }

        private static void CreateAndVerify(Document doc, List<Row> rows, Row row, double tolerance, List<long> createdIds)
        {
            foreach (string dep in row.DependsOn)
            {
                Row other = rows.FirstOrDefault(r => r.Id == dep);
                if (other == null) throw new InvalidOperationException($"depends_on {dep} is not a row in this call.");
                if (!other.CreateOk) throw new InvalidOperationException($"depends_on {dep}, which did not pass create. This row was not created.");
            }
            foreach (long id in row.OldIds)
                if (doc.GetElement(new ElementId(id)) == null) throw new InvalidOperationException($"Old id {id} is not in this document.");
            if (!KeynoteRe.IsMatch(row.Keynote)) throw new InvalidOperationException($"Keynote {row.Keynote} is not X.YYY_ZZ (one letter, a dot, three letters or digits, an underscore, two letters or digits). Example: S.FND_01.");

            using (var sub = new SubTransaction(doc))
            {
                sub.Start();
                try
                {
                    Element made = Create(doc, row);
                    row.NewId = made.Id.Value;
                    SetKeynote(made, row.Keynote);
                    SetParameters(doc, made, row.Input["parameters"] as JArray);
                    if (row.Input["material_id"] != null) SetMaterial(doc, made, row.Input.Value<long>("material_id"));
                    doc.Regenerate();
                    JObject readback = ReadBack(doc, made);
                    JArray checks = Verify(doc, made, row, readback, tolerance);
                    bool ok = checks.All(c => c.Value<bool>("ok"));
                    row.Gate("create")["status"] = "pass";
                    row.Gate("create")["new_id"] = made.Id.Value;
                    row.Gate("verify")["status"] = ok ? "pass" : "fail";
                    row.Gate("verify")["readback"] = readback;
                    row.Gate("verify")["checks"] = checks;
                    if (!ok)
                    {
                        sub.RollBack();
                        row.NewId = 0;
                        row.VerifyOk = false;
                        row.CreateOk = false;
                        row.Gate("create")["rolled_back"] = true;
                        row.Gate("create")["reason"] = "Verify failed, so this sub-transaction was rolled back. The new id was not kept for later rows.";
                        return;
                    }
                    if (sub.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit did not commit the create sub-transaction.");
                    row.CreateOk = true;
                    row.VerifyOk = true;
                    createdIds.Add(made.Id.Value);
                }
                catch
                {
                    if (sub.GetStatus() == TransactionStatus.Started) sub.RollBack();
                    throw;
                }
            }
        }

        private static Element Create(Document doc, Row row)
        {
            Level level = doc.GetElement(new ElementId(row.LevelId)) as Level ?? throw new InvalidOperationException($"level_id {row.LevelId} is not a level in this document.");
            switch (row.Kind)
            {
                case "foundation_slab": return CreateSlab(doc, row, level);
                case "isolated_foundation": return CreateFooting(doc, row, level);
                case "beam": return CreateBeam(doc, row, level);
                case "column": return CreateColumn(doc, row, level);
                default: throw new InvalidOperationException($"Unknown kind {row.Kind}.");
            }
        }

        private static Floor CreateSlab(Document doc, Row row, Level level)
        {
            var type = doc.GetElement(new ElementId(row.TypeId)) as FloorType ?? throw new InvalidOperationException($"type_id {row.TypeId} is not a floor type.");
            if (!type.IsFoundationSlab) throw new InvalidOperationException($"type {row.TypeId} ({type.Name}) is not a foundation slab. Refusing to place a floor.");
            if (row.Input["material_id"] != null) throw new InvalidOperationException("foundation_slab takes its material from the type. material_id would change every slab of that type, so it is refused. Pass a type_id that already has the material.");
            JArray loop = row.Input["boundary_mm"] as JArray ?? throw new InvalidOperationException("foundation_slab needs boundary_mm, a loop of [x, y] in millimetres.");
            var pts = loop.OfType<JArray>().Select(p => new XYZ(Ft(p[0].Value<double>()), Ft(p[1].Value<double>()), level.Elevation)).ToList();
            if (pts.Count >= 2 && pts[0].DistanceTo(pts[pts.Count - 1]) < Ft(1)) pts.RemoveAt(pts.Count - 1);
            if (pts.Count < 3) throw new InvalidOperationException("foundation_slab boundary_mm needs at least 3 points.");
            var curves = new CurveLoop();
            for (int i = 0; i < pts.Count; i++)
            {
                XYZ a = pts[i], b = pts[(i + 1) % pts.Count];
                if (a.DistanceTo(b) < Ft(1)) throw new InvalidOperationException("foundation_slab boundary has a zero-length edge.");
                curves.Append(Line.CreateBound(a, b));
            }
            Floor floor = Floor.Create(doc, new List<CurveLoop> { curves }, type.Id, level.Id, true, null, 0);
            if (row.Input["top_mm"] != null)
            {
                Parameter offset = floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM);
                double value = Ft(row.Input.Value<double>("top_mm")) - level.Elevation;
                if (offset == null || offset.IsReadOnly || !offset.Set(value))
                    throw new InvalidOperationException("Could not set Height Offset From Level so the slab top is at top_mm. The row was not left half-created.");
            }
            return floor;
        }

        private static FamilyInstance CreateFooting(Document doc, Row row, Level level)
        {
            FamilySymbol sym = Symbol(doc, row.TypeId, BuiltInCategory.OST_StructuralFoundation, "isolated foundation");
            JArray p = row.Input["point_mm"] as JArray ?? throw new InvalidOperationException("isolated_foundation needs point_mm [x, y] or [x, y, z].");
            var at = new XYZ(Ft(p[0].Value<double>()), Ft(p[1].Value<double>()), level.Elevation);
            return doc.Create.NewFamilyInstance(at, sym, level, Autodesk.Revit.DB.Structure.StructuralType.Footing);
        }

        private static FamilyInstance CreateBeam(Document doc, Row row, Level level)
        {
            FamilySymbol sym = Symbol(doc, row.TypeId, BuiltInCategory.OST_StructuralFraming, "beam");
            XYZ a = Xyz(row.Input["start_mm"] as JArray, "beam needs start_mm [x, y, z]");
            XYZ b = Xyz(row.Input["end_mm"] as JArray, "beam needs end_mm [x, y, z]");
            if (a.DistanceTo(b) < Ft(1)) throw new InvalidOperationException("beam length is under 1 mm.");
            FamilyInstance beam = doc.Create.NewFamilyInstance(Line.CreateBound(a, b), sym, level, Autodesk.Revit.DB.Structure.StructuralType.Beam);
            SetJustification(beam, row.Input.Value<string>("z_justification"), row.Input.Value<string>("y_justification"));
            if (beam.Location is LocationCurve lc) lc.Curve = Line.CreateBound(a, b);
            return beam;
        }

        private static FamilyInstance CreateColumn(Document doc, Row row, Level level)
        {
            FamilySymbol sym = Symbol(doc, row.TypeId, BuiltInCategory.OST_StructuralColumns, "column");
            JArray p = row.Input["point_mm"] as JArray ?? throw new InvalidOperationException("column needs point_mm [x, y] or [x, y, z].");
            var at = new XYZ(Ft(p[0].Value<double>()), Ft(p[1].Value<double>()), level.Elevation);
            FamilyInstance column = doc.Create.NewFamilyInstance(at, sym, level, Autodesk.Revit.DB.Structure.StructuralType.Column);
            if (row.Input["top_level_id"] != null)
            {
                long topId = row.Input.Value<long>("top_level_id");
                if (!(doc.GetElement(new ElementId(topId)) is Level)) throw new InvalidOperationException($"top_level_id {topId} is not a level.");
                Parameter top = column.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM);
                if (top == null || top.IsReadOnly || !top.Set(new ElementId(topId))) throw new InvalidOperationException("Could not set the column's top level.");
            }
            return column;
        }

        private static void SetJustification(FamilyInstance beam, string zName, string yName)
        {
            if (string.IsNullOrEmpty(zName)) throw new InvalidOperationException("beam needs z_justification: top, center, origin or bottom. The location curve is not moved to guess it.");
            var z = (Autodesk.Revit.DB.Structure.ZJustification)Enum.Parse(typeof(Autodesk.Revit.DB.Structure.ZJustification), zName, true);
            Parameter mode = beam.get_Parameter(BuiltInParameter.YZ_JUSTIFICATION);
            if (mode != null && !mode.IsReadOnly) mode.Set((int)Autodesk.Revit.DB.Structure.YZJustificationOption.Uniform);
            Parameter zp = beam.get_Parameter(BuiltInParameter.Z_JUSTIFICATION);
            if (zp == null || zp.IsReadOnly || !zp.Set((int)z)) throw new InvalidOperationException($"Could not set Z justification to {zName}.");
            if (!string.IsNullOrEmpty(yName))
            {
                var y = (Autodesk.Revit.DB.Structure.YJustification)Enum.Parse(typeof(Autodesk.Revit.DB.Structure.YJustification), yName, true);
                Parameter yp = beam.get_Parameter(BuiltInParameter.Y_JUSTIFICATION);
                if (yp == null || yp.IsReadOnly || !yp.Set((int)y)) throw new InvalidOperationException($"Could not set Y justification to {yName}.");
            }
        }

        private static FamilySymbol Symbol(Document doc, long typeId, BuiltInCategory cat, string what)
        {
            var sym = doc.GetElement(new ElementId(typeId)) as FamilySymbol ?? throw new InvalidOperationException($"type_id {typeId} is not a family type.");
            if (sym.Category == null || sym.Category.Id.Value != (long)cat) throw new InvalidOperationException($"type_id {typeId} ({sym.FamilyName}: {sym.Name}) is not a {what}.");
            if (!sym.IsActive) sym.Activate();
            return sym;
        }

        private static void SetKeynote(Element e, string keynote)
        {
            Parameter p = e.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
            if (p == null) throw new InvalidOperationException("The new element has no keynote parameter. The row fails.");
            if (p.IsReadOnly) throw new InvalidOperationException("Keynote on this element is read-only, so it was not filled at creation. Refusing to change the type keynote, because that would change every element of the type.");
            if (!p.Set(keynote)) throw new InvalidOperationException("Revit refused the keynote.");
        }

        private static void SetMaterial(Document doc, Element e, long materialId)
        {
            if (!(doc.GetElement(new ElementId(materialId)) is Material)) throw new InvalidOperationException($"material_id {materialId} is not a material.");
            if (e is FamilyInstance fi) fi.StructuralMaterialId = new ElementId(materialId);
            else throw new InvalidOperationException("material_id is only set on a family instance. A slab keeps the type's material.");
        }

        private static void SetParameters(Document doc, Element e, JArray list)
        {
            if (list == null) return;
            foreach (JObject spec in list.OfType<JObject>())
            {
                string name = spec.Value<string>("name") ?? throw new InvalidOperationException("a parameter needs name.");
                Parameter p = e.LookupParameter(name);
                if (p == null) throw new InvalidOperationException($"{e.Id.Value} has no parameter {name}.");
                if (p.IsReadOnly) throw new InvalidOperationException($"{name} is read-only.");
                int kinds = (spec["value_mm"] != null ? 1 : 0) + (spec["value"] != null ? 1 : 0) + (spec["value_text"] != null ? 1 : 0) + (spec["element_id"] != null ? 1 : 0);
                if (kinds != 1) throw new InvalidOperationException($"{name} needs exactly one of value_mm, value, value_text, element_id.");
                bool ok;
                if (spec["value_mm"] != null)
                {
                    if (p.StorageType != StorageType.Double) throw new InvalidOperationException($"{name} is not a length.");
                    ok = p.Set(Ft(spec.Value<double>("value_mm")));
                }
                else if (spec["element_id"] != null)
                {
                    if (p.StorageType != StorageType.ElementId) throw new InvalidOperationException($"{name} is not an element id.");
                    ok = p.Set(new ElementId(spec.Value<long>("element_id")));
                }
                else if (spec["value"] != null && p.StorageType == StorageType.Double) ok = p.Set(spec.Value<double>("value"));
                else if (spec["value"] != null && p.StorageType == StorageType.Integer) ok = p.Set(spec.Value<int>("value"));
                else
                {
                    string text = spec.Value<string>("value_text") ?? spec.Value<string>("value") ?? "";
                    switch (p.StorageType)
                    {
                        case StorageType.String: ok = p.Set(text); break;
                        case StorageType.Integer:
                            string t = text.Trim().ToLowerInvariant();
                            ok = p.Set(t == "yes" || t == "true" ? 1 : t == "no" || t == "false" ? 0 : int.Parse(t));
                            break;
                        default: ok = p.SetValueString(text); break;
                    }
                }
                if (!ok) throw new InvalidOperationException($"Revit refused {name}.");
            }
        }

        private static JObject ReadBack(Document doc, Element e)
        {
            var o = new JObject
            {
                ["id"] = e.Id.Value,
                ["unique_id"] = e.UniqueId,
                ["class"] = e.GetType().Name,
                ["category"] = e.Category?.Name ?? "",
                ["type_id"] = e.GetTypeId().Value,
                ["type_name"] = doc.GetElement(e.GetTypeId())?.Name ?? "",
                ["keynote"] = e.get_Parameter(BuiltInParameter.KEYNOTE_PARAM)?.AsString() ?? "",
            };
            long levelId = LevelIdOf(e);
            o["level_id"] = levelId;
            o["level_name"] = levelId == -1 ? "" : doc.GetElement(new ElementId(levelId))?.Name ?? "";
            if (e is FamilyInstance fi)
            {
                o["material_id"] = fi.StructuralMaterialId.Value;
                if (fi.Location is LocationPoint lp) o["point_mm"] = P(lp.Point);
                if (fi.Location is LocationCurve lc && lc.Curve != null)
                {
                    o["start_mm"] = P(lc.Curve.GetEndPoint(0));
                    o["end_mm"] = P(lc.Curve.GetEndPoint(1));
                }
                o["z_justification"] = EnumName(typeof(Autodesk.Revit.DB.Structure.ZJustification), fi.get_Parameter(BuiltInParameter.Z_JUSTIFICATION)?.AsInteger());
                o["y_justification"] = EnumName(typeof(Autodesk.Revit.DB.Structure.YJustification), fi.get_Parameter(BuiltInParameter.Y_JUSTIFICATION)?.AsInteger());
            }
            List<XYZ> pts = new List<XYZ>();
            foreach (Solid s in FmcColumnEnds.Solids(e))
                foreach (Face f in s.Faces)
                    foreach (EdgeArray loop in f.EdgeLoops)
                        foreach (Edge edge in loop)
                            foreach (XYZ p in edge.Tessellate()) pts.Add(p);
            if (pts.Count > 0)
            {
                o["top_mm"] = Mm(pts.Max(p => p.Z));
                o["underside_mm"] = Mm(pts.Min(p => p.Z));
                o["bbox_min_mm"] = P(new XYZ(pts.Min(p => p.X), pts.Min(p => p.Y), pts.Min(p => p.Z)));
                o["bbox_max_mm"] = P(new XYZ(pts.Max(p => p.X), pts.Max(p => p.Y), pts.Max(p => p.Z)));
                o["plan_mm"] = new JArray(Mm(pts.Min(p => p.X)), Mm(pts.Min(p => p.Y)), Mm(pts.Max(p => p.X)), Mm(pts.Max(p => p.Y)));
            }
            else o["solid"] = "none";
            return o;
        }

        private static JArray Verify(Document doc, Element e, Row row, JObject readback, double tolerance)
        {
            JObject expect = row.Input["expect"] as JObject ?? new JObject();
            double tol = expect.Value<double?>("tolerance_mm") ?? tolerance;
            var checks = new JArray();
            CheckEqual(checks, "type_id", readback.Value<long?>("type_id"), expect.Value<long?>("type_id") ?? row.TypeId);
            CheckEqual(checks, "level_id", readback.Value<long?>("level_id"), expect.Value<long?>("level_id") ?? row.LevelId);
            string keynote = expect.Value<string>("keynote") ?? row.Keynote;
            bool keyOk = readback.Value<string>("keynote") == keynote && KeynoteRe.IsMatch(readback.Value<string>("keynote") ?? "");
            checks.Add(new JObject { ["field"] = "keynote", ["expected"] = keynote, ["actual"] = readback["keynote"], ["ok"] = keyOk });
            JArray start = expect["start_mm"] as JArray ?? row.Input["start_mm"] as JArray;
            JArray end = expect["end_mm"] as JArray ?? row.Input["end_mm"] as JArray;
            if (start != null) CheckPoint(checks, "start_mm", readback["start_mm"] as JArray, start, tol);
            if (end != null) CheckPoint(checks, "end_mm", readback["end_mm"] as JArray, end, tol);
            JArray point = expect["point_mm"] as JArray ?? (row.Kind == "beam" ? null : row.Input["point_mm"] as JArray);
            if (point != null) CheckPoint(checks, "point_mm", readback["point_mm"] as JArray, point, tol);
            if (expect["top_mm"] != null || row.Input["top_mm"] != null)
                CheckMm(checks, "top_mm", readback.Value<double?>("top_mm"), expect.Value<double?>("top_mm") ?? row.Input.Value<double?>("top_mm"), tol);
            if (expect["underside_mm"] != null)
                CheckMm(checks, "underside_mm", readback.Value<double?>("underside_mm"), expect.Value<double>("underside_mm"), tol);
            if (expect["boundary_mm"] is JArray boundary || row.Input["boundary_mm"] is JArray)
                CheckPlan(checks, readback["plan_mm"] as JArray, (expect["boundary_mm"] as JArray) ?? (row.Input["boundary_mm"] as JArray), tol);
            if (expect["size_mm"] is JArray size) CheckSize(e, readback, checks, size, tol);
            if (expect["material_id"] != null) CheckEqual(checks, "material_id", MaterialOf(doc, e), expect.Value<long>("material_id"));
            if (expect["parameters"] is JArray plist)
                foreach (JObject spec in plist.OfType<JObject>()) CheckParameter(doc, e, checks, spec, tol);
            return checks;
        }

        private static void CheckSize(Element e, JObject readback, JArray checks, JArray size, double tol)
        {
            if (size.Count >= 3 && readback["bbox_min_mm"] is JArray min && readback["bbox_max_mm"] is JArray max)
            {
                CheckMm(checks, "size_x_mm", Math.Abs(max[0].Value<double>() - min[0].Value<double>()), size[0].Value<double>(), tol);
                CheckMm(checks, "size_y_mm", Math.Abs(max[1].Value<double>() - min[1].Value<double>()), size[1].Value<double>(), tol);
                CheckMm(checks, "size_z_mm", Math.Abs(max[2].Value<double>() - min[2].Value<double>()), size[2].Value<double>(), tol);
                return;
            }
            if (size.Count >= 2 && e.Location is LocationCurve lc && lc.Curve != null && readback["bbox_min_mm"] != null)
            {
                XYZ a = lc.Curve.GetEndPoint(0), b = lc.Curve.GetEndPoint(1);
                XYZ dir = b - a;
                XYZ horiz = new XYZ(dir.X, dir.Y, 0);
                if (horiz.GetLength() < 1e-9) horiz = XYZ.BasisX; else horiz = horiz.Normalize();
                XYZ side = new XYZ(-horiz.Y, horiz.X, 0);
                double minS = double.MaxValue, maxS = double.MinValue, minZ = double.MaxValue, maxZ = double.MinValue;
                foreach (Solid s in FmcColumnEnds.Solids(e))
                    foreach (Face f in s.Faces)
                        foreach (EdgeArray loop in f.EdgeLoops)
                            foreach (Edge edge in loop)
                                foreach (XYZ p in edge.Tessellate())
                                {
                                    double d = (p - a).DotProduct(side);
                                    if (d < minS) minS = d;
                                    if (d > maxS) maxS = d;
                                    if (p.Z < minZ) minZ = p.Z;
                                    if (p.Z > maxZ) maxZ = p.Z;
                                }
                CheckMm(checks, "section_width_mm", Mm(maxS - minS), size[0].Value<double>(), tol);
                CheckMm(checks, "section_height_mm", Mm(maxZ - minZ), size[1].Value<double>(), tol);
            }
            else checks.Add(new JObject { ["field"] = "size_mm", ["expected"] = size, ["actual"] = null, ["ok"] = false, ["reason"] = "No solid to measure." });
        }

        private static void CheckParameter(Document doc, Element e, JArray checks, JObject spec, double tol)
        {
            string name = spec.Value<string>("name") ?? "";
            Parameter p = e.LookupParameter(name);
            if (p == null) { checks.Add(new JObject { ["field"] = name, ["ok"] = false, ["reason"] = "parameter missing" }); return; }
            double use = spec.Value<double?>("tolerance_mm") ?? tol;
            if (spec["value_mm"] != null) CheckMm(checks, name, Mm(p.AsDouble()), spec.Value<double>("value_mm"), use);
            else if (spec["element_id"] != null) CheckEqual(checks, name, p.AsElementId()?.Value, spec.Value<long>("element_id"));
            else if (spec["value"] != null && p.StorageType == StorageType.Integer) CheckEqual(checks, name, (long)p.AsInteger(), spec.Value<long>("value"));
            else if (spec["value"] != null) CheckMm(checks, name, p.AsDouble(), spec.Value<double>("value"), 1e-6);
            else checks.Add(new JObject { ["field"] = name, ["expected"] = spec["value_text"], ["actual"] = p.AsString() ?? p.AsValueString(), ["ok"] = (p.AsString() ?? p.AsValueString() ?? "") == (spec.Value<string>("value_text") ?? "") });
        }

        private static long? MaterialOf(Document doc, Element e)
        {
            if (e is FamilyInstance fi) return fi.StructuralMaterialId.Value;
            if (e is Floor floor && floor.FloorType.GetCompoundStructure() is CompoundStructure cs && cs.StructuralMaterialIndex >= 0)
                return cs.GetLayers()[cs.StructuralMaterialIndex].MaterialId.Value;
            return null;
        }

        private static void Rebind(Document doc, List<Row> rows, Row row)
        {
            using (var sub = new SubTransaction(doc))
            {
                sub.Start();
                try
                {
                    var deps = Inventory(doc, row);
                    row.Dependants = deps;
                    row.Gate("rebind")["dependants"] = DepArray(deps);
                    var results = new JArray();
                    foreach (Dep dep in deps) results.Add(ApplyRebind(doc, rows, row, dep));
                    JObject copied = CopyColumnAttachments(doc, rows, row);
                    if (copied != null) results.Add(copied);
                    foreach (JToken extra in row.Input["join_to"] as JArray ?? new JArray())
                        results.Add(RequestedJoin(doc, rows, row, extra));
                    bool ok = results.All(r => r.Value<bool>("ok"));
                    row.Gate("rebind")["results"] = results;
                    row.Gate("rebind")["status"] = ok ? "pass" : "fail";
                    row.Gate("rebind")["applied"] = ok;
                    if (!ok)
                    {
                        sub.RollBack();
                        row.Gate("rebind")["applied"] = false;
                        row.Gate("rebind")["reason"] = "This row's rebind sub-transaction was rolled back. Earlier rows are unchanged.";
                        row.RebindOk = false;
                        return;
                    }
                    if (sub.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit did not commit the rebind sub-transaction.");
                    row.RebindOk = true;
                }
                catch
                {
                    if (sub.GetStatus() == TransactionStatus.Started) sub.RollBack();
                    throw;
                }
            }
        }

        private static List<Dep> Inventory(Document doc, Row row)
        {
            var deps = new List<Dep>();
            var mgr = Autodesk.Revit.DB.Structure.AnalyticalToPhysicalAssociationManager.GetAnalyticalToPhysicalAssociationManager(doc)
                ?? throw new InvalidOperationException("Analytical associations could not be inventoried (the association manager is missing). The row stops. No dependants were assumed absent.");
            foreach (long oldId in row.OldIds)
            {
                Element old = doc.GetElement(new ElementId(oldId)) ?? throw new InvalidOperationException($"Old id {oldId} disappeared before rebind.");
                ICollection<ElementId> joined;
                try { joined = JoinGeometryUtils.GetJoinedElements(doc, old); }
                catch (Exception ex) { throw new InvalidOperationException($"Joined elements of {oldId} could not be listed: {ex.Message}"); }
                foreach (ElementId id in joined)
                {
                    if (row.OldIds.Contains(id.Value)) continue;
                    Add(deps, doc.GetElement(id), "join", id.Value);
                }
                Autodesk.Revit.DB.Structure.RebarHostData host;
                try { host = Autodesk.Revit.DB.Structure.RebarHostData.GetRebarHostData(old); }
                catch (Exception ex) { throw new InvalidOperationException($"Rebar hosted on {oldId} could not be listed: {ex.Message}"); }
                if (host != null)
                {
                    foreach (Element bar in host.GetRebarsInHost()) Add(deps, bar, "rebar_host", oldId);
                    foreach (Element bar in host.GetRebarContainersInHost()) Add(deps, bar, "rebar_container", oldId);
                    foreach (Element bar in host.GetAreaReinforcementsInHost()) Add(deps, bar, "area_reinforcement", oldId);
                    foreach (Element bar in host.GetPathReinforcementsInHost()) Add(deps, bar, "path_reinforcement", oldId);
                    foreach (Element bar in host.GetFabricAreasInHost()) Add(deps, bar, "fabric_area", oldId);
                    foreach (Element bar in host.GetFabricSheetsInHost()) Add(deps, bar, "fabric_sheet", oldId);
                }
                ElementId analytical = mgr.GetAssociatedElementId(old.Id);
                if (analytical != null && analytical != ElementId.InvalidElementId)
                    Add(deps, doc.GetElement(analytical), "analytical_association", oldId);
                IList<ElementId> dependent;
                try { dependent = old.GetDependentElements(null); }
                catch (Exception ex) { throw new InvalidOperationException($"Dependants of {oldId} could not be listed: {ex.Message}"); }
                foreach (ElementId id in dependent)
                {
                    Element el = doc.GetElement(id);
                    if (el == null || el.Id == old.Id) continue;
                    Add(deps, el, Classify(el, oldId), oldId);
                }
            }
            foreach (FamilyInstance column in new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
            {
                if (column.Category == null || column.Category.Id.Value != (long)BuiltInCategory.OST_StructuralColumns) continue;
                foreach (int end in new[] { 0, 1 })
                {
                    Autodesk.Revit.DB.ColumnAttachment att = null;
                    try { att = Autodesk.Revit.DB.ColumnAttachment.GetColumnAttachment(column, end); }
                    catch (Exception) { att = null; }
                    if (att == null) continue;
                    using (att)
                    {
                        if (row.OldIds.Contains(att.TargetId.Value)) Add(deps, column, "column_attachment", att.TargetId.Value);
                    }
                }
            }
            foreach (Dep dep in deps)
            {
                if (row.ExpectedDeleted.Contains(dep.Id) && NotHandled.Contains(dep.Relationship))
                {
                    dep.Action = "accepted_cascade";
                    dep.MustSurvive = false;
                }
            }
            return deps;
        }

        private static void Add(List<Dep> deps, Element el, string relationship, long other)
        {
            if (el == null) return;
            Dep existing = deps.FirstOrDefault(d => d.Id == el.Id.Value);
            if (existing == null)
            {
                deps.Add(new Dep
                {
                    Id = el.Id.Value,
                    Relationship = relationship,
                    ClassName = el.GetType().Name,
                    Category = el.Category?.Name ?? "",
                    OtherId = other,
                    MustSurvive = true,
                });
                return;
            }
            if (Rank(relationship) > Rank(existing.Relationship))
            {
                existing.Relationship = relationship;
                existing.OtherId = other;
            }
        }

        private static int Rank(string rel)
        {
            switch (rel)
            {
                case "hosted_family": return 90;
                case "column_attachment": return 80;
                case "rebar_host":
                case "rebar_container": return 70;
                case "rebar_in_system":
                case "area_reinforcement":
                case "path_reinforcement":
                case "fabric_area":
                case "fabric_sheet": return 60;
                case "analytical_association": return 50;
                case "opening": return 40;
                case "annotation": return 30;
                case "join": return 20;
                default: return 10;
            }
        }

        private static bool AttachmentTargetsOld(FamilyInstance column, long oldId)
        {
            for (int end = 0; end < 2; end++)
            {
                Autodesk.Revit.DB.ColumnAttachment att = null;
                try { att = Autodesk.Revit.DB.ColumnAttachment.GetColumnAttachment(column, end); }
                catch (Exception) { return false; }
                if (att == null) continue;
                using (att)
                    if (att.TargetId.Value == oldId) return true;
            }
            return false;
        }

        /// <summary>When the old element is itself a column, copy its base and top attachments onto the new column.</summary>
        private static JObject CopyColumnAttachments(Document doc, List<Row> rows, Row row)
        {
            if (row.Kind != "column") return null;
            if (!(doc.GetElement(new ElementId(row.NewId)) is FamilyInstance made))
                return new JObject { ["relationship"] = "column_attachment", ["ok"] = false, ["action"] = "fail", ["reason"] = "The new element is not a column." };
            int copied = 0;
            foreach (long oldId in row.OldIds)
            {
                if (!(doc.GetElement(new ElementId(oldId)) is FamilyInstance old)) continue;
                if (old.Category == null || old.Category.Id.Value != (long)BuiltInCategory.OST_StructuralColumns) continue;
                for (int end = 0; end < 2; end++)
                {
                    Autodesk.Revit.DB.ColumnAttachment att = Autodesk.Revit.DB.ColumnAttachment.GetColumnAttachment(old, end);
                    if (att == null) continue;
                    using (att)
                    {
                        if (ReplacementMissing(rows, att.TargetId.Value))
                            return new JObject { ["relationship"] = "column_attachment", ["id"] = oldId, ["ok"] = false, ["action"] = "fail", ["reason"] = $"Attachment target {att.TargetId.Value} has no replacement." };
                        Element target = doc.GetElement(new ElementId(MapId(rows, att.TargetId.Value)));
                        if (target == null || !Autodesk.Revit.DB.ColumnAttachment.IsValidTarget(made, target))
                            return new JObject { ["relationship"] = "column_attachment", ["id"] = oldId, ["ok"] = false, ["action"] = "fail", ["reason"] = $"Attachment target {att.TargetId.Value} is not valid for the new column." };
                        Autodesk.Revit.DB.ColumnAttachment.AddColumnAttachment(doc, made, target, att.BaseOrTop, att.CutStyle, att.Justification, att.AttachOffset);
                        copied++;
                    }
                }
            }
            return copied == 0 ? null : new JObject { ["relationship"] = "column_attachment", ["ok"] = true, ["action"] = "rebound", ["copied"] = copied };
        }

        private static string Classify(Element el, long oldId)
        {
            if (el is Autodesk.Revit.DB.Structure.Rebar) return "rebar_host";
            if (el is Autodesk.Revit.DB.Structure.RebarContainer) return "rebar_container";
            if (el is Autodesk.Revit.DB.Structure.RebarInSystem) return "rebar_in_system";
            if (el is Autodesk.Revit.DB.Structure.AreaReinforcement) return "area_reinforcement";
            if (el is Autodesk.Revit.DB.Structure.PathReinforcement) return "path_reinforcement";
            if (el is Autodesk.Revit.DB.Structure.FabricArea) return "fabric_area";
            if (el is Autodesk.Revit.DB.Structure.FabricSheet) return "fabric_sheet";
            if (el is Autodesk.Revit.DB.Structure.AnalyticalMember) return "analytical_association";
            if (el is FamilyInstance fi && fi.Host != null && fi.Host.Id.Value == oldId) return "hosted_family";
            if (el is FamilyInstance col && col.Category != null && col.Category.Id.Value == (long)BuiltInCategory.OST_StructuralColumns && AttachmentTargetsOld(col, oldId))
                return "column_attachment";
            if (el is Opening) return "opening";
            if (el is IndependentTag || el is Dimension) return "annotation";
            return "other";
        }

        private static JObject ApplyRebind(Document doc, List<Row> rows, Row row, Dep dep)
        {
            if (dep.Action == "accepted_cascade")
                return ResultOf(dep, true, "accepted_cascade", "Listed in expected_deleted_ids. Not rebound.");
            if (rows.Any(r => r.OldIds.Contains(dep.Id)) && dep.Relationship != "join")
            {
                dep.MustSurvive = false;
                return ResultOf(dep, true, "replaced_in_batch", "This id is an old element in this batch. Its own row replaces it. It is not rebound.");
            }
            Element el = doc.GetElement(new ElementId(dep.Id));
            Element made = doc.GetElement(new ElementId(row.NewId));
            if (el == null || made == null) return ResultOf(dep, false, "fail", "The dependant or the new element is missing.");
            try
            {
                switch (dep.Relationship)
                {
                    case "rebar_host":
                        ((Autodesk.Revit.DB.Structure.Rebar)el).SetHostId(doc, made.Id);
                        dep.Action = "rebound";
                        return ResultOf(dep, true, "rebound", "");
                    case "rebar_container":
                        ((Autodesk.Revit.DB.Structure.RebarContainer)el).SetHostId(doc, made.Id);
                        dep.Action = "rebound";
                        return ResultOf(dep, true, "rebound", "");
                    case "join":
                        return Rejoin(doc, rows, row, dep, el, made);
                    case "column_attachment":
                        return Reattach(doc, rows, row, dep, el as FamilyInstance, made);
                    case "analytical_association":
                        return Reassociate(doc, rows, row, dep, el);
                    case "hosted_family":
                        return ResultOf(dep, false, "fail", $"Hosted family {dep.Id} ({dep.Category}) needs a rehost onto {row.NewId}. Revit has no safe rehost for this, so the row fails.");
                    default:
                        return ResultOf(dep, false, "fail", $"{dep.Relationship} on {dep.Id} ({dep.ClassName}, {dep.Category}) cannot be rebound safely. The row fails.");
                }
            }
            catch (Exception ex)
            {
                return ResultOf(dep, false, "fail", ex.Message);
            }
        }

        private static JObject Rejoin(Document doc, List<Row> rows, Row row, Dep dep, Element partner, Element made)
        {
            if (ReplacementMissing(rows, dep.Id))
                return ResultOf(dep, false, "fail", $"Join partner {dep.Id} is an old id whose replacement did not get created.");
            ElementId targetId = new ElementId(MapId(rows, dep.Id));
            Element target = doc.GetElement(targetId) ?? partner;
            Element old = doc.GetElement(new ElementId(dep.OtherId));
            bool oldCuts = old != null && JoinGeometryUtils.AreElementsJoined(doc, old, partner) && JoinGeometryUtils.IsCuttingElementInJoin(doc, old, partner);
            if (old != null && JoinGeometryUtils.AreElementsJoined(doc, old, partner)) JoinGeometryUtils.UnjoinGeometry(doc, old, partner);
            if (!JoinGeometryUtils.AreElementsJoined(doc, made, target)) JoinGeometryUtils.JoinGeometry(doc, made, target);
            if (oldCuts && !JoinGeometryUtils.IsCuttingElementInJoin(doc, made, target)) JoinGeometryUtils.SwitchJoinOrder(doc, made, target);
            dep.Action = "rebound";
            dep.RebindTo = target.Id.Value;
            dep.MustSurvive = !rows.Any(r => r.OldIds.Contains(dep.Id));
            return ResultOf(dep, true, "rebound", "");
        }

        private static JObject Reattach(Document doc, List<Row> rows, Row row, Dep dep, FamilyInstance column, Element made)
        {
            if (column == null) return ResultOf(dep, false, "fail", "Column attachment is not a column.");
            if (row.OldIds.Contains(column.Id.Value))
            {
                if (!(made is FamilyInstance newColumn)) return ResultOf(dep, false, "fail", "The replacement is not a column, so its attachments cannot be copied.");
                for (int end = 0; end < 2; end++)
                {
                    Autodesk.Revit.DB.ColumnAttachment att = Autodesk.Revit.DB.ColumnAttachment.GetColumnAttachment(column, end);
                    if (att == null) continue;
                    using (att)
                    {
                        if (ReplacementMissing(rows, att.TargetId.Value)) return ResultOf(dep, false, "fail", $"Attachment target {att.TargetId.Value} has no replacement.");
                        Element target = doc.GetElement(new ElementId(MapId(rows, att.TargetId.Value)));
                        if (target == null || !Autodesk.Revit.DB.ColumnAttachment.IsValidTarget(newColumn, target))
                            return ResultOf(dep, false, "fail", $"Column attachment target {att.TargetId.Value} is not a valid target for the new column.");
                        Autodesk.Revit.DB.ColumnAttachment.AddColumnAttachment(doc, newColumn, target, att.BaseOrTop, att.CutStyle, att.Justification, att.AttachOffset);
                    }
                }
                dep.Action = "rebound";
                return ResultOf(dep, true, "rebound", "");
            }
            for (int end = 0; end < 2; end++)
            {
                Autodesk.Revit.DB.ColumnAttachment att = Autodesk.Revit.DB.ColumnAttachment.GetColumnAttachment(column, end);
                if (att == null) continue;
                using (att)
                {
                    if (!row.OldIds.Contains(att.TargetId.Value)) continue;
                    if (!Autodesk.Revit.DB.ColumnAttachment.IsValidTarget(column, made))
                        return ResultOf(dep, false, "fail", $"The new element is not a valid column-attachment target for {column.Id.Value}.");
                    int which = att.BaseOrTop;
                    var cut = att.CutStyle;
                    var just = att.Justification;
                    double offset = att.AttachOffset;
                    Autodesk.Revit.DB.ColumnAttachment.RemoveColumnAttachment(column, att.TargetId);
                    Autodesk.Revit.DB.ColumnAttachment.AddColumnAttachment(doc, column, made, which, cut, just, offset);
                }
            }
            dep.Action = "rebound";
            dep.RebindTo = row.NewId;
            return ResultOf(dep, true, "rebound", "");
        }

        private static JObject Reassociate(Document doc, List<Row> rows, Row row, Dep dep, Element analytical)
        {
            var mgr = Autodesk.Revit.DB.Structure.AnalyticalToPhysicalAssociationManager.GetAnalyticalToPhysicalAssociationManager(doc);
            if (mgr == null) return ResultOf(dep, false, "fail", "Analytical association manager is missing.");
            ElementId physical = new ElementId(row.NewId);
            mgr.RemoveAssociation(new ElementId(dep.OtherId));
            mgr.AddAssociation(analytical.Id, physical);
            dep.Action = "rebound";
            dep.RebindTo = row.NewId;
            return ResultOf(dep, true, "rebound", "");
        }

        private static JObject RequestedJoin(Document doc, List<Row> rows, Row row, JToken token)
        {
            Element made = doc.GetElement(new ElementId(row.NewId));
            Element target = null;
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float)
            {
                long id = token.Value<long>();
                if (ReplacementMissing(rows, id)) return new JObject { ["relationship"] = "requested_join", ["id"] = id, ["ok"] = false, ["action"] = "fail", ["reason"] = "The requested join target has no replacement." };
                target = doc.GetElement(new ElementId(MapId(rows, id)));
            }
            else
            {
                Row other = rows.FirstOrDefault(r => r.Id == token.ToString());
                if (other == null || !other.CreateOk) return new JObject { ["relationship"] = "requested_join", ["id"] = token.ToString(), ["ok"] = false, ["action"] = "fail", ["reason"] = "The requested join row did not pass create." };
                target = doc.GetElement(new ElementId(other.NewId));
            }
            if (made == null || target == null) return new JObject { ["relationship"] = "requested_join", ["ok"] = false, ["action"] = "fail", ["reason"] = "Join target is missing." };
            try
            {
                if (!JoinGeometryUtils.AreElementsJoined(doc, made, target)) JoinGeometryUtils.JoinGeometry(doc, made, target);
                return new JObject { ["relationship"] = "requested_join", ["id"] = target.Id.Value, ["ok"] = true, ["action"] = "rebound" };
            }
            catch (Exception ex)
            {
                return new JObject { ["relationship"] = "requested_join", ["id"] = target.Id.Value, ["ok"] = false, ["action"] = "fail", ["reason"] = ex.Message };
            }
        }

        private static void DeleteAndOrphans(Document doc, List<Row> rows, Row row)
        {
            using (var sub = new SubTransaction(doc))
            {
                sub.Start();
                try
                {
                    var asked = row.OldIds.Select(id => new ElementId(id)).ToList();
                    ICollection<ElementId> gone = asked.Count == 0 ? new List<ElementId>() : doc.Delete(asked);
                    var actual = new HashSet<long>(gone.Select(id => id.Value));
                    var unexpected = actual.Where(id => !row.ExpectedDeleted.Contains(id)).OrderBy(id => id).ToList();
                    var missing = row.OldIds.Where(id => !actual.Contains(id)).ToList();
                    row.Gate("delete")["asked"] = new JArray(row.OldIds);
                    row.Gate("delete")["expected"] = new JArray(row.ExpectedDeleted.OrderBy(id => id));
                    row.Gate("delete")["deleted"] = new JArray(actual.OrderBy(id => id));
                    row.Gate("delete")["unexpected"] = new JArray(unexpected);
                    row.Gate("delete")["old_ids_missing_from_delete"] = new JArray(missing);
                    if (unexpected.Count > 0 || missing.Count > 0)
                    {
                        row.Gate("delete")["status"] = "fail";
                        row.Gate("delete")["rolled_back"] = true;
                        row.Gate("delete")["reason"] = unexpected.Count > 0
                            ? "Revit deleted ids that were not in the expected set. This sub-transaction was rolled back."
                            : "An old id was not among the ids Revit deleted. This sub-transaction was rolled back.";
                        JArray findings = Orphans(doc, rows, row, actual);
                        row.Gate("orphans")["status"] = "fail";
                        row.Gate("orphans")["findings"] = findings;
                        sub.RollBack();
                        throw new InvalidOperationException(row.Gate("delete").Value<string>("reason"));
                    }
                    JArray orphans = Orphans(doc, rows, row, actual);
                    bool clean = orphans.Count == 0;
                    row.Gate("delete")["status"] = "pass";
                    row.Gate("orphans")["status"] = clean ? "pass" : "fail";
                    row.Gate("orphans")["findings"] = orphans;
                    if (!clean)
                    {
                        row.Gate("delete")["status"] = "fail";
                        row.Gate("delete")["rolled_back"] = true;
                        row.Gate("delete")["reason"] = "Orphans were found, so the deletion sub-transaction was rolled back.";
                        sub.RollBack();
                        throw new InvalidOperationException("Orphan check failed.");
                    }
                    if (sub.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit did not commit the deletion sub-transaction.");
                    row.DeleteOk = true;
                    row.OrphanOk = true;
                }
                catch
                {
                    if (sub.GetStatus() == TransactionStatus.Started) sub.RollBack();
                    throw;
                }
            }
        }

        private static JArray Orphans(Document doc, List<Row> rows, Row row, HashSet<long> deleted)
        {
            var findings = new JArray();
            if (doc.GetElement(new ElementId(row.NewId)) == null)
                findings.Add(new JObject { ["kind"] = "replacement_missing", ["id"] = row.NewId });
            foreach (Dep dep in row.Dependants.Where(d => d.MustSurvive && d.Action == "rebound"))
            {
                Element el = doc.GetElement(new ElementId(dep.Id));
                if (el == null)
                {
                    findings.Add(new JObject { ["kind"] = "dependant_missing", ["id"] = dep.Id, ["relationship"] = dep.Relationship });
                    continue;
                }
                if (dep.Relationship == "rebar_host" && el is Autodesk.Revit.DB.Structure.Rebar rebar && (deleted.Contains(rebar.GetHostId().Value) || doc.GetElement(rebar.GetHostId()) == null))
                    findings.Add(new JObject { ["kind"] = "dangling_rebar", ["id"] = dep.Id, ["host"] = rebar.GetHostId().Value });
                if (dep.Relationship == "rebar_container" && el is Autodesk.Revit.DB.Structure.RebarContainer box && (deleted.Contains(box.GetHostId().Value) || doc.GetElement(box.GetHostId()) == null))
                    findings.Add(new JObject { ["kind"] = "dangling_rebar", ["id"] = dep.Id, ["host"] = box.GetHostId().Value });
                if (dep.Relationship == "analytical_association")
                {
                    var mgr = Autodesk.Revit.DB.Structure.AnalyticalToPhysicalAssociationManager.GetAnalyticalToPhysicalAssociationManager(doc);
                    ElementId phys = mgr?.GetAssociatedElementId(el.Id) ?? ElementId.InvalidElementId;
                    if (phys.Value != row.NewId)
                        findings.Add(new JObject { ["kind"] = "dangling_analytical", ["id"] = dep.Id, ["associated"] = phys.Value, ["expected"] = row.NewId });
                }
                if (dep.Relationship == "join" && dep.RebindTo != 0)
                {
                    Element target = doc.GetElement(new ElementId(dep.RebindTo));
                    Element made = doc.GetElement(new ElementId(row.NewId));
                    if (made == null || target == null || !JoinGeometryUtils.AreElementsJoined(doc, made, target))
                        findings.Add(new JObject { ["kind"] = "join_missing", ["id"] = dep.Id, ["expected"] = dep.RebindTo });
                }
                if (el is FamilyInstance fi && fi.Host != null && deleted.Contains(fi.Host.Id.Value))
                    findings.Add(new JObject { ["kind"] = "hosted_without_host", ["id"] = dep.Id, ["host"] = fi.Host.Id.Value });
            }
            foreach (Autodesk.Revit.DB.Structure.Rebar rebar in new FilteredElementCollector(doc).OfClass(typeof(Autodesk.Revit.DB.Structure.Rebar)).Cast<Autodesk.Revit.DB.Structure.Rebar>())
                if (deleted.Contains(rebar.GetHostId().Value))
                    findings.Add(new JObject { ["kind"] = "dangling_rebar", ["id"] = rebar.Id.Value, ["host"] = rebar.GetHostId().Value });
            var mgr2 = Autodesk.Revit.DB.Structure.AnalyticalToPhysicalAssociationManager.GetAnalyticalToPhysicalAssociationManager(doc);
            if (mgr2 != null)
                foreach (Autodesk.Revit.DB.Structure.AnalyticalMember member in new FilteredElementCollector(doc).OfClass(typeof(Autodesk.Revit.DB.Structure.AnalyticalMember)).Cast<Autodesk.Revit.DB.Structure.AnalyticalMember>())
                {
                    ElementId phys = mgr2.GetAssociatedElementId(member.Id);
                    if (phys != null && deleted.Contains(phys.Value))
                        findings.Add(new JObject { ["kind"] = "dangling_analytical", ["id"] = member.Id.Value, ["associated"] = phys.Value });
                }
            return findings;
        }

        private static bool ReplacementMissing(List<Row> rows, long id) => rows.Any(r => r.OldIds.Contains(id) && !r.CreateOk);

        private static long MapId(List<Row> rows, long id)
        {
            Row owner = rows.FirstOrDefault(r => r.CreateOk && r.OldIds.Contains(id) && r.NewId != 0);
            return owner == null ? id : owner.NewId;
        }

        private static JObject ResultOf(Dep dep, bool ok, string action, string reason)
        {
            dep.Action = action;
            if (!ok) dep.MustSurvive = false;
            var o = new JObject
            {
                ["id"] = dep.Id, ["class"] = dep.ClassName, ["category"] = dep.Category,
                ["relationship"] = dep.Relationship, ["ok"] = ok, ["action"] = action,
            };
            if (dep.RebindTo != 0) o["rebind_to"] = dep.RebindTo;
            if (!string.IsNullOrEmpty(reason)) o["reason"] = reason;
            return o;
        }

        private static JArray DepArray(List<Dep> deps) => new JArray(deps.Select(d => new JObject
        {
            ["id"] = d.Id, ["class"] = d.ClassName, ["category"] = d.Category,
            ["relationship"] = d.Relationship, ["other_id"] = d.OtherId, ["must_survive"] = d.MustSurvive,
        }));

        private static void CheckMm(JArray checks, string field, double? actual, double? expected, double tol)
        {
            if (expected == null) return;
            bool ok = actual != null && Math.Abs(actual.Value - expected.Value) <= tol;
            checks.Add(new JObject { ["field"] = field, ["expected"] = expected, ["actual"] = actual, ["ok"] = ok, ["tolerance_mm"] = tol });
        }

        private static void CheckEqual(JArray checks, string field, long? actual, long? expected)
        {
            if (expected == null) return;
            checks.Add(new JObject { ["field"] = field, ["expected"] = expected, ["actual"] = actual, ["ok"] = actual == expected });
        }

        private static void CheckPoint(JArray checks, string field, JArray actual, JArray expected, double tol)
        {
            bool ok = actual != null && actual.Count >= expected.Count;
            if (ok)
                for (int i = 0; i < expected.Count; i++)
                    if (Math.Abs(actual[i].Value<double>() - expected[i].Value<double>()) > tol) ok = false;
            checks.Add(new JObject { ["field"] = field, ["expected"] = expected, ["actual"] = actual, ["ok"] = ok, ["tolerance_mm"] = tol });
        }

        private static void CheckPlan(JArray checks, JArray actual, JArray boundary, double tol)
        {
            if (boundary == null || actual == null || actual.Count < 4)
            {
                checks.Add(new JObject { ["field"] = "boundary_mm", ["expected"] = boundary, ["actual"] = actual, ["ok"] = false });
                return;
            }
            double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
            foreach (JArray p in boundary.OfType<JArray>())
            {
                minX = Math.Min(minX, p[0].Value<double>());
                minY = Math.Min(minY, p[1].Value<double>());
                maxX = Math.Max(maxX, p[0].Value<double>());
                maxY = Math.Max(maxY, p[1].Value<double>());
            }
            bool ok = Math.Abs(actual[0].Value<double>() - minX) <= tol && Math.Abs(actual[1].Value<double>() - minY) <= tol
                && Math.Abs(actual[2].Value<double>() - maxX) <= tol && Math.Abs(actual[3].Value<double>() - maxY) <= tol;
            checks.Add(new JObject
            {
                ["field"] = "boundary_mm",
                ["expected"] = new JArray(minX, minY, maxX, maxY),
                ["actual"] = actual,
                ["ok"] = ok,
                ["tolerance_mm"] = tol,
            });
        }

        private static long LevelIdOf(Element e)
        {
            if (e is Floor floor && floor.LevelId != ElementId.InvalidElementId) return floor.LevelId.Value;
            if (e is FamilyInstance fi)
            {
                ElementId id = fi.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)?.AsElementId()
                    ?? fi.get_Parameter(BuiltInParameter.FAMILY_BASE_LEVEL_PARAM)?.AsElementId();
                if (id != null && id != ElementId.InvalidElementId) return id.Value;
                if (fi.LevelId != ElementId.InvalidElementId) return fi.LevelId.Value;
            }
            return e.LevelId != null && e.LevelId != ElementId.InvalidElementId ? e.LevelId.Value : -1;
        }

        private static string EnumName(Type type, int? value) => value == null ? "" : Enum.GetName(type, value.Value) ?? value.Value.ToString();

        private static JObject Counts(Document doc)
        {
            var map = new SortedDictionary<string, int>(StringComparer.Ordinal);
            foreach (Element e in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                string name = e.Category?.Name ?? "(none)";
                map[name] = map.TryGetValue(name, out int n) ? n + 1 : 1;
            }
            var o = new JObject();
            foreach (var kv in map) o[kv.Key] = kv.Value;
            return o;
        }

        private static bool SameCounts(JObject a, JObject b)
        {
            if (a.Count != b.Count) return false;
            foreach (var p in a) if (b.Value<int?>(p.Key) != p.Value.Value<int>()) return false;
            return true;
        }

        private static bool Alive(Transaction tx) => tx != null && tx.GetStatus() == TransactionStatus.Started;

        private static void Fail(Row row, string gate, string reason)
        {
            row.Gate(gate)["status"] = "fail";
            row.Gate(gate)["reason"] = reason;
        }

        private static void Skip(Row row, string gate, string reason)
        {
            if (row.Gate(gate)["status"] != null) return;
            row.Gate(gate)["status"] = "not_run";
            row.Gate(gate)["reason"] = reason;
        }

        private static double Ft(double mm) => mm / 304.8;
        private static double Mm(double ft) => Math.Round(ft * 304.8, 1);
        private static JArray P(XYZ p) => new JArray(Mm(p.X), Mm(p.Y), Mm(p.Z));
        private static XYZ Xyz(JArray a, string why)
        {
            if (a == null || a.Count < 3) throw new InvalidOperationException(why);
            return new XYZ(Ft(a[0].Value<double>()), Ft(a[1].Value<double>()), Ft(a[2].Value<double>()));
        }

        private sealed class Dep
        {
            public long Id;
            public string Relationship;
            public string ClassName;
            public string Category;
            public long OtherId;
            public string Action;
            public bool MustSurvive;
            public long RebindTo;
        }

        private sealed class Row
        {
            public JObject Input;
            public string Id;
            public string Kind;
            public long TypeId;
            public long LevelId;
            public string Keynote;
            public List<long> OldIds;
            public HashSet<long> ExpectedDeleted;
            public List<string> DependsOn;
            public long NewId;
            public bool CreateOk, VerifyOk, RebindOk, DeleteOk, OrphanOk;
            public List<Dep> Dependants = new List<Dep>();
            public JObject Report;
            private readonly JObject _gates = new JObject();

            public Row(JObject input)
            {
                Input = input;
                Id = input.Value<string>("id") ?? "";
                Kind = input.Value<string>("kind") ?? "";
                TypeId = input.Value<long?>("type_id") ?? 0;
                LevelId = input.Value<long?>("level_id") ?? 0;
                Keynote = input.Value<string>("keynote") ?? "";
                OldIds = (input["old_ids"] as JArray ?? new JArray()).Select(t => t.Value<long>()).ToList();
                ExpectedDeleted = new HashSet<long>(OldIds);
                if (input["expected_deleted_ids"] is JArray extra)
                    foreach (JToken t in extra) ExpectedDeleted.Add(t.Value<long>());
                foreach (long id in OldIds)
                    if (!ExpectedDeleted.Contains(id)) ExpectedDeleted.Add(id);
                DependsOn = (input["depends_on"] as JArray ?? new JArray()).Select(t => t.ToString()).ToList();
                if (Id.Length == 0) throw new InvalidOperationException("Every row needs an id.");
                if (TypeId == 0 || LevelId == 0) throw new InvalidOperationException($"Row {Id} needs type_id and level_id.");
                Report = new JObject { ["id"] = Id, ["kind"] = Kind, ["gates"] = _gates };
            }

            public JObject Gate(string name)
            {
                if (!(_gates[name] is JObject g)) { g = new JObject(); _gates[name] = g; }
                return g;
            }

            public void Finish()
            {
                string[] names = { "create", "verify", "rebind", "delete", "orphans" };
                bool pass = names.All(n => Gate(n).Value<string>("status") == "pass");
                Report["status"] = pass ? "pass" : "fail";
                if (NewId != 0) Report["new_id"] = NewId;
            }
        }

        private sealed class Quiet : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                    if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                return FailureProcessingResult.Continue;
            }
        }
    }
}
