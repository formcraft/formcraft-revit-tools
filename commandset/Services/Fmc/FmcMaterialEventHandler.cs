using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Materials (U18) on the Revit main thread. facts (read-only) lists the model's materials, whether each is used and
    /// its texture paths; assign gives types a database material on a finish layer, the type material or a family Finish
    /// parameter; purge deletes materials nothing uses. assign and purge plan without a transaction when dry_run is true;
    /// for real they change only material assignments, never geometry, and the server sends them through the live-model lock.
    /// </summary>
    public class FmcMaterialEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: Action == "facts");
                switch (Action)
                {
                    case "facts": Result = Facts(target.Doc); break;
                    case "assign": Result = Assign(target); break;
                    case "purge": Result = Purge(target.Doc); break;
                    default: Error = $"Unknown FMC material action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC materials";

        // ------------------------------------------------------------------ facts

        /// <summary>Materials used by elements, compound layers, type and category material settings (also the template audit's, F-044).</summary>
        internal static HashSet<long> UsedMaterials(Document doc)
        {
            var used = new HashSet<long>();
            foreach (Element e in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (e.Category == null || e.Category.CategoryType != CategoryType.Model) continue;
                try { foreach (ElementId id in e.GetMaterialIds(false)) used.Add(id.Value); } catch { }
            }
            foreach (ElementType t in new FilteredElementCollector(doc).WhereElementIsElementType().Cast<ElementType>())
            {
                if (t is HostObjAttributes h && h.GetCompoundStructure() is CompoundStructure cs)
                    foreach (CompoundStructureLayer l in cs.GetLayers()) used.Add(l.MaterialId.Value);
                foreach (Parameter p in t.Parameters)
                    if (p.StorageType == StorageType.ElementId && p.AsElementId() is ElementId id && id.Value > 0 && doc.GetElement(id) is Material)
                        used.Add(id.Value);
            }
            foreach (Category c in doc.Settings.Categories)
                if (c.Material != null) used.Add(c.Material.Id.Value);
            return used;
        }

        internal static IEnumerable<string> Textures(Document doc, Material m)
        {
            var paths = new List<string>();
            if (!(doc.GetElement(m.AppearanceAssetId) is AppearanceAssetElement aae)) return paths;
            Asset asset = aae.GetRenderingAsset();
            for (int i = 0; i < asset.Size; i++)
            {
                AssetProperty p = asset.Get(i);
                if (p.NumberOfConnectedProperties < 1) continue;
                if (p.GetConnectedProperty(0) is Asset connected &&
                    connected.FindByName(UnifiedBitmap.UnifiedbitmapBitmap) is AssetPropertyString bitmap && !string.IsNullOrWhiteSpace(bitmap.Value))
                    paths.AddRange(bitmap.Value.Split('|').Where(x => x.Length > 0));
            }
            return paths;
        }

        private static JObject Facts(Document doc)
        {
            var used = UsedMaterials(doc);
            var materials = new JArray();
            foreach (Material m in new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>())
            {
                IEnumerable<string> textures;
                try { textures = Textures(doc, m); } catch { textures = Enumerable.Empty<string>(); }
                materials.Add(new JObject { ["id"] = m.Id.Value, ["name"] = m.Name, ["used"] = used.Contains(m.Id.Value), ["textures"] = new JArray(textures) });
            }
            return new JObject { ["model"] = doc.Title, ["materials"] = materials };
        }

        // ------------------------------------------------------------------ assign

        private static readonly Dictionary<string, BuiltInCategory> Categories = new Dictionary<string, BuiltInCategory>
        {
            ["Floors"] = BuiltInCategory.OST_Floors, ["Walls"] = BuiltInCategory.OST_Walls, ["Ceilings"] = BuiltInCategory.OST_Ceilings,
            ["Roofs"] = BuiltInCategory.OST_Roofs, ["Doors"] = BuiltInCategory.OST_Doors,
        };

        private List<ElementType> Targets(FmcTarget on)
        {
            Document doc = on.Doc;
            string target = Parameters.Value<string>("target") ?? "category";
            if (target == "selection")
                return on.RequireUi("Assigning to the selection").Selection.GetElementIds().Select(id => doc.GetElement(doc.GetElement(id)?.GetTypeId() ?? ElementId.InvalidElementId) as ElementType)
                    .Where(t => t != null).GroupBy(t => t.Id.Value).Select(g => g.First()).ToList();
            string category = Parameters.Value<string>("category") ?? "";
            if (!Categories.TryGetValue(category, out BuiltInCategory bic)) throw new ArgumentException($"Unknown category {category}");
            var types = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsElementType().Cast<ElementType>().ToList();
            string contains = Parameters.Value<string>("contains") ?? "";
            if (target == "rule") types = types.Where(t => t.Name.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            return types;
        }

        /// <summary>What setting the material on this type would change, or why it can't; applies it when apply is true.</summary>
        private static string Change(ElementType t, string parameter, ElementId material, string materialName, bool apply)
        {
            switch (parameter)
            {
                case "finish_layer":
                    if (!(t is HostObjAttributes h) || !(h.GetCompoundStructure() is CompoundStructure cs)) return null;
                    var layers = cs.GetLayers();
                    var finish = layers.Where(l => l.Function == MaterialFunctionAssignment.Finish1 || l.Function == MaterialFunctionAssignment.Finish2).ToList();
                    if (finish.Count == 0) return null;
                    if (apply)
                    {
                        foreach (var l in finish) cs.SetMaterialId(l.LayerId, material);
                        h.SetCompoundStructure(cs);
                    }
                    return "finish layer → " + materialName;
                case "type_material":
                    Parameter p = t.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM) ?? t.LookupParameter("Material");
                    if (p == null || p.IsReadOnly || p.StorageType != StorageType.ElementId) return null;
                    if (apply) p.Set(material);
                    return "type material → " + materialName;
                default:
                    Parameter f = t.LookupParameter("Finish");
                    if (f == null || f.IsReadOnly || f.StorageType != StorageType.ElementId) return null;
                    if (apply) f.Set(material);
                    return "Finish → " + materialName;
            }
        }

        private JObject Assign(FmcTarget on)
        {
            Document doc = on.Doc;
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            var db = Parameters["material"] as JObject ?? throw new ArgumentException("material is required");
            string name = db.Value<string>("name");
            string parameter = Parameters.Value<string>("parameter") ?? "finish_layer";
            Material existing = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == name);
            var targets = Targets(on);
            var counts = new FilteredElementCollector(doc).WhereElementIsNotElementType().ToElements()
                .GroupBy(e => e.GetTypeId().Value).ToDictionary(g => g.Key, g => g.Count());

            var plan = new JArray();
            var warnings = new List<string>();
            Transaction tx = dry ? null : new Transaction(doc, "Formcraft: assign material");
            tx?.Start();
            try
            {
                ElementId materialId = existing?.Id ?? ElementId.InvalidElementId;
                if (!dry && existing == null) materialId = CreateMaterial(doc, db, warnings);
                foreach (ElementType t in targets)
                {
                    string change = Change(t, parameter, materialId, name, apply: !dry);
                    plan.Add(new JObject
                    {
                        ["type"] = (t is FamilySymbol fs ? fs.FamilyName + " - " : "") + t.Name,
                        ["elements"] = counts.TryGetValue(t.Id.Value, out int n) ? n : 0,
                        ["change"] = change ?? "skipped: no " + (parameter == "finish_layer" ? "finish layer" : parameter == "type_material" ? "material parameter" : "Finish parameter"),
                    });
                }
                tx?.Commit();
            }
            finally
            {
                tx?.Dispose();
            }
            return new JObject { ["types"] = plan, ["creates"] = existing == null, ["warnings"] = new JArray(warnings) };
        }

        /// <summary>
        /// A database material made in the model: name, class, shaded colour, keynote, description and cost code, and its
        /// appearance with the kit's albedo and bump textures (the same helper fmc_doc add_material uses). A texture that
        /// isn't on disk is left out and reported.
        /// </summary>
        private static ElementId CreateMaterial(Document doc, JObject db, List<string> warnings)
        {
            FmcMaterialKit.Outcome made = FmcMaterialKit.Ensure(doc, db);
            warnings.AddRange(made.Warnings);
            return made.Material.Id;
        }

        // ------------------------------------------------------------------ purge

        private JObject Purge(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            var used = UsedMaterials(doc);
            var unused = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().Where(m => !used.Contains(m.Id.Value)).ToList();
            var names = new JArray(unused.Select(m => m.Name));
            if (!dry && unused.Count > 0)
                using (var t = new Transaction(doc, "Formcraft: purge unused materials"))
                {
                    t.Start();
                    foreach (var m in unused) { try { doc.Delete(m.Id); } catch { names.Remove(names.FirstOrDefault(x => x.ToString() == m.Name)); } }
                    t.Commit();
                }
            return new JObject { ["materials"] = names };
        }
    }
}
