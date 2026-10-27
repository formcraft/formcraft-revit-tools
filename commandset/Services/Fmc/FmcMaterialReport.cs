using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_material_report (owner 27 Oct: "a lot of heavy materials, now the model is slow"), read-only: what makes the
    /// model heavy to draw. Materials with their texture files (found or missing, pixels, MB), model surface patterns,
    /// unused and duplicate materials, unused render appearances, views in Realistic, the heaviest families (faces x
    /// instances), CAD imports; then advice in words. textures: false skips the files, families: false the families.
    /// </summary>
    public class FmcMaterialReportHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft material report";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Report(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Report(Document doc)
        {
            bool textures = Parameters.Value<bool?>("textures") ?? true, families = Parameters.Value<bool?>("families") ?? true;
            int limit = Parameters.Value<int?>("limit") ?? 40;
            var mats = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().ToList();

            // used: on any element's geometry or painted on a face
            var used = new HashSet<ElementId>();
            foreach (Element e in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (e.Category == null || e is View) continue;
                try { foreach (ElementId id in e.GetMaterialIds(false)) used.Add(id); foreach (ElementId id in e.GetMaterialIds(true)) used.Add(id); }
                catch (Exception) { }
            }

            var dirs = SearchDirs(doc);
            var rows = new List<JObject>();
            var texSeen = new Dictionary<string, JObject>(StringComparer.OrdinalIgnoreCase);
            var usedAssets = new HashSet<ElementId>();
            foreach (Material m in mats)
            {
                usedAssets.Add(m.AppearanceAssetId);
                var row = new JObject { ["id"] = m.Id.Value, ["name"] = m.Name, ["used"] = used.Contains(m.Id) };
                if (doc.GetElement(m.AppearanceAssetId) is AppearanceAssetElement a)
                {
                    row["appearance"] = a.Name;
                    if (textures)
                    {
                        var tex = new JArray();
                        try { foreach (string p in Bitmaps(a.GetRenderingAsset()).Distinct(StringComparer.OrdinalIgnoreCase)) tex.Add(texSeen.TryGetValue(p, out JObject t) ? t : texSeen[p] = Texture(p, dirs)); }
                        catch (Exception) { }
                        if (tex.Count > 0) row["textures"] = tex;
                    }
                }
                string pat = Pattern(doc, m.SurfaceForegroundPatternId) ?? Pattern(doc, m.SurfaceBackgroundPatternId);
                if (pat != null) row["surface_pattern"] = pat;
                rows.Add(row);
            }

            double Px(JObject r) => (r["textures"] as JArray)?.Sum(t => (double?)t["megapixels"] ?? 0) ?? 0;
            var heavy = rows.Where(r => Px(r) > 0).OrderByDescending(Px).Take(limit).ToList();
            var tex4k = texSeen.Values.Where(t => ((double?)t["megapixels"] ?? 0) >= 8).ToList();   // about 4K x 2K and up
            var missing = texSeen.Values.Where(t => t.Value<bool>("found") == false).ToList();
            var patterned = rows.Where(r => r["surface_pattern"] != null && r.Value<bool>("used")).ToList();
            var unused = rows.Where(r => !r.Value<bool>("used")).ToList();
            var dupes = rows.GroupBy(r => Regex.Replace(r.Value<string>("name").ToLowerInvariant(), @"(\s*\(\d+\)|\s+\d+|\s*copy\s*\d*|\s*-\s*copy)$", "").Trim())
                .Where(g => g.Count() > 1).Take(limit)
                .Select(g => new JObject { ["name"] = g.Key, ["materials"] = new JArray(g.Select(r => new JObject { ["id"] = r["id"], ["name"] = r["name"], ["used"] = r["used"] })) }).ToList();
            var assets = new FilteredElementCollector(doc).OfClass(typeof(AppearanceAssetElement)).ToElementIds();
            int unusedAssets = assets.Count(id => !usedAssets.Contains(id));

            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .Where(v => !v.IsTemplate && (v.DisplayStyle == DisplayStyle.Realistic || v.DisplayStyle == DisplayStyle.RealisticWithEdges || v.DisplayStyle == DisplayStyle.Rendering || v.DisplayStyle == DisplayStyle.Textures))
                .Select(v => new JObject { ["id"] = v.Id.Value, ["name"] = v.Name, ["style"] = v.DisplayStyle.ToString(), ["template"] = v.ViewTemplateId != ElementId.InvalidElementId ? doc.GetElement(v.ViewTemplateId)?.Name : null }).ToList();

            var fams = new JArray();
            if (families)
            {
                var opt = new Options { DetailLevel = ViewDetailLevel.Fine };
                foreach (var g in new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>()
                             .Where(fi => fi.SuperComponent == null).GroupBy(fi => fi.Symbol.Family.Id).Take(600))
                {
                    var (faces, tris) = Weight(g.First().get_Geometry(opt));
                    fams.Add(new JObject { ["family"] = doc.GetElement(g.Key)?.Name, ["category"] = g.First().Category?.Name, ["instances"] = g.Count(), ["faces_each"] = faces, ["mesh_triangles_each"] = tris, ["weight"] = (long)(faces + tris) * g.Count() });
                }
                fams = new JArray(fams.OrderByDescending(f => (long)f["weight"]).Take(Math.Min(limit, 20)));
            }
            var cad = new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)).Cast<ImportInstance>().Where(i => !i.IsLinked).ToList();

            double texMb = texSeen.Values.Sum(t => (double?)t["mb"] ?? 0);
            var advice = new JArray();
            if (views.Count > 0) advice.Add($"{views.Count} views are in Realistic: Revit loads every texture there. display_mode navigate puts working views in Shaded; render puts them back.");
            if (tex4k.Count > 0) advice.Add($"{tex4k.Count} textures are 8 megapixels or more ({texMb:0} MB of textures in all): they only cost in Realistic and rendering, but there they are the main load.");
            if (missing.Count > 0) advice.Add($"{missing.Count} texture files are missing: Revit searches for them when it opens and renders. Fix the paths or add the folder in Options › Rendering.");
            if (patterned.Count > 0) advice.Add($"{patterned.Count} used materials draw a model surface pattern (brick, tile...): heavy in 3D. display_mode navigate hides surface patterns.");
            if (unused.Count > 0 || unusedAssets > 0) advice.Add($"{unused.Count} materials and {unusedAssets} render appearances are unused: Purge Unused makes the file smaller and quicker to open.");
            if (dupes.Count > 0) advice.Add($"{dupes.Count} groups of materials look like copies of each other (same name, a number added).");
            if (fams.Count > 0 && (long)fams[0]["weight"] > 200000) advice.Add($"The heaviest family is {fams[0]["family"]} ({fams[0]["instances"]} placed, {fams[0]["faces_each"]} faces and {fams[0]["mesh_triangles_each"]} mesh triangles each): maker families like this slow every view, materials or not. Coarse detail or a lighter family helps.");
            if (cad.Count > 0) advice.Add($"{cad.Count} CAD files are imported (not linked) into the model.");
            advice.Add("Revit's own setting: Options › Graphics › Simplify display during view navigation.");

            return new JObject
            {
                ["summary"] = new JObject
                {
                    ["materials"] = mats.Count, ["used"] = mats.Count - unused.Count, ["unused"] = unused.Count, ["render_appearances"] = assets.Count, ["unused_appearances"] = unusedAssets,
                    ["texture_files"] = texSeen.Count, ["texture_mb"] = Math.Round(texMb, 1), ["textures_8mp_plus"] = tex4k.Count, ["missing_textures"] = missing.Count,
                    ["used_with_surface_pattern"] = patterned.Count, ["realistic_views"] = views.Count, ["cad_imports"] = cad.Count,
                },
                ["advice"] = advice,
                ["heaviest_materials"] = new JArray(heavy),
                ["missing_textures"] = new JArray(missing.Take(limit)),
                ["surface_patterns"] = new JArray(patterned.Take(limit).Select(r => new JObject { ["id"] = r["id"], ["name"] = r["name"], ["pattern"] = r["surface_pattern"] })),
                ["unused_materials"] = new JArray(unused.Take(limit).Select(r => new JObject { ["id"] = r["id"], ["name"] = r["name"] })),
                ["duplicates"] = new JArray(dupes),
                ["realistic_views"] = new JArray(views.Take(limit)),
                ["heaviest_families"] = fams,
                ["cad_imports"] = new JArray(cad.Take(limit).Select(i => new JObject { ["id"] = i.Id.Value, ["name"] = doc.GetElement(i.GetTypeId())?.Name })),
            };
        }

        /// <summary>Every bitmap path in a render appearance, its connected assets too (diffuse, bump, cutout...).</summary>
        private static IEnumerable<string> Bitmaps(AssetProperties a)
        {
            if (a == null) yield break;
            for (int i = 0; i < a.Size; i++)
            {
                AssetProperty p = a.Get(i);
                if (p is AssetPropertyString s && p.Name == UnifiedBitmap.UnifiedbitmapBitmap && !string.IsNullOrWhiteSpace(s.Value))
                    foreach (string one in s.Value.Split('|')) if (one.Trim().Length > 0) yield return one.Trim();
                if (p.NumberOfConnectedProperties > 0)
                    foreach (AssetProperty c in p.GetAllConnectedProperties())
                        if (c is Asset ca) foreach (string b in Bitmaps(ca)) yield return b;
            }
        }

        /// <summary>Where Revit looks for a relative texture path: the model's folder, Options › Rendering, Autodesk's library.</summary>
        private static List<string> SearchDirs(Document doc)
        {
            var dirs = new List<string>();
            if (!string.IsNullOrEmpty(doc.PathName)) try { dirs.Add(Path.GetDirectoryName(doc.PathName)); } catch (Exception) { }
            try
            {
                string ini = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Autodesk", "Revit", "Autodesk Revit " + doc.Application.VersionNumber, "Revit.ini");
                if (File.Exists(ini))
                    foreach (string line in File.ReadAllLines(ini))
                        if (line.StartsWith("AdditionalRenderAppearancePaths=", StringComparison.OrdinalIgnoreCase))
                            dirs.AddRange(line.Substring(line.IndexOf('=') + 1).Split('|').Select(x => x.Trim()).Where(x => x.Length > 0));
            }
            catch (Exception) { }
            string shared = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFilesX86), "Autodesk Shared", "Materials", "Textures");
            dirs.Add(shared);
            return dirs;
        }

        private static JObject Texture(string path, List<string> dirs)
        {
            string found = null;
            try
            {
                if (Path.IsPathRooted(path) && File.Exists(path)) found = path;
                else
                    foreach (string d in dirs)
                    {
                        string c = Path.Combine(d, path.TrimStart('\\', '/'));
                        if (File.Exists(c)) { found = c; break; }
                        c = Path.Combine(d, Path.GetFileName(path));
                        if (File.Exists(c)) { found = c; break; }
                    }
            }
            catch (Exception) { }
            var t = new JObject { ["path"] = path, ["found"] = found != null };
            if (found == null) return t;
            if (found != path) t["at"] = found;
            try
            {
                t["mb"] = Math.Round(new FileInfo(found).Length / 1048576.0, 2);
                if (Pixels(found, out int w, out int h)) { t["px"] = $"{w} x {h}"; t["megapixels"] = Math.Round(w * (double)h / 1e6, 1); }
            }
            catch (Exception) { }
            return t;
        }

        /// <summary>Width and height from a PNG, JPEG or BMP header, without loading the image.</summary>
        internal static bool Pixels(string file, out int w, out int h)
        {
            w = h = 0;
            using var f = File.OpenRead(file);
            var b = new byte[Math.Min(f.Length, 262144)];
            int n = f.Read(b, 0, b.Length);
            if (n > 24 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G')
            { w = b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]; h = b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]; return true; }
            if (n > 26 && b[0] == 'B' && b[1] == 'M') { w = BitConverter.ToInt32(b, 18); h = Math.Abs(BitConverter.ToInt32(b, 22)); return true; }
            if (n > 4 && b[0] == 0xFF && b[1] == 0xD8)
            {
                int i = 2;
                while (i + 9 < n)
                {
                    if (b[i] != 0xFF) { i++; continue; }
                    byte k = b[i + 1];
                    if (k >= 0xC0 && k <= 0xCF && k != 0xC4 && k != 0xC8 && k != 0xCC) { h = b[i + 5] << 8 | b[i + 6]; w = b[i + 7] << 8 | b[i + 8]; return true; }
                    if (k == 0xD8 || k == 0x01 || (k >= 0xD0 && k <= 0xD7)) { i += 2; continue; }
                    i += 2 + (b[i + 2] << 8 | b[i + 3]);
                }
            }
            return false;
        }

        private static string Pattern(Document doc, ElementId id)
        {
            if (!(doc.GetElement(id) is FillPatternElement fp)) return null;
            FillPattern p = fp.GetFillPattern();
            return p.IsSolidFill || p.Target != FillPatternTarget.Model ? null : $"{fp.Name} ({p.GridCount} lines)";
        }

        /// <summary>Faces of solids and triangles of meshes in one instance (its symbol geometry, nested too).</summary>
        private static (int faces, int tris) Weight(GeometryElement g, int depth = 0)
        {
            int faces = 0, tris = 0;
            if (g == null || depth > 4) return (0, 0);
            foreach (GeometryObject o in g)
            {
                if (o is Solid s) faces += s.Faces.Size;
                else if (o is Mesh m) tris += m.NumTriangles;
                else if (o is GeometryInstance gi) { var (f, t) = Weight(gi.GetSymbolGeometry(), depth + 1); faces += f; tris += t; }
            }
            return (faces, tris);
        }
    }
}
