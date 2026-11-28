using System.Collections.Generic;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// A capped parameter reading of known element ids. This is not a model-wide parameter scan.
    /// </summary>
    public static class FmcModelDiff
    {
        public static JArray Read(Document doc, IEnumerable<long> ids, int cap)
        {
            var rows = new JArray();
            if (doc == null || ids == null || cap <= 0) return rows;
            int count = 0;
            foreach (long id in ids)
            {
                if (count >= cap) break;
                Element element;
                try { element = doc.GetElement(new ElementId(id)); }
                catch { continue; }
                if (element == null) continue;
                var parameters = new JArray();
                int taken = 0;
                try
                {
                    foreach (Parameter parameter in element.Parameters)
                    {
                        if (taken >= 12) break;
                        if (parameter?.Definition == null) continue;
                        string value = "";
                        try { value = parameter.AsValueString() ?? ""; }
                        catch { value = ""; }
                        parameters.Add(new JObject { ["name"] = parameter.Definition.Name, ["value"] = value });
                        taken++;
                    }
                }
                catch { /* one element does not fail the diff */ }
                rows.Add(new JObject { ["id"] = id, ["parameters"] = parameters });
                count++;
            }
            return rows;
        }
    }
}
