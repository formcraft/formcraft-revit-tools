using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Shared by fmc_match and fmc_params: parameter keys, values, guards and the quiet failure handler.</summary>
    internal static class FmcParamCommon
    {
        // Never copied by fmc_match: identity, placement, phasing and workset parameters.
        private static readonly HashSet<string> NeverCopied = new HashSet<string>(StringComparer.Ordinal)
        {
            "ELEM_PARTITION_PARAM", "PHASE_CREATED", "PHASE_DEMOLISHED", "FAMILY_LEVEL_PARAM", "SCHEDULE_LEVEL_PARAM",
            "ALL_MODEL_MARK", "DESIGN_OPTION_PARAM", "ELEM_FAMILY_AND_TYPE_PARAM", "ELEM_FAMILY_PARAM", "ELEM_TYPE_PARAM",
            "HOST_ID_PARAM", "EDITED_BY", "IFC_GUID",
        };

        public static string KeyOf(Parameter p)
        {
            if (p.IsShared) return "guid:" + p.GUID.ToString();
            if (p.Definition is InternalDefinition d && d.BuiltInParameter != BuiltInParameter.INVALID) return "bip:" + ((int)d.BuiltInParameter).ToString();
            return "name:" + p.Definition.Name;
        }

        public static bool NeverCopy(Parameter p)
        {
            return p.Definition is InternalDefinition d && NeverCopied.Contains(d.BuiltInParameter.ToString());
        }

        public static Parameter Find(Element e, string key)
        {
            if (key.StartsWith("guid:", StringComparison.Ordinal))
            {
                Guid g;
                return Guid.TryParse(key.Substring(5), out g) ? e.get_Parameter(g) : null;
            }
            if (key.StartsWith("bip:", StringComparison.Ordinal))
            {
                int n;
                return int.TryParse(key.Substring(4), out n) ? e.get_Parameter((BuiltInParameter)n) : null;
            }
            return e.LookupParameter(key.StartsWith("name:", StringComparison.Ordinal) ? key.Substring(5) : key);
        }

        public static JObject Cell(Parameter p)
        {
            var o = new JObject { ["key"] = KeyOf(p), ["name"] = p.Definition.Name, ["storage"] = p.StorageType.ToString(), ["readonly"] = p.IsReadOnly };
            switch (p.StorageType)
            {
                case StorageType.Double: o["value"] = p.AsDouble(); o["display"] = Safe(p); break;
                case StorageType.Integer: o["value"] = p.AsInteger(); o["display"] = Safe(p); break;
                case StorageType.String: o["value"] = p.AsString() ?? ""; o["display"] = p.AsString() ?? ""; break;
                case StorageType.ElementId: o["value"] = p.AsElementId().Value.ToString(); o["display"] = Safe(p); break;
                default: o["value"] = null; break;
            }
            return o;
        }

        private static string Safe(Parameter p)
        {
            try { return p.AsValueString() ?? ""; } catch (Exception) { return ""; }
        }

        /// <summary>An element-id parameter is copied only when it is empty or points at a material.</summary>
        public static bool ElementIdCopyable(Document doc, Parameter p)
        {
            ElementId id = p.AsElementId();
            return id == null || id == ElementId.InvalidElementId || doc.GetElement(id) is Material;
        }

        public static void SetValue(Parameter p, string storage, JToken to, string mode)
        {
            if (p == null) throw new InvalidOperationException("[FMC-PARAM-GONE] The parameter is not on the element any more.");
            if (p.IsReadOnly) throw new InvalidOperationException("[FMC-PARAM-READONLY] \"" + p.Definition.Name + "\" is read-only.");
            if (!string.Equals(p.StorageType.ToString(), storage, StringComparison.Ordinal))
                throw new InvalidOperationException("[FMC-PARAM-STORAGE] \"" + p.Definition.Name + "\" is " + p.StorageType + ", the plan says " + storage + ".");
            bool ok;
            switch (p.StorageType)
            {
                case StorageType.String: ok = p.Set(to == null || to.Type == JTokenType.Null ? "" : to.ToString()); break;
                case StorageType.Integer: ok = p.Set(to.ToObject<int>()); break;
                case StorageType.Double:
                    ok = mode == "display" ? p.SetValueString(to.ToString()) : p.Set(to.ToObject<double>());
                    break;
                case StorageType.ElementId: ok = p.Set(new ElementId(long.Parse(to.ToString()))); break;
                default: throw new InvalidOperationException("[FMC-PARAM-STORAGE] \"" + p.Definition.Name + "\" has no value type that can be set.");
            }
            if (!ok) throw new InvalidOperationException("[FMC-PARAM-SET] Revit did not accept the value for \"" + p.Definition.Name + "\".");
        }

        public static string CategoryOf(Element e)
        {
            Category c = e?.Category;
            if (c == null) return "";
            long v = c.Id.Value;
            return v < 0 && v >= int.MinValue && Enum.IsDefined(typeof(BuiltInCategory), (int)v) ? ((BuiltInCategory)(int)v).ToString() : c.Name;
        }

        /// <summary>false when another user owns the element in a workshared model. Nothing is requested.</summary>
        public static bool Editable(Document doc, Element e, out string owner)
        {
            owner = "";
            if (!doc.IsWorkshared) return true;
            string who;
            CheckoutStatus status = WorksharingUtils.GetCheckoutStatus(doc, e.Id, out who);
            if (status == CheckoutStatus.OwnedByOtherUser) { owner = who ?? ""; return false; }
            return true;
        }

        public static Element Get(Document doc, string id)
        {
            long n;
            return long.TryParse(id, out n) ? doc.GetElement(new ElementId(n)) : null;
        }

        public static void Refuse(Document doc, string tool)
        {
            if (doc.IsFamilyDocument)
                throw new InvalidOperationException("[FMC-FAMILY-PROJECT] " + tool + " works on a project. This document is a family file.");
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (System.Text.RegularExpressions.Regex.IsMatch(blob, "hebert hostels", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by " + tool + ".");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by " + tool + ".");
        }

        public static string Col(Color c)
        {
            return c == null || !c.IsValid ? "" : c.Red + "," + c.Green + "," + c.Blue;
        }

        /// <summary>Every public simple property of the override settings, by reflection, as a flat object for a diff.</summary>
        public static JObject OverrideSummary(OverrideGraphicSettings o)
        {
            var result = new JObject();
            foreach (System.Reflection.PropertyInfo pi in typeof(OverrideGraphicSettings).GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                if (pi.GetIndexParameters().Length > 0) continue;
                object v;
                try { v = pi.GetValue(o); } catch (Exception) { continue; }
                string name = System.Text.RegularExpressions.Regex.Replace(pi.Name, "(?<!^)([A-Z])", "_$1").ToLowerInvariant();
                if (v is Color c) result[name] = Col(c);
                else if (v is ElementId id) result[name] = id.Value;
                else if (v is int i) result[name] = i;
                else if (v is bool b) result[name] = b;
                else if (v is double d) result[name] = d;
                else if (v is string s) result[name] = s;
                else if (v != null && v.GetType().IsEnum) result[name] = v.ToString();
            }
            return result;
        }

        public sealed class Quiet : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (FailureMessageAccessor message in accessor.GetFailureMessages())
                    if (message.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(message);
                return FailureProcessingResult.Continue;
            }
        }

        public static Transaction Begin(Document doc, string name)
        {
            var t = new Transaction(doc, name);
            FailureHandlingOptions options = t.GetFailureHandlingOptions();
            options.SetFailuresPreprocessor(new Quiet());
            options.SetClearAfterRollback(true);
            t.SetFailureHandlingOptions(options);
            t.Start();
            return t;
        }
    }
}
