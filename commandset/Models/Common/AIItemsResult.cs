using Newtonsoft.Json;

namespace RevitMCPCommandSet.Models.Common;

/// <summary>
/// An AIResult with one row per input (FmcPlacementCore.Item: index, status created|reused|failed, id, code, reason).
/// The server (server/src/fmc/datum.ts mergeResults) treats an input with no row as unknown, never as created.
/// </summary>
public class AIItemsResult<T> : AIResult<T>
{
    [JsonProperty("Items")]
    public List<Dictionary<string, object>> Items { get; set; } = new List<Dictionary<string, object>>();
}
