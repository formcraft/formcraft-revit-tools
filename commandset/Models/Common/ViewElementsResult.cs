namespace RevitMCPCommandSet.Models.Common
{
    public class ViewElementsResult
    {
        public long ViewId { get; set; }
        public string ViewName { get; set; }
        public int TotalElementsInView { get; set; }
        public int FilteredElementCount { get; set; }
        /// <summary>The BuiltInCategory names the filter used; null when no category filter was asked for (VE-4).</summary>
        public List<string> CategoriesApplied { get; set; }
        public List<ElementInfo> Elements { get; set; } = new List<ElementInfo>();
    }
}
