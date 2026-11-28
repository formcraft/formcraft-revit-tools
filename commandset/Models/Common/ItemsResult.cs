using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Models.Common;

/// <summary>An AIResult with one row per requested item (ok, id, or code and reason), so no item is skipped silently.</summary>
public class ItemsResult<T> : AIResult<T>
{
    [JsonProperty("Items")]
    public JArray Items { get; set; } = new JArray();
}
