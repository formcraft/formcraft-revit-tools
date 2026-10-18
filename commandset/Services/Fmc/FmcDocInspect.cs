using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// What a family holds, in detail (F-056), and screenshots cropped to its own geometry at a chosen detail level and
    /// style (F-055). Screenshot changes to views are made in a TransactionGroup that is rolled back, so the family is
    /// left exactly as it was.
    /// </summary>
    public static class FmcDocInspect
    {
        private static double Mm(double feet) => System.Math.Round(UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters), 1);
        private static JArray P(XYZ p) => new JArray(Mm(p.X), Mm(p.Y), Mm(p.Z));
        private static JArray D(XYZ v) => new JArray(System.Math.Round(v.X, 3), System.Math.Round(v.Y, 3), System.Math.Round(v.Z, 3));

        private static string Facing(XYZ v)
        {
            if (v.IsAlmostEqualTo(XYZ.BasisX)) return "+x (right)";
            if (v.IsAlmostEqualTo(XYZ.BasisX.Negate())) return "-x (left)";
            if (v.IsAlmostEqualTo(XYZ.BasisY)) return "+y (back)";
            if (v.IsAlmostEqualTo(XYZ.BasisY.Negate())) return "-y (front)";
            if (v.IsAlmostEqualTo(XYZ.BasisZ)) return "+z (up)";
            if (v.IsAlmostEqualTo(XYZ.BasisZ.Negate())) return "-z (down)";
            return "other";
        }

        /// <summary>Per-solid, per-connector and nested detail, plus the overall extents in mm.</summary>
        public static void AddDetail(Document doc, JObject r)
        {
            var solids = new JArray();
            foreach (GenericForm f in new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>())
            {
                var o = new JObject { ["name"] = FmcDocGeometry.NameOf(f), ["kind"] = f.GetType().Name, ["void"] = !f.IsSolid, ["subcategory"] = f.Subcategory?.Name ?? "" };
                try
                {
                    FamilyElementVisibility vis = f.GetVisibility();
                    o["visible_in"] = new JObject
                    {
                        ["coarse"] = vis.IsShownInCoarse, ["medium"] = vis.IsShownInMedium, ["fine"] = vis.IsShownInFine,
                        ["plan_rcp"] = vis.IsShownInPlanRCPCut, ["front_back"] = vis.IsShownInFrontBack, ["left_right"] = vis.IsShownInLeftRight,
                    };
                }
                catch (System.Exception) { /* not every form has visibility */ }
                BoundingBoxXYZ bb = f.get_BoundingBox(null);
                if (bb != null) o["box_mm"] = new JObject { ["min"] = P(bb.Min), ["max"] = P(bb.Max) };
                solids.Add(o);
            }
            r["solids_detail"] = solids;

            var connectors = new JArray();
            foreach (ConnectorElement c in new FilteredElementCollector(doc).OfClass(typeof(ConnectorElement)).Cast<ConnectorElement>())
            {
                var o = new JObject { ["name"] = FmcDocGeometry.NameOf(c), ["domain"] = c.Domain.ToString(), ["system"] = c.SystemClassification.ToString(), ["shape"] = c.Shape.ToString() };
                try { o["origin_mm"] = P(c.Origin); } catch (System.Exception) { }
                try
                {
                    XYZ z = c.CoordinateSystem.BasisZ;
                    o["direction"] = D(z);
                    o["facing"] = Facing(z);
                }
                catch (System.Exception) { }
                foreach (var (key, bip) in new[] { ("diameter_mm", BuiltInParameter.CONNECTOR_DIAMETER), ("width_mm", BuiltInParameter.CONNECTOR_WIDTH), ("height_mm", BuiltInParameter.CONNECTOR_HEIGHT) })
                {
                    Parameter p = c.get_Parameter(bip);
                    if (p != null && p.HasValue && p.AsDouble() > 0) o[key] = Mm(p.AsDouble());
                }
                Parameter v = c.get_Parameter(BuiltInParameter.RBS_ELEC_VOLTAGE);
                if (v != null && v.HasValue) o["voltage_v"] = System.Math.Round(UnitUtils.ConvertFromInternalUnits(v.AsDouble(), UnitTypeId.Volts), 1);
                connectors.Add(o);
            }
            r["connectors_detail"] = connectors;

            r["nested"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().Select(i => new JObject
            {
                ["family"] = i.Symbol?.Family?.Name ?? "", ["type"] = i.Symbol?.Name ?? "",
                ["at_mm"] = i.Location is LocationPoint lp ? P(lp.Point) : null,
                ["shared"] = i.Symbol?.Family?.get_Parameter(BuiltInParameter.FAMILY_SHARED)?.AsInteger() == 1,
            }));

            BoundingBoxXYZ ext = Extents(doc);
            r["extents_mm"] = ext == null ? null : new JObject
            {
                ["min"] = P(ext.Min), ["max"] = P(ext.Max),
                ["size"] = new JArray(Mm(ext.Max.X - ext.Min.X), Mm(ext.Max.Y - ext.Min.Y), Mm(ext.Max.Z - ext.Min.Z)),
            };
        }

        /// <summary>The box round every solid (not voids) and nested family.</summary>
        public static BoundingBoxXYZ Extents(Document doc)
        {
            var boxes = new List<BoundingBoxXYZ>();
            boxes.AddRange(new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>().Where(f => f.IsSolid).Select(f => f.get_BoundingBox(null)));
            boxes.AddRange(new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Select(e => e.get_BoundingBox(null)));
            boxes = boxes.Where(b => b != null).ToList();
            if (boxes.Count == 0) return null;
            return new BoundingBoxXYZ
            {
                Min = new XYZ(boxes.Min(b => b.Min.X), boxes.Min(b => b.Min.Y), boxes.Min(b => b.Min.Z)),
                Max = new XYZ(boxes.Max(b => b.Max.X), boxes.Max(b => b.Max.Y), boxes.Max(b => b.Max.Z)),
            };
        }

        private static DisplayStyle Style(string s) => s switch
        {
            "hidden" => DisplayStyle.HLR, "wireframe" => DisplayStyle.Wireframe, "realistic" => DisplayStyle.Realistic, _ => DisplayStyle.ShadingWithEdges,
        };

        private static ViewDetailLevel Level(string s) => s switch
        {
            "coarse" => ViewDetailLevel.Coarse, "medium" => ViewDetailLevel.Medium, _ => ViewDetailLevel.Fine,
        };

        private static View Pick(List<View> views, string which) => which switch
        {
            "3d" => views.OfType<View3D>().FirstOrDefault(v => !v.IsPerspective),
            "plan" => views.FirstOrDefault(v => v.ViewType == ViewType.FloorPlan),
            "right" => views.FirstOrDefault(v => v.ViewType == ViewType.Elevation && v.Name.IndexOf("Right", System.StringComparison.OrdinalIgnoreCase) >= 0),
            _ => views.FirstOrDefault(v => v.ViewType == ViewType.Elevation && v.Name.IndexOf("Front", System.StringComparison.OrdinalIgnoreCase) >= 0),
        };

        /// <summary>F-055: each view cropped to the family's geometry (with a margin), at the detail level and style asked for.</summary>
        public static JObject Screenshot(Document doc, string folder, string title, string detail, string style, IList<string> which)
        {
            Directory.CreateDirectory(folder);
            var notes = new JArray();
            var all = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && v.CanBePrinted).ToList();
            var picked = (which.Count == 0 ? new List<string> { "3d", "front", "plan" } : which).Select(w => (w, v: Pick(all, w))).Where(x => x.v != null).ToList();
            if (picked.Count == 0) throw new System.InvalidOperationException("The document has no view to capture.");
            string[] levels = detail == "all" ? new[] { "coarse", "medium", "fine" } : new[] { detail };
            BoundingBoxXYZ ext = Extents(doc);
            if (ext == null) notes.Add("No solids: views are not cropped");
            double pad = UnitUtils.ConvertToInternalUnits(50, UnitTypeId.Millimeters);
            var files = new JArray();
            string stamp = System.DateTime.Now.ToString("HHmmss");
            using (var tg = new TransactionGroup(doc, "FMC screenshot (rolled back)"))
            {
                tg.Start();
                foreach (string lvl in levels)
                {
                    using (var t = new Transaction(doc, "FMC screenshot views"))
                    {
                        t.Start();
                        foreach (var (w, v) in picked)
                        {
                            try { v.DetailLevel = Level(lvl); } catch (System.Exception e) { notes.Add($"{v.Name}: detail level {e.Message}"); }
                            try { v.DisplayStyle = Style(style); } catch (System.Exception e) { notes.Add($"{v.Name}: style {e.Message}"); }
                            // QS10: the same aids hidden as in the preview: planes, levels, dimensions, connector glyphs, Clearance and Coarse
                            FmcPreview.HideClutter(doc, v);
                            if (ext == null) continue;
                            if (v is View3D v3)
                            {
                                try { v3.SetSectionBox(new BoundingBoxXYZ { Min = ext.Min - new XYZ(pad, pad, pad), Max = ext.Max + new XYZ(pad, pad, pad) }); }
                                catch (System.Exception e) { notes.Add("3D section box: " + e.Message); }
                            }
                            else
                            {
                                try { Crop(v, ext, pad); } catch (System.Exception e) { notes.Add($"{v.Name}: crop {e.Message}"); }
                            }
                        }
                        t.Commit();
                    }
                    foreach (var (w, v) in picked)
                    {
                        string stem = Path.Combine(folder, $"{Safe(title)}_{w}_{lvl}_{stamp}");
                        var options = new ImageExportOptions
                        {
                            ExportRange = ExportRange.SetOfViews, FilePath = stem, HLRandWFViewsFileType = ImageFileType.PNG,
                            ShadowViewsFileType = ImageFileType.PNG, ImageResolution = ImageResolution.DPI_150, ZoomType = ZoomFitType.FitToPage,
                            PixelSize = 1200, FitDirection = FitDirectionType.Horizontal,
                        };
                        options.SetViewsAndSheets(new List<ElementId> { v.Id });
                        doc.ExportImage(options);
                        string made = Directory.GetFiles(folder, Path.GetFileName(stem) + "*.png").FirstOrDefault() ?? "";
                        if (made.Length > 0) files.Add(new JObject { ["view"] = w, ["detail_level"] = lvl, ["file"] = made });
                    }
                }
                tg.RollBack();
            }
            return new JObject
            {
                ["files"] = files, ["notes"] = notes,
                ["extents_mm"] = ext == null ? null : new JObject { ["min"] = P(ext.Min), ["max"] = P(ext.Max) },
            };
        }

        /// <summary>Crops a plan or elevation to the box, in the view's own coordinates, keeping its depth.</summary>
        private static void Crop(View v, BoundingBoxXYZ ext, double pad)
        {
            BoundingBoxXYZ crop = v.CropBox;
            Transform inv = crop.Transform.Inverse;
            var corners = new List<XYZ>();
            foreach (double x in new[] { ext.Min.X, ext.Max.X })
                foreach (double y in new[] { ext.Min.Y, ext.Max.Y })
                    foreach (double z in new[] { ext.Min.Z, ext.Max.Z })
                        corners.Add(inv.OfPoint(new XYZ(x, y, z)));
            var box = new BoundingBoxXYZ
            {
                Transform = crop.Transform,
                Min = new XYZ(corners.Min(c => c.X) - pad, corners.Min(c => c.Y) - pad, crop.Min.Z),
                Max = new XYZ(corners.Max(c => c.X) + pad, corners.Max(c => c.Y) + pad, crop.Max.Z),
            };
            v.CropBoxActive = true;
            v.CropBox = box;
            v.CropBoxVisible = false;
        }

        private static string Safe(string s) => string.Concat((s ?? "").Select(c => Path.GetInvalidFileNameChars().Contains(c) || c == ' ' ? '_' : c));
        /// <summary>
        /// set_type_image (owner, 17 Oct): the product picture becomes Revit's built-in Type Image, so it shows in Type
        /// Properties, in schedules (image field) and in legends beside the legend components. The image is imported
        /// into the family (no link to the file), and a second run reloads it, so a better render replaces the old one.
        /// </summary>
        public static (string, string) SetTypeImage(Document doc, JObject op)
        {
            if (!doc.IsFamilyDocument) throw new InvalidOperationException("set_type_image works in a family");
            string path = op.Value<string>("path"), only = op.Value<string>("type");
            if (!System.IO.File.Exists(path)) throw new InvalidOperationException("No file " + path);
            string file = System.IO.Path.GetFileName(path);
            var opts = new ImageTypeOptions(path, false, ImageTypeSource.Import);
            ImageType img = new FilteredElementCollector(doc).OfClass(typeof(ImageType)).Cast<ImageType>()
                .FirstOrDefault(i => string.Equals(System.IO.Path.GetFileName(i.Path ?? ""), file, StringComparison.OrdinalIgnoreCase));
            string what = img == null ? "create" : "update";
            if (img == null) img = ImageType.Create(doc, opts); else img.ReloadFrom(opts);
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter fp = fm.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_IMAGE)
                ?? throw new InvalidOperationException("This family has no Type Image parameter (Revit 2020+ model families have it)");
            int n = 0;
            foreach (FamilyType t in fm.Types)
            {
                if (!string.IsNullOrEmpty(only) && t.Name != only) continue;
                fm.CurrentType = t; fm.Set(fp, img.Id); n++;
            }
            if (n == 0) throw new InvalidOperationException("No type " + only);
            return (what, file + " is the Type Image of " + n + " type(s)");
        }
    }
}
