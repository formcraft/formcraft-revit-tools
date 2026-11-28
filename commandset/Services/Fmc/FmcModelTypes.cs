using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.SystemTypes;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The system-type editor in fmc_model_edit (review item 3, approved 28 Nov 13:24): duplicate_type and edit_type share
    /// one engine for compound layers (walls, floors, roofs, ceilings, edited in place or on a duplicate), core
    /// boundaries, wrapping, stair, run and landing types, type parameters, and the MEP type definitions in
    /// FmcModelTypesMep.cs. Every requested edit answers one row (items): ok, before, after, or a code and reason.
    /// A real run writes inside the batch's own transaction, one SubTransaction per edit group (the fmc_conduit apply
    /// pattern); a failed row rolls the batch back unless the op says partial: true. delete_type is never run here: it
    /// needs a person (FMC-NEEDS-PERSON).
    ///
    /// plan_only (the batch flag): PlanOnly reads and answers, and starts no Transaction, TransactionGroup or
    /// SubTransaction, so nothing changes and nothing is borrowed on a workshared local. The transaction dry run
    /// (dry_run true) commits each op's transaction inside a group and rolls the group back: on a workshared local, an op
    /// that changes an existing element makes Revit take ownership of it when that transaction commits, and rolling the
    /// group back does not give the ownership back. That is why type edits are planned with plan_only.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        /// <summary>A type op whose rows have a failure: the batch rolls back and the answer carries every row.</summary>
        internal sealed class TypeItemsFailed : Exception
        {
            internal JArray Items { get; }
            internal TypeItemsFailed(string message, JArray items) : base(message) { Items = items; }
        }

        private static readonly HashSet<string> PlanOps = new HashSet<string> { "edit_type", "duplicate_type", "delete_type", "set_param" };

        // ---------------- plan only: reads, no transaction ----------------

        private JObject PlanOnly(Document doc, List<JObject> ops)
        {
            var results = new JArray();
            var planned = new Dictionary<int, ElementId>(); // op n (1-based) -> the type it reads in place of the one it would make
            int failed = 0;
            for (int i = 0; i < ops.Count; i++)
            {
                JObject op = ops[i];
                string name = op.Value<string>("op") ?? "";
                JObject row;
                if (!PlanOps.Contains(name) || name == "set_param" && op.Value<bool?>("on_type") != true)
                    row = new JObject { ["ok"] = false, ["code"] = TypeEditCore.CodePlanOnlyTypes,
                        ["reason"] = "plan_only plans type ops only (edit_type, duplicate_type, delete_type, set_param on_type): use dry_run for the rest" };
                else
                {
                    try { row = PlanTypeOp(doc, name, op, planned, i + 1); }
                    catch (Exception ex) { row = new JObject { ["ok"] = false, ["reason"] = ex.Message }; }
                }
                row["op"] = i + 1; row["kind"] = name;
                if (row.Value<bool?>("ok") == false) failed++;
                results.Add(row);
            }
            return new JObject
            {
                ["applied"] = false, ["dry_run"] = true, ["plan_only"] = true, ["ops"] = results, ["failed_ops"] = failed,
                ["transaction"] = "none", ["borrowed"] = false, ["saved"] = false, ["synced"] = false, ["relinquished"] = false,
                ["note"] = "Plan only: read from the model with no transaction, so nothing changed and nothing was checked out. " +
                           "would_borrow says which existing types a real run would take ownership of on a workshared local.",
                ["document"] = FmcTarget.DescribeState(doc),
            };
        }

        private JObject PlanTypeOp(Document doc, string name, JObject op, Dictionary<int, ElementId> planned, int opNo)
        {
            if (name == "set_param") return PlanSetParamOnType(doc, op);
            ElementType source = PlanTypeRef(doc, op, planned, out string viaNote);
            var head = Describe(doc, source, editsExisting: name == "edit_type");
            if (viaNote != null) head["read_from"] = viaNote;
            if (name == "delete_type")
            {
                head["ok"] = false; head["code"] = TypeEditCore.CodeNeedsPerson;
                head["dependents"] = SafeCount(() => source.GetDependentElements(null).Count);
                head["reason"] = DeleteRefusal(source);
                return head;
            }
            var items = new JArray();
            if (name == "duplicate_type")
            {
                string newName = op.Value<string>("new_name");
                if (string.IsNullOrWhiteSpace(newName)) items.Add(TypeEditCore.Item("new_name", false, TypeEditCore.CodeBadValue, "duplicate_type needs new_name"));
                else
                {
                    ElementType taken = NameTaken(doc, source, newName);
                    items.Add(taken != null
                        ? TypeEditCore.Item("new_name", false, TypeEditCore.CodeNameTaken, $"{newName} is already type {taken.Id.Value}: no second type of that name is made")
                        : TypeEditCore.Item("new_name", true, null, $"a new {source.GetType().Name} {newName}, copied from {source.Name}"));
                }
                planned[opNo] = source.Id;
            }
            else planned[opNo] = source.Id;
            EditGroups(doc, source, op, items, apply: false);
            head["items"] = items;
            head["ok"] = items.All(x => x.Value<bool>("ok"));
            return head;
        }

        private JObject PlanSetParamOnType(Document doc, JObject op)
        {
            string pname = op.Value<string>("param") ?? throw new InvalidOperationException("set_param needs param");
            var ids = (op["ids"] as JArray ?? throw new InvalidOperationException("set_param needs ids")).Select(x => Ref(doc, x, new List<List<ElementId>>())).ToList();
            var items = new JArray();
            foreach (var typeId in ids.Select(id => doc.GetElement(id)).Where(e => e != null).Select(e => e is ElementType ? e.Id : e.GetTypeId()).Distinct())
            {
                Element t = doc.GetElement(typeId);
                var row = TypeEditCore.Item($"type {typeId.Value}", true);
                row["type"] = t?.Name; row["instances"] = CountUsers(doc, typeId);
                row["ownership"] = Ownership(doc, typeId, true);
                Parameter p = t?.LookupParameter(pname);
                if (p == null) { row["ok"] = false; row["code"] = TypeEditCore.CodeBadValue; row["reason"] = $"{t?.Name} has no type parameter {pname}"; }
                else if (p.IsReadOnly) { row["ok"] = false; row["code"] = TypeEditCore.CodeReadOnly; row["reason"] = $"{pname} is read-only (Revit works it out)"; }
                else row["before"] = p.AsValueString() ?? p.AsString();
                items.Add(row);
            }
            if (items.Count == 0) return new JObject { ["ok"] = false, ["reason"] = "set_param ids name no element in this model" };
            return new JObject { ["ok"] = items.All(x => x.Value<bool>("ok")), ["param"] = pname, ["items"] = items };
        }

        /// <summary>The type an op names. A "$n" from a duplicate_type earlier in the plan reads that op's source type.</summary>
        private ElementType PlanTypeRef(Document doc, JObject op, Dictionary<int, ElementId> planned, out string note)
        {
            note = null;
            string s = op["type"]?.ToString().Trim();
            if (s != null && s.StartsWith("$") && int.TryParse(s.Substring(1), out int n))
            {
                if (!planned.TryGetValue(n, out ElementId src)) throw new InvalidOperationException($"{s}: op {n} plans no type before this op");
                note = $"{s} is the type op {n} would make: planned on its source type {src.Value}";
                return (ElementType)doc.GetElement(src);
            }
            return TypeRef(doc, op, new List<List<ElementId>>());
        }

        // ---------------- real runs (inside the batch's transaction) ----------------

        private JObject TypeEdit(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            ElementType source = TypeRef(doc, op, made);
            if (name == "delete_type")
                throw new InvalidOperationException($"[{TypeEditCore.CodeNeedsPerson}] {DeleteRefusal(source)}");
            JObject hold = FmcCheckout.Hold(doc, source.Id);
            if (name == "edit_type" && hold != null)
                throw new InvalidOperationException($"[{hold.Value<string>("code")}] type {source.Name} ({source.Id.Value}) can't be edited now: {hold.Value<string>("owner")}. Nothing requests a checkout.");
            var items = new JArray();
            ElementType t = source;
            if (name == "duplicate_type")
            {
                string newName = op.Value<string>("new_name") ?? throw new InvalidOperationException("duplicate_type needs new_name");
                ElementType taken = NameTaken(doc, source, newName);
                if (taken != null) throw new InvalidOperationException($"[{TypeEditCore.CodeNameTaken}] {newName} is already type {taken.Id.Value}: no second type of that name is made");
                t = source.Duplicate(newName);
                created.Add(t.Id);
                items.Add(TypeEditCore.Item("new_name", true, null, $"copied from {source.Name}"));
            }
            EditGroups(doc, t, op, items, apply: true);
            int bad = items.Count(x => !x.Value<bool>("ok"));
            if (bad > 0 && op.Value<bool?>("partial") != true)
                throw new TypeItemsFailed($"{bad} of {items.Count} edits on {t.Name} failed (see items); partial true keeps the ones that worked", items);
            return new JObject { ["type"] = t.Name, ["type_id"] = t.Id.Value, ["class"] = t.GetType().Name, ["items"] = items, ["failed_items"] = bad };
        }

        private static string DeleteRefusal(ElementType t) =>
            $"Deleting a type needs a person: {t.Name} ({t.Id.Value}) is deleted by a person in Revit (Project Browser, or Manage > Purge Unused). " +
            "The AI never deletes types; plan_only lists what uses it.";

        /// <summary>Every edit group the op asks for, on t. apply false only reads (no SubTransaction is opened).</summary>
        private void EditGroups(Document doc, ElementType t, JObject op, JArray items, bool apply)
        {
            string cls = t.GetType().Name;
            List<string> groups = TypeEditCore.RequestedGroups(op, items);
            bool layersDone = false;
            foreach (string g in groups)
            {
                string wrong = TypeEditCore.WrongKind(g, cls);
                if (wrong != null) { items.Add(TypeEditCore.Item(g, false, TypeEditCore.CodeWrongKind, wrong)); continue; }
                try
                {
                    switch (g)
                    {
                        case "layers": case "layer_edits": case "core": case "structural_layer": case "wrapping":
                            if (layersDone) continue;
                            layersDone = true;
                            Step(doc, apply, items, g, () => Layers(doc, (HostObjAttributes)t, op, items, apply));
                            break;
                        case "params":
                            Params(doc, t, op["params"] as JObject, items, apply);
                            break;
                        case "stair":
                            Step(doc, apply, items, g, () => StairType(doc, (StairsType)t, (JObject)op["stair"], items, apply));
                            break;
                        case "stair_run":
                        case "stair_landing":
                            Step(doc, apply, items, g, () => StairPart(doc, t, g, (JObject)op[g], items, apply));
                            break;
                        default:
                            // MEP type definitions (routing, segment_sizes, fittings, fitting_params): FmcModelTypesMep.cs
                            Step(doc, apply, items, g, () => MepGroup(doc, (MEPCurveType)t, g, op[g], items, apply));
                            break;
                    }
                }
                catch (InvalidCastException) { items.Add(TypeEditCore.Item(g, false, TypeEditCore.CodeBadValue, $"{g} is an object")); }
            }
            if (groups.Count == 0 && op.Value<string>("op") == "edit_type" && items.Count == 0)
                items.Add(TypeEditCore.Item("edit_type", false, TypeEditCore.CodeBadValue, "edit_type changes nothing: give at least one edit (layers, layer_edits, core, params, stair, routing, ...)"));
        }

        /// <summary>One edit group: in a real run its own SubTransaction (rolled back alone when Revit refuses it).</summary>
        private static void Step(Document doc, bool apply, JArray items, string group, Action body)
        {
            int before = items.Count;
            if (!apply)
            {
                try { body(); }
                catch (Exception ex) { items.Add(TypeEditCore.Item(group, false, null, ex.Message)); }
                return;
            }
            using (var sub = new SubTransaction(doc))
            {
                sub.Start();
                try
                {
                    body();
                    bool groupOk = items.Skip(before).All(x => x.Value<bool>("ok"));
                    if (groupOk) { sub.Commit(); foreach (JObject r in items.Skip(before)) r["applied"] = true; }
                    else { sub.RollBack(); foreach (JObject r in items.Skip(before)) r["applied"] = false; }
                }
                catch (Exception ex)
                {
                    try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                    foreach (JObject r in items.Skip(before)) r["applied"] = false;
                    items.Add(TypeEditCore.Item(group, false, null, "Revit refused it: " + ex.Message));
                }
            }
        }

        // ---------------- compound layers ----------------

        private static void Layers(Document doc, HostObjAttributes host, JObject op, JArray items, bool apply)
        {
            // GetCompoundStructure returns a copy: changing it changes nothing in the model until SetCompoundStructure
            CompoundStructure cs = host.GetCompoundStructure();
            if (cs == null)
            {
                items.Add(TypeEditCore.Item("layers", false, TypeEditCore.CodeWrongKind,
                    $"{host.Name} has no layers ({host.GetType().Name}: a basic ceiling, sloped glazing or curtain type has no compound structure)"));
                return;
            }
            var current = cs.GetLayers().Select((l, i) => new TypeEditCore.LayerRow
            {
                WidthMm = Mm(l.Width), Function = l.Function.ToString(), MaterialId = l.MaterialId.Value,
                Wraps = SafeBool(() => cs.ParticipatesInWrapping(i)),
            }).ToList();
            int ext = cs.GetNumberOfShellLayers(ShellLayerType.Exterior), inn = cs.GetNumberOfShellLayers(ShellLayerType.Interior);
            var plan = TypeEditCore.PlanLayers(current, ext, inn, cs.StructuralMaterialIndex, op, items);
            string Mat(long id) => doc.GetElement(new ElementId(id))?.Name;
            var summary = TypeEditCore.Item("compound_structure", plan.Ok);
            summary["before"] = new JObject { ["layers"] = new JArray(current.Select(l => l.ToJson(Mat))), ["total_mm"] = Math.Round(current.Sum(l => l.WidthMm), 1), ["core"] = $"{ext}/{inn}" };
            summary["after"] = new JObject { ["layers"] = new JArray(plan.Layers.Select(l => l.ToJson(Mat))), ["total_mm"] = Math.Round(plan.TotalMm, 1), ["core"] = $"{plan.ExteriorShell}/{plan.InteriorShell}", ["structural_layer"] = plan.StructuralIndex };
            if (!plan.Ok) { summary["reason"] = "a layer edit was refused (see its row)"; items.Add(summary); return; }

            // Materials by name: a missing material is a row, never a silent "no material"
            var layers = new List<CompoundStructureLayer>();
            for (int i = 0; i < plan.Layers.Count; i++)
            {
                var l = plan.Layers[i];
                ElementId mat = new ElementId(l.MaterialId);
                if (l.Material != null)
                {
                    mat = new FilteredElementCollector(doc).OfClass(typeof(Material)).FirstOrDefault(m => string.Equals(m.Name, l.Material, StringComparison.OrdinalIgnoreCase))?.Id;
                    if (mat == null) { items.Add(TypeEditCore.Item($"layer {i}", false, TypeEditCore.CodeBadValue, $"the material {l.Material} isn't in this model (load it from the kit)")); summary["ok"] = false; }
                }
                layers.Add(new CompoundStructureLayer(Ft(l.WidthMm), (MaterialFunctionAssignment)Enum.Parse(typeof(MaterialFunctionAssignment), l.Function), mat ?? ElementId.InvalidElementId));
            }
            if (summary.Value<bool>("ok") == false) { summary["reason"] = "a material is missing"; items.Add(summary); return; }

            if (plan.Changed) cs.SetLayers(layers);
            cs.SetNumberOfShellLayers(ShellLayerType.Exterior, plan.ExteriorShell);
            cs.SetNumberOfShellLayers(ShellLayerType.Interior, plan.InteriorShell);
            for (int i = 0; i < plan.Layers.Count; i++)
                if (plan.Layers[i].Wraps is bool w) { try { cs.SetParticipatesInWrapping(i, w); } catch (Exception ex) { items.Add(TypeEditCore.Item($"layer {i}.wraps", false, null, ex.Message)); summary["ok"] = false; } }
            if (plan.StructuralIndex >= 0)
            {
                if (cs.CanLayerBeStructuralMaterial(plan.StructuralIndex)) cs.StructuralMaterialIndex = plan.StructuralIndex;
                else if (op["structural_layer"] != null) { items.Add(TypeEditCore.Item("structural_layer", false, TypeEditCore.CodeBadValue, $"layer {plan.StructuralIndex} can't carry the structural material")); summary["ok"] = false; }
            }
            if (op["wrapping"] is JObject wrap)
            {
                foreach (var kv in wrap)
                {
                    string v = kv.Value?.ToString() ?? "";
                    if (kv.Key == "openings" && Enum.TryParse(v, true, out OpeningWrappingCondition oc)) { summary["before_openings"] = cs.OpeningWrapping.ToString(); cs.OpeningWrapping = oc; items.Add(TypeEditCore.Item("wrapping.openings", true, null, oc.ToString())); }
                    else if (kv.Key == "ends" && Enum.TryParse(v, true, out EndCapCondition ec)) { summary["before_ends"] = cs.EndCap.ToString(); cs.EndCap = ec; items.Add(TypeEditCore.Item("wrapping.ends", true, null, ec.ToString())); }
                    else { items.Add(TypeEditCore.Item($"wrapping.{kv.Key}", false, TypeEditCore.CodeBadValue, "wrapping takes openings (None, Exterior, Interior, ExteriorAndInterior) and ends (None, Exterior, Interior)")); summary["ok"] = false; }
                }
            }
            // Revit's own check, on the copy: read-only
            if (!cs.IsValid(doc, out IDictionary<int, CompoundStructureError> errs, out IDictionary<int, int> _))
            {
                summary["ok"] = false;
                summary["reason"] = "Revit says the layers are not valid: " + string.Join("; ", errs.Select(e => $"layer {e.Key}: {e.Value}"));
            }
            if (summary.Value<bool>("ok") && apply) host.SetCompoundStructure(cs);
            items.Add(summary);
        }

        // ---------------- stairs ----------------

        private static void StairType(Document doc, StairsType st, JObject block, JArray items, bool apply)
        {
            bool ok = true;
            var lengths = TypeEditCore.PlanStairLengths("stair", block, TypeEditCore.StairLengths, TypeEditCore.StairRefs.Keys.Concat(new[] { "middle_supports_number" }), items, ref ok);
            foreach (var kv in lengths)
            {
                string prop = TypeEditCore.StairLengths[kv.Key];
                var row = TypeEditCore.Item($"stair.{kv.Key}", true);
                row["before"] = Mm(GetLength(st, prop)); row["after"] = kv.Value;
                if (apply) SetLength(st, prop, Ft(kv.Value));
                items.Add(row);
            }
            foreach (var kv in TypeEditCore.StairRefs)
            {
                if (block[kv.Key] == null) continue;
                var row = TypeEditCore.Item($"stair.{kv.Key}", true);
                ElementId now = GetRef(st, kv.Value);
                row["before"] = now == ElementId.InvalidElementId ? "none" : doc.GetElement(now)?.Name;
                ElementId target = StairRefTarget(doc, kv.Key, block[kv.Key].ToString(), out string why);
                if (target == null) { row["ok"] = false; row["code"] = TypeEditCore.CodeBadValue; row["reason"] = why; items.Add(row); continue; }
                row["after"] = target == ElementId.InvalidElementId ? "none" : doc.GetElement(target)?.Name;
                if (apply) SetRef(st, kv.Value, target);
                items.Add(row);
            }
            if (block["middle_supports_number"] != null)
            {
                int? n = block.Value<int?>("middle_supports_number");
                var row = TypeEditCore.Item("stair.middle_supports_number", n != null && n >= 0);
                row["before"] = st.MiddleSupportsNumber;
                if (n == null || n < 0) { row["code"] = TypeEditCore.CodeBadValue; row["reason"] = "a whole number from 0"; }
                else { row["after"] = n; if (apply) st.MiddleSupportsNumber = n.Value; }
                items.Add(row);
            }
        }

        /// <summary>stair_run / stair_landing: on a StairsType it edits the type's run or landing type, which other stair types may share.</summary>
        private static void StairPart(Document doc, ElementType t, string group, JObject block, JArray items, bool apply)
        {
            ElementType part = t;
            if (t is StairsType st)
            {
                ElementId pid = group == "stair_run" ? st.RunType : st.LandingType;
                part = doc.GetElement(pid) as ElementType;
                if (part == null) { items.Add(TypeEditCore.Item(group, false, TypeEditCore.CodeBadValue, $"{st.Name} has no {group.Replace("stair_", "")} type")); return; }
                int sharers = new FilteredElementCollector(doc).OfClass(typeof(StairsType)).Cast<StairsType>()
                    .Count(x => x.Id != st.Id && (group == "stair_run" ? x.RunType : x.LandingType) == pid);
                var head = TypeEditCore.Item($"{group}.type", true, null, $"edits {part.Name} ({part.Id.Value})" + (sharers > 0 ? $": {sharers} other stair type(s) use it too and change with it" : ""));
                head["shared_by_stair_types"] = sharers;
                items.Add(head);
            }
            bool ok = true;
            if (part is StairsRunType rt)
            {
                var lengths = TypeEditCore.PlanStairLengths(group, block, TypeEditCore.RunLengths, new[] { "material" }, items, ref ok);
                foreach (var kv in lengths)
                {
                    string prop = TypeEditCore.RunLengths[kv.Key];
                    var row = TypeEditCore.Item($"{group}.{kv.Key}", true);
                    if (kv.Key == "structural_depth_mm" && !rt.IsMonolithic) { row["ok"] = false; row["code"] = TypeEditCore.CodeReadOnly; row["reason"] = "structural depth is for monolithic runs only (StairsRunType.StructuralDepth)"; items.Add(row); continue; }
                    row["before"] = Mm(GetLength(rt, prop)); row["after"] = kv.Value;
                    if (apply) SetLength(rt, prop, Ft(kv.Value));
                    items.Add(row);
                }
                if (block["material"] != null)
                {
                    var row = TypeEditCore.Item($"{group}.material", true);
                    string mname = block.Value<string>("material");
                    ElementId mid = new FilteredElementCollector(doc).OfClass(typeof(Material)).FirstOrDefault(m => string.Equals(m.Name, mname, StringComparison.OrdinalIgnoreCase))?.Id;
                    if (!rt.IsMonolithic) { row["ok"] = false; row["code"] = TypeEditCore.CodeReadOnly; row["reason"] = "StairsRunType.MaterialId is for monolithic runs only"; }
                    else if (mid == null) { row["ok"] = false; row["code"] = TypeEditCore.CodeBadValue; row["reason"] = $"the material {mname} isn't in this model"; }
                    else { row["before"] = doc.GetElement(rt.MaterialId)?.Name; row["after"] = mname; if (apply) rt.MaterialId = mid; }
                    items.Add(row);
                }
            }
            else if (part is StairsLandingType lt)
            {
                var lengths = TypeEditCore.PlanStairLengths(group, block, TypeEditCore.LandingLengths, null, items, ref ok);
                foreach (var kv in lengths)
                {
                    var row = TypeEditCore.Item($"{group}.{kv.Key}", true);
                    row["before"] = Mm(lt.Thickness); row["after"] = kv.Value;
                    if (apply) lt.Thickness = Ft(kv.Value);
                    items.Add(row);
                }
            }
            else items.Add(TypeEditCore.Item(group, false, TypeEditCore.CodeWrongKind, $"{part.Name} isn't a {group.Replace('_', ' ')} type"));
        }

        private static double GetLength(Element e, string prop)
        {
            switch (e)
            {
                case StairsType s:
                    return prop == "MaxRiserHeight" ? s.MaxRiserHeight : prop == "MinTreadDepth" ? s.MinTreadDepth : prop == "MinRunWidth" ? s.MinRunWidth
                        : prop == "LeftLateralOffset" ? s.LeftLateralOffset : s.RightLateralOffset;
                case StairsRunType r:
                    return prop == "RiserThickness" ? r.RiserThickness : prop == "TreadThickness" ? r.TreadThickness : prop == "NosingLength" ? r.NosingLength : r.StructuralDepth;
                default: return 0;
            }
        }

        private static void SetLength(Element e, string prop, double ft)
        {
            switch (e)
            {
                case StairsType s:
                    if (prop == "MaxRiserHeight") s.MaxRiserHeight = ft; else if (prop == "MinTreadDepth") s.MinTreadDepth = ft;
                    else if (prop == "MinRunWidth") s.MinRunWidth = ft; else if (prop == "LeftLateralOffset") s.LeftLateralOffset = ft; else s.RightLateralOffset = ft;
                    break;
                case StairsRunType r:
                    if (prop == "RiserThickness") r.RiserThickness = ft; else if (prop == "TreadThickness") r.TreadThickness = ft;
                    else if (prop == "NosingLength") r.NosingLength = ft; else r.StructuralDepth = ft;
                    break;
            }
        }

        private static ElementId GetRef(StairsType s, string prop) =>
            prop == "RunType" ? s.RunType : prop == "LandingType" ? s.LandingType : prop == "LeftSideSupportType" ? s.LeftSideSupportType
            : prop == "RightSideSupportType" ? s.RightSideSupportType : s.MiddleSupportType;

        private static void SetRef(StairsType s, string prop, ElementId id)
        {
            if (prop == "RunType") s.RunType = id; else if (prop == "LandingType") s.LandingType = id;
            else if (prop == "LeftSideSupportType") s.LeftSideSupportType = id; else if (prop == "RightSideSupportType") s.RightSideSupportType = id;
            else s.MiddleSupportType = id;
        }

        /// <summary>A run type, landing type or support type by id or name; "none" clears a support. Null with why when not found.</summary>
        private static ElementId StairRefTarget(Document doc, string key, string value, out string why)
        {
            why = null;
            bool support = key.EndsWith("_support", StringComparison.Ordinal);
            if (support && string.Equals(value, "none", StringComparison.OrdinalIgnoreCase)) return ElementId.InvalidElementId;
            IEnumerable<ElementType> pool = key == "run_type" ? new FilteredElementCollector(doc).OfClass(typeof(StairsRunType)).Cast<ElementType>()
                : key == "landing_type" ? new FilteredElementCollector(doc).OfClass(typeof(StairsLandingType)).Cast<ElementType>()
                : new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_StairsStringerCarriage).WhereElementIsElementType().Cast<ElementType>();
            var list = pool.ToList();
            ElementType hit = long.TryParse(value, out long v) ? list.FirstOrDefault(x => x.Id.Value == v)
                : list.FirstOrDefault(x => string.Equals(x.Name, value, StringComparison.OrdinalIgnoreCase));
            if (hit == null) why = $"{value} isn't a {key.Replace('_', ' ')} here ({string.Join(", ", list.Take(15).Select(x => x.Name))})";
            return hit?.Id;
        }

        // ---------------- type parameters ----------------

        private static void Params(Document doc, ElementType t, JObject ps, JArray items, bool apply)
        {
            if (ps == null) { items.Add(TypeEditCore.Item("params", false, TypeEditCore.CodeBadValue, "params is {name: value}")); return; }
            foreach (var kv in ps)
            {
                string label = $"params.{kv.Key}";
                Parameter p = t.LookupParameter(kv.Key);
                if (p == null) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeBadValue, $"{t.Name} has no parameter {kv.Key}")); continue; }
                if (p.IsReadOnly) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeReadOnly, $"{kv.Key} is read-only (Revit works it out)")); continue; }
                var row = TypeEditCore.Item(label, true);
                row["before"] = p.AsValueString() ?? p.AsString();
                if (apply)
                {
                    using (var sub = new SubTransaction(doc))
                    {
                        sub.Start();
                        try { SetParam(doc, t, kv.Key, ValueOp(kv.Value), true); sub.Commit(); row["after"] = p.AsValueString() ?? p.AsString(); row["applied"] = true; }
                        catch (Exception ex) { try { sub.RollBack(); } catch (Exception) { } row["ok"] = false; row["applied"] = false; row["reason"] = ex.Message; }
                    }
                }
                else row["after"] = kv.Value;
                items.Add(row);
            }
        }

        // ---------------- reads ----------------

        /// <summary>The type an op names: type (id, unique id, "$n", or a query), or type_name with kind.</summary>
        private ElementType TypeRef(Document doc, JObject op, List<List<ElementId>> made)
        {
            if (op["type"] != null)
            {
                ElementId id = Ref(doc, op["type"], made) ?? throw new InvalidOperationException("type is the type's id");
                return doc.GetElement(id) as ElementType ?? throw new InvalidOperationException($"{id.Value} isn't a type");
            }
            string name = op.Value<string>("type_name") ?? throw new InvalidOperationException($"{op.Value<string>("op")} needs type (id) or type_name with kind");
            string kind = op.Value<string>("kind");
            if (kind == null || !TypeEditCore.Kinds.TryGetValue(kind, out string cls))
                throw new InvalidOperationException($"type_name needs kind ({string.Join(", ", TypeEditCore.Kinds.Keys)})");
            var hits = new FilteredElementCollector(doc).WhereElementIsElementType().Cast<ElementType>()
                .Where(x => x.GetType().Name == cls && string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (hits.Count == 1) return hits[0];
            if (hits.Count > 1) throw new InvalidOperationException($"[{TypeEditCore.CodeAmbiguous}] {hits.Count} {kind} types are named {name} ({string.Join(", ", hits.Select(h => h.Id.Value))}): give type (id)");
            throw new InvalidOperationException($"[{TypeEditCore.CodeTypeNotFound}] no {kind} type named {name}");
        }

        private static ElementType NameTaken(Document doc, ElementType source, string newName) =>
            new FilteredElementCollector(doc).OfClass(source.GetType()).Cast<ElementType>()
                .FirstOrDefault(x => string.Equals(x.Name, newName, StringComparison.OrdinalIgnoreCase)
                                     && (x.Category?.Id ?? ElementId.InvalidElementId) == (source.Category?.Id ?? ElementId.InvalidElementId)
                                     && x.FamilyName == source.FamilyName);

        private static JObject Describe(Document doc, ElementType t, bool editsExisting) => new JObject
        {
            ["type"] = t.Name, ["type_id"] = t.Id.Value, ["class"] = t.GetType().Name, ["family"] = t.FamilyName,
            ["category"] = t.Category?.Name, ["instances"] = CountUsers(doc, t.Id),
            ["ownership"] = Ownership(doc, t.Id, editsExisting),
        };

        /// <summary>How many elements use the type (read-only filter on the type parameter).</summary>
        private static int CountUsers(Document doc, ElementId typeId)
        {
            try
            {
                var rule = ParameterFilterRuleFactory.CreateEqualsRule(new ElementId(BuiltInParameter.ELEM_TYPE_PARAM), typeId);
                return new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementParameterFilter(rule)).GetElementCount();
            }
            catch (Exception) { return -1; }
        }

        /// <summary>Read-only worksharing facts. would_borrow: a real edit of this existing type takes ownership of it.</summary>
        private static JObject Ownership(Document doc, ElementId id, bool editsExisting)
        {
            if (!doc.IsWorkshared) return new JObject { ["workshared"] = false, ["would_borrow"] = false };
            var r = new JObject { ["workshared"] = true };
            try
            {
                CheckoutStatus st = WorksharingUtils.GetCheckoutStatus(doc, id);
                r["checkout"] = st.ToString();
                r["updates"] = WorksharingUtils.GetModelUpdatesStatus(doc, id).ToString();
                r["would_borrow"] = editsExisting && st == CheckoutStatus.NotOwned;
                if (st == CheckoutStatus.OwnedByOtherUser) { r["blocked"] = true; r["owner"] = WorksharingUtils.GetWorksharingTooltipInfo(doc, id)?.Owner ?? "another user"; }
                if (!editsExisting) r["note"] = "a duplicate is a new element: it borrows nothing that exists";
            }
            catch (Exception ex) { r["error"] = ex.Message; }
            return r;
        }

        private static int SafeCount(Func<int> f) { try { return f(); } catch (Exception) { return -1; } }
        private static bool? SafeBool(Func<bool> f) { try { return f(); } catch (Exception) { return null; } }
    }
}
