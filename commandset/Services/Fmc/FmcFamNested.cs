using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_fam_nested: nested families in a family document. read: instances, loaded families with types, host parameters.
    /// apply: swap (instances to another type, optionally loading its family first), associate (instance parameters to host
    /// parameters, the nested type to a &lt;Family Type&gt; parameter), reload (a nested family from its .rfa). Called inside
    /// FmcFamEditHandler's one transaction.
    /// </summary>
    public static class FmcFamNested
    {
        private static readonly BuiltInParameter[] TypeParams = { BuiltInParameter.ELEM_FAMILY_AND_TYPE_PARAM, BuiltInParameter.ELEM_TYPE_PARAM };

        private static List<FamilyInstance> Instances(Document doc) =>
            new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().ToList();

        private static bool Shared(Family f) => f?.get_Parameter(BuiltInParameter.FAMILY_SHARED)?.AsInteger() == 1;

        private static string TypeLabel(FamilyManager fm, FamilyInstance fi)
        {
            foreach (var bip in TypeParams)
            {
                Parameter p = fi.get_Parameter(bip);
                if (p == null) continue;
                try { string n = fm.GetAssociatedFamilyParameter(p)?.Definition.Name; if (n != null) return n; } catch (Exception) { /* not associable */ }
            }
            return null;
        }

        public static JObject Read(Document doc)
        {
            FamilyManager fm = doc.FamilyManager;
            var insts = Instances(doc);
            var nested = new JArray();
            foreach (FamilyInstance fi in insts)
            {
                var ps = new JArray();
                foreach (Parameter p in fi.Parameters)
                {
                    if (p.Definition == null) continue;
                    bool can = false;
                    try { can = fm.CanElementParameterBeAssociated(p); } catch (Exception) { /* not offered */ }
                    if (!can) continue;
                    ps.Add(new JObject
                    {
                        ["name"] = p.Definition.Name, ["spec"] = FmcFamEditHandler.Spec(p.Definition),
                        ["associated"] = fm.GetAssociatedFamilyParameter(p)?.Definition.Name, ["can_associate"] = true, ["read_only"] = p.IsReadOnly,
                    });
                }
                nested.Add(new JObject
                {
                    ["id"] = FmcFamEditHandler.IdOf(fi.Id), ["name"] = FmcDocGeometry.NameOf(fi), ["family"] = fi.Symbol?.Family?.Name, ["type"] = fi.Symbol?.Name,
                    ["category"] = fi.Category?.Name, ["shared"] = Shared(fi.Symbol?.Family), ["type_label"] = TypeLabel(fm, fi), ["parameters"] = ps,
                });
            }
            var families = new JArray();
            foreach (Family f in new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>())
            {
                families.Add(new JObject
                {
                    ["name"] = f.Name, ["id"] = FmcFamEditHandler.IdOf(f.Id), ["category"] = f.FamilyCategory?.Name, ["shared"] = Shared(f),
                    ["types"] = new JArray(f.GetFamilySymbolIds().Select(id => doc.GetElement(id)?.Name).Where(n => n != null).OrderBy(n => n)),
                    ["nested_count"] = insts.Count(i => i.Symbol?.Family?.Id == f.Id),
                });
            }
            return new JObject
            {
                ["family"] = doc.Title, ["category"] = doc.OwnerFamily?.FamilyCategory?.Name, ["nested"] = nested, ["families"] = families,
                ["host_parameters"] = FmcFamEditHandler.HostParameters(doc),
            };
        }

        public static JObject Apply(Document doc, JObject p)
        {
            string action = p.Value<string>("action");
            return action switch
            {
                "swap" => Swap(doc, p),
                "associate" => Associate(doc, p),
                "reload" => Reload(doc, p),
                _ => throw new InvalidOperationException($"Unknown nested action '{action}'"),
            };
        }

        private static List<string> TypesOf(Document doc, string family) =>
            new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .Where(s => string.Equals(s.Family?.Name, family, StringComparison.OrdinalIgnoreCase)).Select(s => s.Name).OrderBy(n => n).ToList();

        private static string Load(Document doc, string path, bool overwriteValues, out Family fam)
        {
            if (!System.IO.File.Exists(path)) throw new InvalidOperationException("No file " + path);
            bool loaded = doc.LoadFamily(path, new LoadOptions(overwriteValues), out fam);
            return loaded ? "loaded" : "Revit loaded nothing (the file matches what is loaded)";
        }

        private static JObject Swap(Document doc, JObject p)
        {
            string famName = p.Value<string>("to_family"), typeName = p.Value<string>("to_type"), path = p.Value<string>("load_path");
            string loadNote = "";
            if (!string.IsNullOrEmpty(path)) loadNote = Load(doc, path, false, out _);
            FamilySymbol symbol = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(s => string.Equals(s.Family?.Name, famName, StringComparison.OrdinalIgnoreCase) && string.Equals(s.Name, typeName, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"No type {famName} : {typeName} in the family" + (path != null ? $" after loading {path}" : ""));
            if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
            var rows = new JArray();
            foreach (long id in (p["ids"] as JArray ?? new JArray()).Select(t => t.Value<long>()))
            {
                if (!(doc.GetElement(FmcFamEditHandler.Id(id)) is FamilyInstance fi)) throw new InvalidOperationException($"No nested instance {id}");
                string before = $"{fi.Symbol?.Family?.Name} : {fi.Symbol?.Name}";
                if (fi.Symbol?.Id == symbol.Id) { rows.Add(new JObject { ["id"] = id, ["done"] = "unchanged", ["type"] = before }); continue; }
                if (fi.Category?.Id != symbol.Category?.Id) throw new InvalidOperationException($"{id} is {fi.Category?.Name}; {famName} is {symbol.Category?.Name}");
                fi.Symbol = symbol;
                rows.Add(new JObject { ["id"] = id, ["done"] = "swapped", ["from"] = before, ["to"] = $"{famName} : {typeName}" });
            }
            doc.Regenerate();
            return new JObject { ["action"] = "swap", ["load"] = string.IsNullOrEmpty(loadNote) ? null : loadNote, ["instances"] = rows };
        }

        private static JObject Associate(Document doc, JObject p)
        {
            FamilyManager fm = doc.FamilyManager;
            long id = p.Value<long?>("id") ?? -1;
            if (!(doc.GetElement(FmcFamEditHandler.Id(id)) is FamilyInstance fi)) throw new InvalidOperationException($"No nested instance {id}");
            var rows = new JArray();
            foreach (var kv in p["associate"] as JObject ?? new JObject())
            {
                Parameter np = fi.LookupParameter(kv.Key) ?? throw new InvalidOperationException($"The nested instance has no parameter {kv.Key}");
                if (kv.Value == null || kv.Value.Type == JTokenType.Null)
                {
                    fm.AssociateElementParameterToFamilyParameter(np, null);
                    rows.Add(new JObject { ["parameter"] = kv.Key, ["done"] = "association removed" });
                    continue;
                }
                FamilyParameter hp = fm.get_Parameter(kv.Value.ToString()) ?? throw new InvalidOperationException($"The family has no parameter {kv.Value}");
                if (fm.GetAssociatedFamilyParameter(np)?.Id == hp.Id) { rows.Add(new JObject { ["parameter"] = kv.Key, ["done"] = "unchanged" }); continue; }
                if (!fm.CanElementParameterBeAssociated(np)) throw new InvalidOperationException($"Revit can't associate {kv.Key}");
                fm.AssociateElementParameterToFamilyParameter(np, hp);
                rows.Add(new JObject { ["parameter"] = kv.Key, ["done"] = "associated", ["to"] = hp.Definition.Name });
            }
            JObject typeRow = null;
            if (p.ContainsKey("type_parameter")) typeRow = AssociateType(doc, fm, fi, p);
            return new JObject { ["action"] = "associate", ["id"] = id, ["parameters"] = rows, ["type_parameter"] = typeRow };
        }

        private static Parameter TypeParam(FamilyManager fm, FamilyInstance fi)
        {
            foreach (var bip in TypeParams)
            {
                Parameter tp = fi.get_Parameter(bip);
                if (tp != null && fm.CanElementParameterBeAssociated(tp)) return tp;
            }
            throw new InvalidOperationException("Revit doesn't offer this nested instance's type for association (is it a shared or a non-shared nested family of a category that can't be labelled?)");
        }

        private static JObject AssociateType(Document doc, FamilyManager fm, FamilyInstance fi, JObject p)
        {
            Parameter tp = TypeParam(fm, fi);
            JToken want = p["type_parameter"];
            if (want == null || want.Type == JTokenType.Null)
            {
                fm.AssociateElementParameterToFamilyParameter(tp, null);
                return new JObject { ["done"] = "association removed" };
            }
            string name = want.ToString();
            FamilyParameter hp = fm.get_Parameter(name);
            bool made = false;
            if (hp == null)
            {
                if (p.Value<bool?>("create_type_parameter") != true) throw new InvalidOperationException($"The family has no parameter {name}");
                hp = fm.AddParameter(name, GroupTypeId.General, fi.Category, p.Value<bool?>("is_instance") == true);
                made = true;
                // every type starts on the nested instance's current type, so nothing changes until a person picks another
                FamilyType current = fm.CurrentType;
                foreach (FamilyType ft in fm.Types) { fm.CurrentType = ft; fm.Set(hp, fi.Symbol.Id); }
                if (current != null) fm.CurrentType = current;
            }
            if (fm.GetAssociatedFamilyParameter(tp)?.Id == hp.Id) return new JObject { ["done"] = "unchanged", ["parameter"] = name };
            fm.AssociateElementParameterToFamilyParameter(tp, hp);
            return new JObject { ["done"] = made ? "created and associated" : "associated", ["parameter"] = name, ["category"] = fi.Category?.Name, ["is_instance"] = hp.IsInstance };
        }

        private static JObject Reload(Document doc, JObject p)
        {
            string family = p.Value<string>("family"), path = p.Value<string>("path");
            var before = TypesOf(doc, family);
            if (before.Count == 0 && !new FilteredElementCollector(doc).OfClass(typeof(Family)).Any(f => string.Equals(f.Name, family, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"{family} isn't loaded in this family");
            string note = Load(doc, path, p.Value<bool?>("overwrite_values") == true, out Family fam);
            if (fam != null && !string.Equals(fam.Name, family, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"The file loaded as {fam.Name}, not {family}: that is a second family, not a reload");
            doc.Regenerate();
            var after = TypesOf(doc, family);
            return new JObject
            {
                ["action"] = "reload", ["family"] = family, ["load"] = note, ["types_before"] = new JArray(before), ["types_after"] = new JArray(after),
                ["types_added"] = new JArray(after.Except(before)), ["types_removed"] = new JArray(before.Except(after)),
                ["overwrite_values"] = p.Value<bool?>("overwrite_values") == true,
            };
        }

        private sealed class LoadOptions : IFamilyLoadOptions
        {
            private readonly bool _values;
            public LoadOptions(bool overwriteValues) { _values = overwriteValues; }
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues) { overwriteParameterValues = _values; return true; }
            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            { source = FamilySource.Family; overwriteParameterValues = _values; return true; }
        }
    }
}
