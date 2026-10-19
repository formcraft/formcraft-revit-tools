using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The family's pictures (F-066, #189). A family built in the background has no active view, so Revit saved it with no
    /// preview at all. Before every save the builder makes sure of a 3D view "FMC Preview" at Fine detail, shaded with
    /// edges, with the drafting aids hidden (reference planes and lines, levels, dimensions, connector glyphs, and the
    /// Clearance and Coarse subcategories), and saves with it as the preview. A ceiling or face-based family is shown as
    /// it hangs. After the save the same view goes to <c>&lt;folder&gt;\_Images\&lt;family&gt;_3d.png</c> (1024 px), so
    /// the tester, Claude Code, the catalogue and the store can see the built family.
    /// </summary>
    public static class FmcPreview
    {
        public const string ViewName = "FMC Preview";

        /// <summary>Drafting aids no picture should show (FmcDocInspect's screenshots hide the same).</summary>
        internal static readonly BuiltInCategory[] Clutter =
        {
            BuiltInCategory.OST_CLines, BuiltInCategory.OST_Levels, BuiltInCategory.OST_Dimensions, BuiltInCategory.OST_ReferenceLines,
            BuiltInCategory.OST_SectionBox, BuiltInCategory.OST_GenericAnnotation, BuiltInCategory.OST_ConnectorElem,
        };

        /// <summary>Hides the drafting aids and the family's Clearance and Coarse subcategories in a view. Never throws.</summary>
        internal static void HideClutter(Document doc, View v)
        {
            foreach (BuiltInCategory bic in Clutter)
            {
                try
                {
                    Category cat = Category.GetCategory(doc, bic);
                    if (cat != null && v.CanCategoryBeHidden(cat.Id)) v.SetCategoryHidden(cat.Id, true);
                }
                catch (Exception) { /* a category this family doesn't have */ }
            }
            // connectors (the green circle on an electrical one): the category often can't be hidden in a family's view,
            // so the connector elements themselves are hidden in this view
            try
            {
                var connectors = new FilteredElementCollector(doc).OfClass(typeof(ConnectorElement)).ToElements()
                    .Where(e => e.CanBeHidden(v)).Select(e => e.Id).ToList();
                if (connectors.Count > 0) v.HideElements(connectors);
            }
            catch (Exception) { /* kept visible */ }
            Category own = doc.IsFamilyDocument ? doc.OwnerFamily?.FamilyCategory : null;
            if (own == null) return;
            foreach (Category sub in own.SubCategories)
            {
                if (!(sub.Name.StartsWith("Clearance", StringComparison.OrdinalIgnoreCase) || sub.Name.StartsWith("Coarse", StringComparison.OrdinalIgnoreCase))) continue;
                try { if (v.CanCategoryBeHidden(sub.Id)) v.SetCategoryHidden(sub.Id, true); } catch (Exception) { /* kept visible */ }
            }
        }

        /// <summary>The preview view's id, made or refreshed in its own transaction; invalid outside a family. Never throws.</summary>
        public static ElementId Ensure(Document doc, string savingAs = "")
        {
            if (doc == null || !doc.IsFamilyDocument || doc.IsReadOnly) return ElementId.InvalidElementId;
            try
            {
                using (var t = new Transaction(doc, "FMC preview view"))
                {
                    t.Start();
                    View3D v = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(x => !x.IsTemplate && x.Name == ViewName);
                    if (v == null)
                    {
                        ViewFamilyType vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                            .FirstOrDefault(x => x.ViewFamily == ViewFamily.ThreeDimensional);
                        if (vft == null) { t.RollBack(); return ElementId.InvalidElementId; }
                        v = View3D.CreateIsometric(doc, vft.Id);
                        v.Name = ViewName;
                    }
                    v.DetailLevel = ViewDetailLevel.Fine;
                    v.DisplayStyle = DisplayStyle.ShadingWithEdges;
                    HideClutter(doc, v);
                    if (HangsDown(doc, savingAs))
                    {
                        // seen from below as it hangs: looking along (-1, 1, -1) in family coordinates with the family's -z as up
                        XYZ forward = new XYZ(-1, 1, -1).Normalize();
                        XYZ up = (XYZ.BasisZ.Negate() - forward.Multiply(XYZ.BasisZ.Negate().DotProduct(forward))).Normalize();
                        v.SetOrientation(new ViewOrientation3D(forward.Negate().Multiply(100), up, forward));
                    }
                    t.Commit();
                    return v.Id;
                }
            }
            catch (Exception)
            {
                // a family that can't have the view still saves, as before
                return ElementId.InvalidElementId;
            }
        }

        /// <summary>SaveAs options with the preview set when there is one.</summary>
        public static SaveAsOptions Options(Document doc, bool overwrite, int backups, string savingAs = "")
        {
            var o = new SaveAsOptions { OverwriteExistingFile = overwrite, MaximumBackups = backups };
            ElementId id = Ensure(doc, savingAs);
            if (id != ElementId.InvalidElementId) o.PreviewViewId = id;
            return o;
        }

        /// <summary>
        /// After a save: the preview view as <c>&lt;folder of the .rfa&gt;\_Images\&lt;family&gt;_3d.png</c>, 1024 px. Answers
        /// the file, or an empty string and the reason in <paramref name="why"/>. Never throws: a picture never fails a build.
        /// </summary>
        public static string ExportPng(Document doc, string savedRfa, out string why)
        {
            why = "";
            try
            {
                View3D v = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(x => !x.IsTemplate && x.Name == ViewName);
                if (v == null) { why = "no FMC Preview view"; return ""; }
                string folder = Path.Combine(Path.GetDirectoryName(savedRfa) ?? "", "_Images");
                Directory.CreateDirectory(folder);
                string family = Path.GetFileNameWithoutExtension(savedRfa);
                string final = Path.Combine(folder, family + "_3d.png");
                string stem = Path.Combine(folder, "_tmp_" + family + "_" + DateTime.Now.ToString("HHmmssfff"));
                var options = new ImageExportOptions
                {
                    ExportRange = ExportRange.SetOfViews, FilePath = stem, HLRandWFViewsFileType = ImageFileType.PNG,
                    ShadowViewsFileType = ImageFileType.PNG, ImageResolution = ImageResolution.DPI_150, ZoomType = ZoomFitType.FitToPage,
                    PixelSize = 1024, FitDirection = FitDirectionType.Horizontal,
                };
                options.SetViewsAndSheets(new List<ElementId> { v.Id });
                doc.ExportImage(options);
                string made = Directory.GetFiles(folder, Path.GetFileName(stem) + "*.png").FirstOrDefault();
                if (made == null) { why = "Revit wrote no image"; return ""; }
                if (File.Exists(final)) File.Delete(final);
                File.Move(made, final);
                return final;
            }
            catch (Exception e)
            {
                why = e.Message;
                return "";
            }
        }

        /// <summary>Hosted on a ceiling, or face based with "Ceiling" in its name (the family carries no hosting value then).</summary>
        static bool HangsDown(Document doc, string savingAs)
        {
            Parameter host = doc.OwnerFamily?.get_Parameter(BuiltInParameter.FAMILY_HOSTING_BEHAVIOR);
            if (host != null && host.StorageType == StorageType.Integer && host.AsInteger() == 3) return true;   // ceiling
            string t = doc.OwnerFamily?.FamilyPlacementType.ToString() ?? "";
            string name = (savingAs ?? "") + " " + doc.Title;
            return t == nameof(FamilyPlacementType.WorkPlaneBased) && name.IndexOf("Ceiling", StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }
}
