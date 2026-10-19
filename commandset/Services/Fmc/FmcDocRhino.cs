using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc import_part (the hub, H3 in docs/handoff/DETAILED_FAMILIES_RHINO.md): a part made in Rhino (fmc_rhino
    /// export_parts, one closed solid per .3dm under a _Rhino staging folder) becomes a form in the open family. Revit
    /// reads the .3dm itself (ShapeImporter, which keeps the file's millimetres) and the solid becomes a FreeFormElement,
    /// labelled like every other solid, so set_subcategory, set_material_param, set_visibility and set_visible_param
    /// apply to it by name. The part keeps the place it was modelled at: the recipe's own coordinates.
    /// </summary>
    public static class FmcDocRhino
    {
        private static double ToMm(double ft) => UnitUtils.ConvertFromInternalUnits(ft, UnitTypeId.Millimeters);

        public static (string, string) ImportPart(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            if (!doc.IsFamilyDocument) throw new InvalidOperationException("import_part works in a family");
            if (FmcDocGeometry.Solid(doc, name) != null) return ("skip", "exists (delete it, or rename, to import again)");
            string file = op.Value<string>("file") ?? throw new InvalidOperationException("file is required (a .3dm from fmc_rhino export_parts)");
            string full = Path.GetFullPath(file);
            if (full.IndexOf(@"\_Rhino\", StringComparison.OrdinalIgnoreCase) < 0 || !full.EndsWith(".3dm", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("import_part reads only .3dm parts under a _Rhino staging folder, not " + full);
            if (!File.Exists(full)) throw new InvalidOperationException("No part file at " + full + " (fmc_rhino export_parts first)");

            var importer = new ShapeImporter { InputFormat = ShapeImporterSourceFormat.Rhino };
            IList<GeometryObject> shapes = importer.Convert(doc, full);
            var solids = (shapes ?? new List<GeometryObject>()).OfType<Solid>().Where(s => s.Volume > 1e-9).ToList();
            if (solids.Count == 0)
            {
                string got = shapes == null || shapes.Count == 0 ? "nothing" : string.Join(", ", shapes.Select(s => s.GetType().Name).Distinct());
                throw new InvalidOperationException("Revit read " + got + " from " + Path.GetFileName(full) + ", no closed solid (fmc_rhino check shows why)");
            }
            Solid solid = solids[0];
            for (int i = 1; i < solids.Count; i++)
                solid = BooleanOperationsUtils.ExecuteBooleanOperation(solid, solids[i], BooleanOperationsType.Union);

            // the size Rhino reported (fmc_rhino facts): a part that arrives at another size came in the wrong units
            string sizeNote = "";
            if (op["size_mm"] is JArray want && want.Count == 3)
            {
                BoundingBoxXYZ bb = solid.GetBoundingBox();
                XYZ d = bb.Max - bb.Min;
                double[] got = { ToMm(d.X), ToMm(d.Y), ToMm(d.Z) };
                for (int k = 0; k < 3; k++)
                {
                    double w = want[k].Value<double>();
                    if (w > 1 && Math.Abs(got[k] - w) > Math.Max(1.0, 0.02 * w))
                        throw new InvalidOperationException($"{name} arrived {Math.Round(got[0])} × {Math.Round(got[1])} × {Math.Round(got[2])} mm, Rhino made it "
                            + $"{want[0]} × {want[1]} × {want[2]} mm: the file's units were not read as millimetres");
                }
                sizeNote = $", {Math.Round(got[0])} × {Math.Round(got[1])} × {Math.Round(got[2])} mm";
            }

            FreeFormElement form = FreeFormElement.Create(doc, solid);
            FmcDocGeometry.Label(form, name);
            // F-068: the twin takes its source solid's kit material on the form itself, so it holds even before (or without)
            // the material parameter; set_material_param then ties it to the parameter as for every solid
            string matNote = "";
            string matName = op.Value<string>("material");
            if (!string.IsNullOrEmpty(matName))
            {
                Material m = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x => x.Name == matName);
                Parameter mp = form.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
                if (m == null) matNote = ", material " + matName + " isn't in the family (add_material first)";
                else if (mp == null || mp.IsReadOnly) matNote = ", the form takes no material";
                else { mp.Set(m.Id); matNote = ", " + matName; }
            }
            return ("create", "form from Rhino " + Path.GetFileName(full) + (solids.Count > 1 ? " (" + solids.Count + " solids joined)" : "") + sizeNote + matNote);
        }
    }
}
