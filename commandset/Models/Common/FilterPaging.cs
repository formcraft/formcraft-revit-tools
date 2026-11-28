using System.Collections.Generic;
using Autodesk.Revit.DB;
using Newtonsoft.Json;

namespace RevitMCPCommandSet.Models.Common
{
    /// <summary>
    /// ai_element_filter's answer (tool research 1-25): the page, how it sits in the whole match, and every element that
    /// could not be read. The server turns paging into the opaque cursor of FILTER_TOOL_SPEC 5.6.
    /// </summary>
    public class AIFilterResult : AIResult<List<object>>
    {
        [JsonProperty("paging")] public FilterPaging Paging { get; set; }
        [JsonProperty("skipped")] public List<FilterSkip> Skipped { get; set; } = new List<FilterSkip>();
    }

    public class FilterPaging
    {
        [JsonProperty("total")] public int Total { get; set; }
        [JsonProperty("from")] public int From { get; set; }
        [JsonProperty("to")] public int To { get; set; }
        [JsonProperty("remaining")] public int Remaining { get; set; }
        /// <summary>The last element id on this page: the next page starts after it.</summary>
        [JsonProperty("last_id")] public long LastId { get; set; }
        [JsonProperty("order")] public string Order { get; set; } = "element_id";
        /// <summary>DocumentVersion.VersionGUID when the page was read. It moves when elements are created.</summary>
        [JsonProperty("document_version")] public string DocumentVersion { get; set; } = "";
        /// <summary>Every id on this page, including the ones in skipped.</summary>
        [JsonProperty("ids")] public List<long> Ids { get; set; } = new List<long>();
    }

    public class FilterSkip
    {
        [JsonProperty("id")] public long Id { get; set; }
        [JsonProperty("reason")] public string Reason { get; set; }
        [JsonProperty("detail")] public string Detail { get; set; }
        [JsonProperty("category")] public string Category { get; set; }
        [JsonProperty("kind")] public string Kind { get; set; }

        public static FilterSkip Of(Element element, string reason, string detail)
        {
            string category = "";
            try { category = element?.Category?.Name ?? ""; } catch (System.Exception) { category = ""; }
            return new FilterSkip
            {
                Id = element?.Id?.Value ?? -1,
                Reason = reason,
                Detail = detail ?? "",
                Category = category,
                Kind = element is ElementType ? "type" : "instance",
            };
        }
    }
}
