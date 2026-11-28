using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.SystemTypes;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// MEP TYPE definitions for the system-type editor (modelled on fmc_conduit apply: one row per item, fittings
    /// activated before use). Kept to the type: a pipe or duct type's routing preferences (segment and fitting rules
    /// with their size ranges, preferred junction), a pipe segment's size list, and a cable tray type's fittings.
    /// Nothing here sizes, routes, reconnects or changes an existing pipe, duct or tray run (the MEP tools own that).
    /// Conduit types stay with fmc_conduit apply.
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private void MepGroup(Document doc, MEPCurveType t, string group, JToken spec, JArray items, bool apply)
        {
            switch (group)
            {
                case "routing": Routing(doc, t, spec, items, apply); break;
                case "segment_sizes": SegmentSizes(doc, (PipeType)t, spec, items, apply); break;
                case "fittings": TrayFittings(doc, (CableTrayType)t, spec as JObject, items, apply); break;
                case "fitting_params": TrayFittingParams(doc, (CableTrayType)t, spec as JObject, items, apply); break;
                default: items.Add(TypeEditCore.Item(group, false, TypeEditCore.CodeUnknownKey, $"{group} isn't an MEP type edit")); break;
            }
        }

        private static JArray RulesOf(Document doc, RoutingPreferenceManager rpm, RoutingPreferenceRuleGroupType g)
        {
            var rows = new JArray();
            int n = rpm.GetNumberOfRules(g);
            for (int i = 0; i < n; i++)
            {
                RoutingPreferenceRule r = rpm.GetRule(g, i);
                var row = new JObject { ["index"] = i, ["part_id"] = r.MEPPartId.Value, ["part"] = PartName(doc, r.MEPPartId), ["description"] = r.Description };
                for (int c = 0; c < r.NumberOfCriteria; c++)
                    if (r.GetCriterion(c) is PrimarySizeCriterion p) { row["min_mm"] = Mm(p.MinimumSize); row["max_mm"] = Mm(p.MaximumSize); }
                rows.Add(row);
            }
            return rows;
        }

        private static string PartName(Document doc, ElementId id)
        {
            Element e = doc.GetElement(id);
            return e is FamilySymbol fs ? $"{fs.FamilyName} : {fs.Name}" : e?.Name;
        }

        private static void Routing(Document doc, MEPCurveType t, JToken spec, JArray items, bool apply)
        {
            string cls = t.GetType().Name;
            var adds = new List<TypeEditCore.RuleRow>();
            var removes = new List<TypeEditCore.RuleRemoval>();
            bool ok = true;
            TypeEditCore.ParseRouting(spec, cls, adds, removes, out string junction, items, ref ok);
            RoutingPreferenceManager rpm = t.RoutingPreferenceManager;
            if (rpm == null) { items.Add(TypeEditCore.Item("routing", false, TypeEditCore.CodeWrongKind, $"{t.Name} has no routing preferences")); return; }
            var touched = adds.Select(a => a.Group).Concat(removes.Select(r => r.Group)).Distinct().ToList();
            var before = new JObject();
            foreach (string g in touched) before[g] = RulesOf(doc, rpm, (RoutingPreferenceRuleGroupType)Enum.Parse(typeof(RoutingPreferenceRuleGroupType), g));

            if (junction != null)
            {
                var row = TypeEditCore.Item("routing.preferred_junction", true);
                row["before"] = rpm.PreferredJunctionType.ToString(); row["after"] = junction;
                if (apply) rpm.PreferredJunctionType = (PreferredJunctionType)Enum.Parse(typeof(PreferredJunctionType), junction);
                items.Add(row);
            }
            // Removals highest index first, so each index is the rule a person saw
            foreach (var r in removes.OrderByDescending(x => x.Index))
            {
                var g = (RoutingPreferenceRuleGroupType)Enum.Parse(typeof(RoutingPreferenceRuleGroupType), r.Group);
                int n = rpm.GetNumberOfRules(g);
                if (r.Index >= n) { items.Add(TypeEditCore.Item(r.Label, false, TypeEditCore.CodeBadValue, $"{r.Group} has {n} rules (0..{n - 1})")); continue; }
                var row = TypeEditCore.Item(r.Label, true, null, $"removes {r.Group}[{r.Index}] {PartName(doc, rpm.GetRule(g, r.Index).MEPPartId)}");
                if (apply) rpm.RemoveRule(g, r.Index);
                items.Add(row);
            }
            foreach (var a in adds)
            {
                var g = (RoutingPreferenceRuleGroupType)Enum.Parse(typeof(RoutingPreferenceRuleGroupType), a.Group);
                ElementId part = RoutingPart(doc, t, a.Group, a.Part, out string why);
                if (part == null) { items.Add(TypeEditCore.Item(a.Label, false, TypeEditCore.CodeBadValue, why)); continue; }
                bool dup = false;
                int n = rpm.GetNumberOfRules(g);
                for (int i = 0; i < n && !dup; i++)
                {
                    RoutingPreferenceRule r = rpm.GetRule(g, i);
                    double? mn = null, mx = null;
                    for (int c = 0; c < r.NumberOfCriteria; c++) if (r.GetCriterion(c) is PrimarySizeCriterion p) { mn = Mm(p.MinimumSize); mx = Mm(p.MaximumSize); }
                    bool all = a.MinMm == null && a.MaxMm == null;
                    dup = r.MEPPartId == part && (all || TypeEditCore.SameRule(a.Group, part.Value, a.MinMm, a.MaxMm, a.Group, r.MEPPartId.Value, mn, mx));
                }
                if (dup) { items.Add(TypeEditCore.Item(a.Label, false, TypeEditCore.CodeRuleExists, $"{a.Group} already has {PartName(doc, part)} for that size range: not added twice")); continue; }
                if (a.Index != null && (a.Index < 0 || a.Index > n)) { items.Add(TypeEditCore.Item(a.Label, false, TypeEditCore.CodeBadValue, $"index {a.Index} is outside 0..{n}")); continue; }
                var row = TypeEditCore.Item(a.Label, true, null, $"adds {PartName(doc, part)} to {a.Group}" +
                    (a.MinMm != null || a.MaxMm != null ? $" for {a.MinMm ?? 0}-{(a.MaxMm != null ? a.MaxMm + " mm" : "any")}" : " for all sizes"));
                if (apply) AddRuleNow(doc, rpm, g, a, part);
                items.Add(row);
            }
            var after = new JObject();
            foreach (string g in touched) after[g] = RulesOf(doc, rpm, (RoutingPreferenceRuleGroupType)Enum.Parse(typeof(RoutingPreferenceRuleGroupType), g));
            var sum = TypeEditCore.Item("routing", items.All(x => x.Value<bool>("ok")));
            sum["before"] = before;
            sum["after"] = apply ? after : (JToken)"read after a real run: plan_only lists the rows above";
            sum["note"] = "Type definition only: existing pipes and ducts are not re-routed or resized by this";
            items.Add(sum);
        }

        /// <summary>Writes one routing rule (a real run only: the caller checks apply).</summary>
        private static void AddRuleNow(Document doc, RoutingPreferenceManager manager, RoutingPreferenceRuleGroupType g, TypeEditCore.RuleRow a, ElementId part)
        {
            if (doc.GetElement(part) is FamilySymbol fs && !fs.IsActive) fs.Activate();
            var rule = new RoutingPreferenceRule(part, a.Description);
            rule.AddCriterion(a.MinMm == null && a.MaxMm == null ? PrimarySizeCriterion.All()
                : new PrimarySizeCriterion(Ft(a.MinMm ?? 0), a.MaxMm != null ? Ft(a.MaxMm.Value) : PrimarySizeCriterion.All().MaximumSize));
            if (a.Index != null) manager.AddRule(g, rule, a.Index.Value); else manager.AddRule(g, rule);
        }

        /// <summary>A segment (pipes, Segments group) or a fitting type of the right category for the group.</summary>
        private static ElementId RoutingPart(Document doc, MEPCurveType t, string group, string part, out string why)
        {
            why = null;
            if (group == "Segments")
            {
                var segs = new FilteredElementCollector(doc).OfClass(typeof(PipeSegment)).Cast<PipeSegment>().ToList();
                PipeSegment s = long.TryParse(part, out long v) ? segs.FirstOrDefault(x => x.Id.Value == v)
                    : segs.FirstOrDefault(x => string.Equals(x.Name, part, StringComparison.OrdinalIgnoreCase));
                if (s == null) why = $"{part} isn't a pipe segment here ({string.Join(", ", segs.Take(15).Select(x => x.Name))})";
                return s?.Id;
            }
            BuiltInCategory cat = t is PipeType ? BuiltInCategory.OST_PipeFitting : BuiltInCategory.OST_DuctFitting;
            var syms = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(cat).Cast<FamilySymbol>().ToList();
            FamilySymbol hit = long.TryParse(part, out long id) ? syms.FirstOrDefault(x => x.Id.Value == id)
                : syms.FirstOrDefault(x => string.Equals($"{x.FamilyName} : {x.Name}", part, StringComparison.OrdinalIgnoreCase)
                                        || string.Equals($"{x.FamilyName} {x.Name}", part, StringComparison.OrdinalIgnoreCase));
            if (hit == null)
            {
                if (long.TryParse(part, out long other) && doc.GetElement(new ElementId(other)) is Element e)
                    why = $"{other} is {e.Category?.Name ?? e.GetType().Name}, not a {(t is PipeType ? "pipe" : "duct")} fitting";
                else why = $"{part} isn't a loaded {(t is PipeType ? "pipe" : "duct")} fitting (\"Family : Type\"); load it first";
            }
            return hit?.Id;
        }

        /// <summary>The pipe segment's own size list. Shared: every pipe type whose rules use the segment sees it.</summary>
        private static void SegmentSizes(Document doc, PipeType t, JToken spec, JArray items, bool apply)
        {
            RoutingPreferenceManager rpm = t.RoutingPreferenceManager;
            string want = (spec as JObject)?["segment"]?.ToString();
            PipeSegment seg = null;
            if (want != null) seg = doc.GetElement(RoutingPart(doc, t, "Segments", want, out string why) ?? ElementId.InvalidElementId) as PipeSegment;
            else if (rpm.GetNumberOfRules(RoutingPreferenceRuleGroupType.Segments) > 0)
                seg = doc.GetElement(rpm.GetRule(RoutingPreferenceRuleGroupType.Segments, 0).MEPPartId) as PipeSegment;
            if (seg == null) { items.Add(TypeEditCore.Item("segment_sizes", false, TypeEditCore.CodeBadValue, want != null ? $"{want} isn't a pipe segment here" : $"{t.Name} has no segment rule: give segment")); return; }
            var existing = seg.GetSizes().Select(s => Mm(s.NominalDiameter)).ToList();
            var adds = new List<TypeEditCore.SizeRow>(); var removes = new List<double>();
            bool ok = true;
            TypeEditCore.ParseSegmentSizes(spec, existing, adds, removes, items, ref ok);
            int users = new FilteredElementCollector(doc).OfClass(typeof(PipeType)).Cast<PipeType>().Count(pt =>
            {
                var m = pt.RoutingPreferenceManager; int n = m.GetNumberOfRules(RoutingPreferenceRuleGroupType.Segments);
                for (int i = 0; i < n; i++) if (m.GetRule(RoutingPreferenceRuleGroupType.Segments, i).MEPPartId == seg.Id) return true;
                return false;
            });
            foreach (double r in removes)
            {
                var row = TypeEditCore.Item($"segment_sizes.remove {r}", true);
                if (apply) seg.RemoveSize(Ft(r));
                items.Add(row);
            }
            foreach (var a in adds)
            {
                var row = TypeEditCore.Item(a.Label, true, null, $"{a.NominalMm} mm (ID {a.InnerMm}, OD {a.OuterMm})");
                if (apply) seg.AddSize(new MEPSize(Ft(a.NominalMm), Ft(a.InnerMm), Ft(a.OuterMm), a.Lists, a.Sizing));
                items.Add(row);
            }
            var sum = TypeEditCore.Item("segment_sizes", items.All(x => x.Value<bool>("ok")), null,
                $"segment {seg.Name}: used by {users} pipe type(s), every one of them sees the new list. Existing pipes are not resized.");
            sum["before"] = new JArray(existing);
            sum["segment_id"] = seg.Id.Value;
            items.Add(sum);
        }

        private static readonly string[] TrayRoles = { "elbow", "tee", "cross", "transition", "union" };

        /// <summary>A cable tray type's default fittings by role (MEPCurveType Elbow, Tee, Cross, Transition, Union).</summary>
        private static void TrayFittings(Document doc, CableTrayType t, JObject spec, JArray items, bool apply)
        {
            if (spec == null) { items.Add(TypeEditCore.Item("fittings", false, TypeEditCore.CodeBadValue, "fittings is {elbow?, tee?, cross?, transition?, union?}: \"Family : Type\" each")); return; }
            foreach (var kv in spec)
            {
                string label = $"fittings.{kv.Key}";
                if (!TrayRoles.Contains(kv.Key)) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeUnknownKey, $"roles: {string.Join(", ", TrayRoles)}; other fitting parameters (vertical bends) go in fitting_params by their Type Properties name")); continue; }
                FamilySymbol s = TrayFitting(doc, kv.Value?.ToString(), out string why);
                if (s == null) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeBadValue, why)); continue; }
                FamilySymbol now = kv.Key == "elbow" ? t.Elbow : kv.Key == "tee" ? t.Tee : kv.Key == "cross" ? t.Cross : kv.Key == "transition" ? t.Transition : t.Union;
                var row = TypeEditCore.Item(label, true);
                row["before"] = now == null ? "none" : $"{now.FamilyName} : {now.Name}"; row["after"] = $"{s.FamilyName} : {s.Name}";
                if (apply) SetTrayRole(t, kv.Key, s);
                items.Add(row);
            }
        }

        /// <summary>Any fitting parameter on the tray type by its Type Properties name ("Vertical Inside Bend", ...).</summary>
        private static void TrayFittingParams(Document doc, CableTrayType t, JObject spec, JArray items, bool apply)
        {
            if (spec == null) { items.Add(TypeEditCore.Item("fitting_params", false, TypeEditCore.CodeBadValue, "fitting_params is {\"Type Properties name\": \"Family : Type\"}")); return; }
            foreach (var kv in spec)
            {
                string label = $"fitting_params.{kv.Key}";
                Parameter p = t.LookupParameter(kv.Key);
                if (p == null || p.StorageType != StorageType.ElementId) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeBadValue, $"{t.Name} has no fitting parameter {kv.Key}")); continue; }
                if (p.IsReadOnly) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeReadOnly, $"{kv.Key} is read-only")); continue; }
                FamilySymbol s = TrayFitting(doc, kv.Value?.ToString(), out string why);
                if (s == null) { items.Add(TypeEditCore.Item(label, false, TypeEditCore.CodeBadValue, why)); continue; }
                var row = TypeEditCore.Item(label, true);
                row["before"] = PartName(doc, p.AsElementId()) ?? "none"; row["after"] = $"{s.FamilyName} : {s.Name}";
                if (apply && !SetFittingParam(p, s)) { row["ok"] = false; row["reason"] = $"Revit refused {kv.Key}"; }
                items.Add(row);
            }
        }

        /// <summary>Writes one tray fitting role (a real run only: the caller checks apply).</summary>
        private static void SetTrayRole(CableTrayType t, string role, FamilySymbol s)
        {
            if (!s.IsActive) s.Activate();
            if (role == "elbow") t.Elbow = s; else if (role == "tee") t.Tee = s; else if (role == "cross") t.Cross = s;
            else if (role == "transition") t.Transition = s; else t.Union = s;
        }

        /// <summary>Writes one fitting parameter (a real run only: the caller checks apply).</summary>
        private static bool SetFittingParam(Parameter p, FamilySymbol s)
        {
            if (!s.IsActive) s.Activate();
            return p.Set(s.Id);
        }

        private static FamilySymbol TrayFitting(Document doc, string name, out string why)
        {
            why = null;
            var syms = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(BuiltInCategory.OST_CableTrayFitting).Cast<FamilySymbol>().ToList();
            FamilySymbol hit = long.TryParse(name, out long id) ? syms.FirstOrDefault(x => x.Id.Value == id)
                : syms.FirstOrDefault(x => string.Equals($"{x.FamilyName} : {x.Name}", name, StringComparison.OrdinalIgnoreCase));
            if (hit == null) why = $"{name} isn't a loaded cable tray fitting (\"Family : Type\")";
            return hit;
        }
    }
}
