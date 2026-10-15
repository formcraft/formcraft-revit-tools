using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// A kit material made in a document (fmc_doc add_material, fmc_material assign). The server has already resolved
    /// it from 07_Materials\FMC_Materials.json (rule 7: kit data comes from the kit) and passes name, class, shaded
    /// colour, keynote, description, cost code and each texture map's absolute path and real-world size. This makes the
    /// material if it's missing, sets what differs, and gives it its own appearance asset (named after the material,
    /// duplicated from a Generic one) with the albedo as the diffuse bitmap and the bump map. A texture file that isn't on
    /// disk is left out with a warning: nothing is made up. Runs inside the caller's transaction.
    /// </summary>
    public static class FmcMaterialKit
    {
        public sealed class Outcome
        {
            public Material Material;
            public bool Created;
            public readonly List<string> Changes = new List<string>();
            public readonly List<string> Warnings = new List<string>();
        }

        public static Material Find(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == name);

        /// <summary>Makes or updates the material from the resolved kit fields; Changes is empty when nothing differed.</summary>
        public static Outcome Ensure(Document doc, JObject kit)
        {
            string name = kit.Value<string>("name") ?? throw new InvalidOperationException("the material has no name");
            var o = new Outcome { Material = Find(doc, name) };
            if (o.Material == null)
            {
                o.Material = (Material)doc.GetElement(Material.Create(doc, name));
                o.Created = true;
            }
            Material m = o.Material;

            string cls = kit.Value<string>("class") ?? "";
            if (cls.Length > 0 && m.MaterialClass != cls) { m.MaterialClass = cls; o.Changes.Add("class " + cls); }

            string shaded = kit.Value<string>("shaded") ?? kit["graphics"]?.Value<string>("shaded") ?? "";
            Color colour = ParseColour(shaded);
            if (colour != null && (!m.Color.IsValid || m.Color.Red != colour.Red || m.Color.Green != colour.Green || m.Color.Blue != colour.Blue))
            {
                m.Color = colour;
                o.Changes.Add("colour " + shaded);
            }

            SetText(m.get_Parameter(BuiltInParameter.KEYNOTE_PARAM), kit.Value<string>("keynote"), "keynote", o);
            SetText(m.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION), kit.Value<string>("description"), "description", o);
            // FMC_Cost_Code only where the document has it (project templates bind it; a family usually doesn't).
            SetText(m.LookupParameter("FMC_Cost_Code"), kit.Value<string>("cost_code"), "cost code", o);

            Appearance(doc, m, kit, colour, o);
            return o;
        }

        private static void SetText(Parameter p, string want, string label, Outcome o)
        {
            if (p == null || p.IsReadOnly || p.StorageType != StorageType.String || string.IsNullOrEmpty(want)) return;
            if ((p.AsString() ?? "") == want) return;
            p.Set(want);
            o.Changes.Add(label);
        }

        private static Color ParseColour(string hex)
        {
            if (string.IsNullOrEmpty(hex) || !hex.StartsWith("#") || hex.Length != 7) return null;
            try { return new Color(Convert.ToByte(hex.Substring(1, 2), 16), Convert.ToByte(hex.Substring(3, 2), 16), Convert.ToByte(hex.Substring(5, 2), 16)); }
            catch (FormatException) { return null; }
        }

        private sealed class TextureMap
        {
            public string Path;
            public double? WidthMm, HeightMm;
        }

        /// <summary>The map of this kind the server found on disk (and that is still there), or null with a warning.</summary>
        private static TextureMap MapOf(JObject kit, string kind, Outcome o)
        {
            foreach (JObject x in (kit["maps"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string map = x.Value<string>("map") ?? "";
                bool isKind = kind == "albedo" ? (map == "albedo" || map.Equals("colour", StringComparison.OrdinalIgnoreCase) || map.Equals("diffuse", StringComparison.OrdinalIgnoreCase))
                                               : map.Equals(kind, StringComparison.OrdinalIgnoreCase);
                if (!isKind) continue;
                string path = x.Value<string>("path") ?? "";
                if (path.Length == 0 || !File.Exists(path))
                {
                    o.Warnings.Add("texture " + (path.Length == 0 ? "(no file)" : path) + " isn't on disk: " + kit.Value<string>("name") + " is made without its " + kind + " map");
                    return null;
                }
                return new TextureMap { Path = path, WidthMm = x.Value<double?>("size_mm"), HeightMm = x.Value<double?>("height_mm") ?? x.Value<double?>("size_mm") };
            }
            return null;
        }

        /// <summary>The first bitmap path connected to a property of a rendering asset, or "".</summary>
        private static string BitmapPath(Asset asset, string property)
        {
            AssetProperty p = asset?.FindByName(property);
            if (p == null || p.NumberOfConnectedProperties < 1) return "";
            if (!(p.GetConnectedProperty(0) is Asset connected)) return "";
            return (connected.FindByName(UnifiedBitmap.UnifiedbitmapBitmap) as AssetPropertyString)?.Value?.Split('|').FirstOrDefault() ?? "";
        }

        private static bool SamePath(string a, string b) => string.Equals(a ?? "", b ?? "", StringComparison.OrdinalIgnoreCase);

        private static void Appearance(Document doc, Material m, JObject kit, Color colour, Outcome o)
        {
            TextureMap albedo = MapOf(kit, "albedo", o), bump = MapOf(kit, "bump", o);
            string name = m.Name;
            var current = doc.GetElement(m.AppearanceAssetId) as AppearanceAssetElement;
            if (albedo == null && bump == null && current != null && current.Name != name) return; // nothing to apply; keep what it has

            // Already right: its own asset with the same bitmaps.
            if (current != null && current.Name == name)
            {
                Asset now = current.GetRenderingAsset();
                if (SamePath(BitmapPath(now, Generic.GenericDiffuse), albedo?.Path) && SamePath(BitmapPath(now, Generic.GenericBumpMap), bump?.Path)) return;
            }

            AppearanceAssetElement mine = AppearanceAssetElement.GetAppearanceAssetElementByName(doc, name);
            if (mine == null)
            {
                mine = GenericAsset(doc, name) ?? throw new InvalidOperationException("no Generic appearance asset to start " + name + " from (Revit's material library isn't installed?)");
                o.Changes.Add("appearance asset " + name);
            }

            using (var scope = new AppearanceAssetEditScope(doc))
            {
                Asset edit = scope.Start(mine.Id);
                AssetProperty diffuse = edit.FindByName(Generic.GenericDiffuse) ?? throw new InvalidOperationException("the appearance asset isn't a Generic one");
                if (colour != null && diffuse is AssetPropertyDoubleArray4d rgba) rgba.SetValueAsColor(colour);
                ConnectBitmap(diffuse, albedo, "albedo", o);
                AssetProperty bumpProp = edit.FindByName(Generic.GenericBumpMap);
                if (bumpProp == null) { if (bump != null) o.Warnings.Add(name + ": the appearance asset has no bump slot, so the bump map isn't applied"); }
                else ConnectBitmap(bumpProp, bump, "bump", o);
                scope.Commit(true);
            }
            if (m.AppearanceAssetId != mine.Id) { m.AppearanceAssetId = mine.Id; o.Changes.Add("appearance"); }
        }

        /// <summary>Connects a bitmap with its path and real-world size to the property, or removes one when there's no map.</summary>
        private static void ConnectBitmap(AssetProperty prop, TextureMap map, string kind, Outcome o)
        {
            if (map == null)
            {
                // Never leave a texture the starting asset happened to carry: a missing map means no map.
                if (prop.NumberOfConnectedProperties > 0) { prop.RemoveConnectedAsset(); o.Changes.Add("no " + kind + " map"); }
                return;
            }
            if (prop.NumberOfConnectedProperties == 0) prop.AddConnectedAsset("UnifiedBitmapSchema");
            Asset bitmap = prop.GetSingleConnectedAsset() ?? throw new InvalidOperationException("Revit didn't connect a bitmap to the " + kind + " slot");
            var path = bitmap.FindByName(UnifiedBitmap.UnifiedbitmapBitmap) as AssetPropertyString ?? throw new InvalidOperationException("the bitmap has no path");
            if (!path.IsValidValue(map.Path)) { o.Warnings.Add("Revit doesn't accept " + map.Path + " as a bitmap"); prop.RemoveConnectedAsset(); return; }
            path.Value = map.Path;
            SetSize(bitmap, UnifiedBitmap.TextureRealWorldScaleX, map.WidthMm);
            SetSize(bitmap, UnifiedBitmap.TextureRealWorldScaleY, map.HeightMm);
            o.Changes.Add(kind + " " + Path.GetFileName(map.Path) + (map.WidthMm.HasValue ? " at " + map.WidthMm + " mm" : ""));
        }

        private static void SetSize(Asset bitmap, string property, double? mm)
        {
            if (!mm.HasValue || mm.Value <= 0) return;
            if (!(bitmap.FindByName(property) is AssetPropertyDistance d)) return;
            // The distance is stored in the property's own unit (often inches); convert from mm to it.
            double want = UnitUtils.Convert(mm.Value, UnitTypeId.Millimeters, d.GetUnitTypeId());
            try { d.Value = want; }
            catch (Exception) { /* outside the property's range: the bitmap keeps its default size */ }
        }

        /// <summary>A new appearance asset named after the material, copied from a Generic asset in the document or the library.</summary>
        private static AppearanceAssetElement GenericAsset(Document doc, string name)
        {
            bool IsGeneric(Asset a) => a != null && a.FindByName(Generic.GenericDiffuse) != null;
            AppearanceAssetElement inDoc = new FilteredElementCollector(doc).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>()
                .OrderByDescending(a => a.Name.IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0)
                .FirstOrDefault(a => { try { return IsGeneric(a.GetRenderingAsset()); } catch { return false; } });
            if (inDoc != null) return inDoc.Duplicate(name);
            Asset library = doc.Application.GetAssets(AssetType.Appearance)
                .OrderByDescending(a => (a.Name ?? "").IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0)
                .FirstOrDefault(IsGeneric);
            return library == null ? null : AppearanceAssetElement.Create(doc, name, library);
        }
    }
}
