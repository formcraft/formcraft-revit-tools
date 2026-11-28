using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>One parameter on an element, as a string the log and the pane can show (old or new).</summary>
    public sealed class ParamValue
    {
        public string Name = "";
        public string Value = "";
    }

    /// <summary>One parameter that changed: the value before the edit and the value after it.</summary>
    public sealed class ParamChange
    {
        public string Name = "";
        public string Before;
        public string After;

        public JObject ToJson()
        {
            var o = new JObject { ["name"] = Name };
            if (Before != null) o["before"] = Before;
            if (After != null) o["after"] = After;
            return o;
        }

        public static ParamChange FromJson(JObject o)
        {
            if (o == null) return null;
            return new ParamChange
            {
                Name = (string)o["name"] ?? "",
                Before = o["before"] == null || o["before"].Type == JTokenType.Null ? null : (string)o["before"],
                After = o["after"] == null || o["after"].Type == JTokenType.Null ? null : (string)o["after"],
            };
        }
    }

    /// <summary>What happened to one element in a transaction: created, modified or deleted, with key-param diffs.</summary>
    public sealed class ElementChange
    {
        public long Id;
        public string Action = ""; // created, modified, deleted
        public string Category = "";
        public string Name = "";
        public string UniqueId = "";
        public List<ParamChange> Params = new List<ParamChange>();
        public bool ParamsTruncated;
        public string TruncateReason = "";

        public JObject ToJson()
        {
            var o = new JObject
            {
                ["id"] = Id,
                ["action"] = Action,
                ["category"] = Category,
                ["name"] = Name,
                ["unique_id"] = UniqueId,
                ["params"] = new JArray(Params.ConvertAll(p => p.ToJson())),
            };
            if (ParamsTruncated) { o["params_truncated"] = true; o["truncate_reason"] = TruncateReason ?? ""; }
            return o;
        }

        public static ElementChange FromJson(JObject o)
        {
            if (o == null) return null;
            var e = new ElementChange
            {
                Id = o["id"] != null ? (long)o["id"] : 0,
                Action = (string)o["action"] ?? "",
                Category = (string)o["category"] ?? "",
                Name = (string)o["name"] ?? "",
                UniqueId = (string)o["unique_id"] ?? "",
                ParamsTruncated = o["params_truncated"] != null && (bool)o["params_truncated"],
                TruncateReason = (string)o["truncate_reason"] ?? "",
            };
            var arr = o["params"] as JArray;
            if (arr != null)
                foreach (JToken t in arr)
                {
                    var p = ParamChange.FromJson(t as JObject);
                    if (p != null) e.Params.Add(p);
                }
            return e;
        }
    }

    /// <summary>
    /// Key-parameter snapshots and diffs for the change feed (F19 / F133). Pure: no Revit types, so it is tested offline.
    /// Caps keep a busy document from filling the log: a reason is always given when something is dropped.
    /// </summary>
    public static class ChangeFeedParams
    {
        public const int DefaultMaxParams = 20;
        public const int DefaultMaxElements = 40;
        public const int DefaultMaxBytes = 8192;

        /// <summary>Names we always try to keep, plus any FMC_ shared parameter. Unknown parameters are left out on purpose.</summary>
        public static readonly string[] KeyNames =
        {
            "Name", "Mark", "Type", "Type Name", "Family", "Level", "Base Level", "Top Level", "Reference Level",
            "Comments", "Type Comments", "Description", "Keynote", "Phase Created", "Phase Demolished",
            "Head Height", "Width", "Height", "Length", "Area", "Volume",
            "Base Offset", "Top Offset", "Unconnected Height", "Offset", "Elevation", "Radius", "Thickness",
        };

        public static bool IsKeyName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            if (name.StartsWith("FMC_", StringComparison.OrdinalIgnoreCase)) return true;
            foreach (string k in KeyNames)
                if (string.Equals(k, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>old vs new: parameters that appeared, disappeared or changed. Names not in either side are ignored.</summary>
        public static List<ParamChange> Diff(IList<ParamValue> before, IList<ParamValue> after)
        {
            var oldMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var newMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (before != null) foreach (var p in before) if (p != null && !string.IsNullOrEmpty(p.Name) && !oldMap.ContainsKey(p.Name)) oldMap[p.Name] = p.Value ?? "";
            if (after != null) foreach (var p in after) if (p != null && !string.IsNullOrEmpty(p.Name) && !newMap.ContainsKey(p.Name)) newMap[p.Name] = p.Value ?? "";
            var names = new List<string>();
            foreach (var n in oldMap.Keys) if (!names.Contains(n)) names.Add(n);
            foreach (var n in newMap.Keys) if (!names.Contains(n)) names.Add(n);
            names.Sort(StringComparer.OrdinalIgnoreCase);
            var outList = new List<ParamChange>();
            foreach (string n in names)
            {
                bool hasOld = oldMap.TryGetValue(n, out string ov);
                bool hasNew = newMap.TryGetValue(n, out string nv);
                if (hasOld && hasNew && (ov ?? "") == (nv ?? "")) continue;
                outList.Add(new ParamChange { Name = n, Before = hasOld ? ov : null, After = hasNew ? nv : null });
            }
            return outList;
        }

        /// <summary>Keeps at most maxParams, and drops from the end so the JSON of the list stays under maxBytes. Sets the reason when it drops any.</summary>
        public static List<ParamChange> Cap(IList<ParamChange> changes, int maxParams, int maxBytes, out bool truncated, out string reason)
        {
            truncated = false;
            reason = "";
            var list = new List<ParamChange>();
            if (changes == null) return list;
            int cap = Math.Max(0, maxParams);
            foreach (var p in changes)
            {
                if (list.Count >= cap) { truncated = true; reason = "More than " + cap + " key parameters changed; later ones were not recorded."; break; }
                list.Add(p);
            }
            while (list.Count > 0 && JsonBytes(list) > Math.Max(64, maxBytes))
            {
                list.RemoveAt(list.Count - 1);
                truncated = true;
                reason = "The parameter list was cut to stay under " + maxBytes + " bytes.";
            }
            return list;
        }

        /// <summary>Keeps at most maxElements, then drops from the end to stay under maxBytes for the whole entry's element list.</summary>
        public static List<ElementChange> CapElements(IList<ElementChange> elements, int maxElements, int maxBytes, out bool truncated, out string reason)
        {
            truncated = false;
            reason = "";
            var list = new List<ElementChange>();
            if (elements == null) return list;
            int cap = Math.Max(0, maxElements);
            foreach (var e in elements)
            {
                if (list.Count >= cap) { truncated = true; reason = "More than " + cap + " elements changed in this transaction; later ones were not recorded in detail."; break; }
                list.Add(e);
            }
            while (list.Count > 0 && JsonBytes(list) > Math.Max(128, maxBytes))
            {
                list.RemoveAt(list.Count - 1);
                truncated = true;
                reason = "The element list was cut to stay under " + maxBytes + " bytes.";
            }
            return list;
        }

        public static int JsonBytes(object value) => Encoding.UTF8.GetByteCount(JToken.FromObject(value).ToString(Newtonsoft.Json.Formatting.None));

        public static List<ParamValue> SnapshotOf(IEnumerable<ParamValue> values, int maxParams)
        {
            var list = new List<ParamValue>();
            if (values == null) return list;
            foreach (var p in values)
            {
                if (p == null || string.IsNullOrEmpty(p.Name) || !IsKeyName(p.Name)) continue;
                if (list.Count >= Math.Max(0, maxParams)) break;
                if (list.Exists(x => string.Equals(x.Name, p.Name, StringComparison.OrdinalIgnoreCase))) continue;
                list.Add(new ParamValue { Name = p.Name, Value = p.Value ?? "" });
            }
            return list;
        }
    }
}
