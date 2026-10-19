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

        /// <summary>The solid's size along x, y and z (mm), from the points of its faces' triangulation and its edges: tight on smooth faces, where the bounding box isn't.</summary>
        private static double[] TightSizeMm(Solid solid)
        {
            double[] lo = { double.MaxValue, double.MaxValue, double.MaxValue }, hi = { double.MinValue, double.MinValue, double.MinValue };
            void Add(XYZ p) { double[] v = { p.X, p.Y, p.Z }; for (int k = 0; k < 3; k++) { lo[k] = Math.Min(lo[k], v[k]); hi[k] = Math.Max(hi[k], v[k]); } }
            foreach (Face f in solid.Faces) { Mesh m = f.Triangulate(); if (m != null) foreach (XYZ p in m.Vertices) Add(p); }
            foreach (Edge e in solid.Edges) foreach (XYZ p in e.Tessellate()) Add(p);
            if (lo[0] == double.MaxValue)
            {
                BoundingBoxXYZ bb = solid.GetBoundingBox();
                XYZ d = bb.Max - bb.Min;
                return new[] { ToMm(d.X), ToMm(d.Y), ToMm(d.Z) };
            }
            return new[] { ToMm(hi[0] - lo[0]), ToMm(hi[1] - lo[1]), ToMm(hi[2] - lo[2]) };
        }

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

            // the size Rhino reported (fmc_rhino facts). Measured on the solid's own surface (its triangulation), not its
            // bounding box: Revit's box around smooth (NURBS) faces is loose by a few mm. Wrong units show as a whole
            // factor (10, 25.4, 304.8, 1000); a few mm or per cent is the smoothing, and passes with a note.
            string sizeNote = "";
            if (op["size_mm"] is JArray want && want.Count == 3)
            {
                double[] got = TightSizeMm(solid);
                double[] w = { want[0].Value<double>(), want[1].Value<double>(), want[2].Value<double>() };
                string arrived = $"{Math.Round(got[0], 1)} × {Math.Round(got[1], 1)} × {Math.Round(got[2], 1)} mm";
                string made = $"{w[0]} × {w[1]} × {w[2]} mm";
                double worst = 0;
                for (int k = 0; k < 3; k++)
                {
                    if (w[k] <= 1) continue;
                    double ratio = got[k] / w[k];
                    foreach (double f in new[] { 10.0, 25.4, 304.8, 1000.0 })
                        if (Math.Abs(ratio - f) < 0.05 * f || Math.Abs(ratio - 1 / f) < 0.05 / f)
                            throw new InvalidOperationException($"{name} arrived {arrived}, Rhino made it {made}: about {f}× off, so the file's units were not read as millimetres");
                    worst = Math.Max(worst, Math.Abs(got[k] - w[k]));
                    if (Math.Abs(got[k] - w[k]) > Math.Max(3.0, 0.05 * w[k]))
                        throw new InvalidOperationException($"{name} arrived {arrived}, Rhino made it {made}: not a units slip (no whole factor); the part changed, or the file isn't the one fmc_rhino exported (export_parts again)");
                }
                sizeNote = worst > 1.0 ? $", {arrived} (Rhino {made}: within the smoothing allowance)" : $", {arrived}";
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
