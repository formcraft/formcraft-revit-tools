using System;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The family's preview (the picture in Load Family, the Project Browser and the catalogue). A family built in the
    /// background has no active view, so Revit saved it with no picture at all. Before every save the builder makes sure
    /// of a 3D view "FMC Preview" at Fine detail, shaded with edges, and saves with it as the preview. A family hosted on a
    /// ceiling or a face is shown the way it hangs (its own up turned down), so an operating light reads as a light.
    /// </summary>
    public static class FmcPreview
    {
        public const string ViewName = "FMC Preview";

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

        /// <summary>Hosted on a ceiling, or face based (the template's own words when the family carries no hosting value).</summary>
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
