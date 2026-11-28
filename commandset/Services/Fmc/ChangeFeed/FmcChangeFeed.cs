using Autodesk.Revit.DB;

namespace RevitMCPCommandSet.Services.Fmc.ChangeFeed
{
    /// <summary>
    /// Helpers shared with fmc_change_feed_read. The live hook lives in the plugin
    /// (revit_mcp_plugin.Fmc.ChangeFeedSession), started from OnStartup, not from the first Formcraft call.
    /// The add-in command reads the lasting JSONL log; it does not subscribe to Revit events itself
    /// (so a line is never written twice).
    /// </summary>
    public static class FmcChangeFeed
    {
        public static string Key(Document d)
        {
            if (d == null) return "";
            return string.IsNullOrEmpty(d.PathName) ? (d.Title ?? "") : d.PathName;
        }
    }
}
