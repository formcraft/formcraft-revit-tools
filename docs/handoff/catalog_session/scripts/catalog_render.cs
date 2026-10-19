// Catalogue card images: each family on its own, white background, realistic, no edges, Fine, closed, no host wall.
// parameters[0] = the family file; parameters[1] = the output PNG path. The family file is opened in the background,
// rendered in a temporary 3D view and closed without saving, so the staged family is never changed.
var app = document.Application;
string path = parameters[0].ToString(), png = parameters[1].ToString();
Document fam = app.OpenDocumentFile(path);
string result;
try
{
    ElementId viewId;
    using (var t = new Transaction(fam, "FMC catalogue view"))
    {
        t.Start();
        // closed: every YesNo family parameter named Open goes to 0 in the current type
        FamilyManager fm = fam.FamilyManager;
        if (fm.CurrentType == null && fm.Types.Size > 0) fm.CurrentType = fm.Types.Cast<FamilyType>().First();
        foreach (FamilyParameter fp in fm.Parameters)
            if (fp.Definition.Name == "Open" && fp.StorageType == StorageType.Integer && fp.Formula == null && fm.CurrentType != null) fm.Set(fp, 0);
        ViewFamilyType vft = new FilteredElementCollector(fam).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.ThreeDimensional);
        View3D v = View3D.CreateIsometric(fam, vft.Id);
        v.DetailLevel = ViewDetailLevel.Fine;
        v.DisplayStyle = DisplayStyle.Realistic;
        ViewDisplayModel dm = v.GetViewDisplayModel();
        dm.SmoothEdges = true;
        dm.EnableSilhouettes = false;
        v.SetViewDisplayModel(dm);
        v.SetBackground(ViewDisplayBackground.CreateGradient(new Color(255, 255, 255), new Color(244, 245, 247), new Color(232, 234, 238)));
        // the family alone: no host wall, no aids
        foreach (BuiltInCategory bic in new[] { BuiltInCategory.OST_Walls, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Ceilings, BuiltInCategory.OST_Roofs,
            BuiltInCategory.OST_CLines, BuiltInCategory.OST_Levels, BuiltInCategory.OST_Dimensions, BuiltInCategory.OST_ReferenceLines,
            BuiltInCategory.OST_SectionBox, BuiltInCategory.OST_GenericAnnotation, BuiltInCategory.OST_ConnectorElem, BuiltInCategory.OST_LightingFixtureSource })
        {
            try { Category c = Category.GetCategory(fam, bic); if (c != null && v.CanCategoryBeHidden(c.Id)) v.SetCategoryHidden(c.Id, true); } catch (Exception) { }
        }
        Category own = fam.OwnerFamily.FamilyCategory;
        foreach (Category sub in own.SubCategories)
            if (sub.Name.StartsWith("Clearance", StringComparison.OrdinalIgnoreCase) || sub.Name.StartsWith("Coarse", StringComparison.OrdinalIgnoreCase)
                || sub.Name.IndexOf("Light Path", StringComparison.OrdinalIgnoreCase) >= 0 || sub.Name.IndexOf("Envelope", StringComparison.OrdinalIgnoreCase) >= 0)
                try { if (v.CanCategoryBeHidden(sub.Id)) v.SetCategoryHidden(sub.Id, true); } catch (Exception) { }
        var hide = new FilteredElementCollector(fam).OfClass(typeof(ConnectorElement)).ToElements()
            .Concat(new FilteredElementCollector(fam).OfClass(typeof(Wall)).ToElements())
            .Where(e => e.CanBeHidden(v)).Select(e => e.Id).ToList();
        if (hide.Count > 0) v.HideElements(hide);
        viewId = v.Id;
        t.Commit();
    }
    var opts = new ImageExportOptions
    {
        ExportRange = ExportRange.SetOfViews, FilePath = png, ZoomType = ZoomFitType.FitToPage, PixelSize = 1600,
        ImageResolution = ImageResolution.DPI_300, HLRandWFViewsFileType = ImageFileType.PNG, ShadowViewsFileType = ImageFileType.PNG,
        FitDirection = FitDirectionType.Horizontal,
    };
    opts.SetViewsAndSheets(new List<ElementId> { viewId });
    fam.ExportImage(opts);
    result = "rendered " + System.IO.Path.GetFileName(path);
}
finally { fam.Close(false); }
return result;
