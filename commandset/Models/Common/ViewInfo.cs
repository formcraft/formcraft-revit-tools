namespace RevitMCPCommandSet.Models.Common
{
    public class CurrentViewInfo
    {
        public long Id { get; set; }
        public string UniqueId { get; set; }
        public string Name { get; set; }
        public string ViewType { get; set; }
        public bool IsTemplate { get; set; }
        public int Scale { get; set; }
        public string DetailLevel { get; set; }
    }

    /// <summary>VI-4: the extra properties returned when verbose is true. Null means "not applicable to this view".</summary>
    public class CurrentViewInfoVerbose : CurrentViewInfo
    {
        public bool Verbose { get; set; } = true;
        public string Title { get; set; }
        public bool? CropBoxActive { get; set; }
        public bool? CropBoxVisible { get; set; }
        public long? ViewTemplateId { get; set; }
        public string ViewTemplateName { get; set; }
        public long? PhaseId { get; set; }
        public string PhaseName { get; set; }
        public string PhaseFilter { get; set; }
        public string Discipline { get; set; }
        public long? GenLevelId { get; set; }
        public string GenLevelName { get; set; }
        public string DisplayStyle { get; set; }
        public List<ViewFilterRef> Filters { get; set; }
    }

    public class ViewFilterRef
    {
        public long Id { get; set; }
        public string Name { get; set; }
        public bool? Visible { get; set; }
        public bool? Enabled { get; set; }
    }
}
