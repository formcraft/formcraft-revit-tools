using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>A material in the kit's database (FMC_Materials.json).</summary>
    public sealed class DbMaterial
    {
        public string Name { get; set; } = "";
        public string Class { get; set; } = "";
        public string Sub { get; set; } = "";
        public string Keynote { get; set; } = "";
        public string CostCode { get; set; } = "";
        public string Supplier { get; set; } = "";
        public string Graphics { get; set; } = "";
        public List<(string Map, string File, string Size)> Maps { get; } = new List<(string, string, string)>();
    }

    public sealed class MaterialDatabase
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string File { get; set; } = "";
        public string Version { get; set; } = "";
        public int Count { get; set; }
        public List<string> Classes { get; } = new List<string>();
        public List<DbMaterial> Materials { get; } = new List<DbMaterial>();
    }

    public sealed class MaterialCheck
    {
        public MaterialCheck(string check, int found, string result, IReadOnlyList<string> items) { Check = check; Found = found; Result = result; Items = items; }
        public string Check { get; }
        public int Found { get; }
        public string Result { get; }
        public IReadOnlyList<string> Items { get; }
        public ChipKind Kind => Result == "Pass" ? ChipKind.Good : Result == "Fail" ? ChipKind.Bad : Result == "Warn" ? ChipKind.Warn : ChipKind.Info;
    }

    /// <summary>What an assign would change, per type.</summary>
    public sealed class AssignPlan
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public bool CreatesMaterial { get; set; }
        public List<(string Type, int Elements, string Change)> Types { get; } = new List<(string, int, string)>();
    }

    /// <summary>Setup › Materials: fmc_material through the server (database from the kit, facts from Revit).</summary>
    public interface IMaterialTools
    {
        Task<MaterialDatabase> DatabaseAsync(string cls, string query);
        Task<(bool Ok, string Message, List<MaterialCheck> Checks)> AuditAsync();
        Task<AssignPlan> AssignAsync(string material, string target, string category, string contains, string parameter, bool dryRun);
        Task<(bool Ok, string Message, List<string> Materials)> PurgeAsync(bool dryRun);
        Task<string> RequestAsync(string name, string text);
        Task<string> UpdatesAsync();
    }

    /// <summary>Sample values from board manage/PaneMaterials.</summary>
    public sealed class MockMaterialTools : IMaterialTools
    {
        public List<(string Material, bool Dry)> Assigns { get; } = new List<(string, bool)>();
        public List<bool> Purges { get; } = new List<bool>();
        public List<string> Requests { get; } = new List<string>();

        private static DbMaterial M(string name, string cls, string sub, string keynote, string cost) =>
            new DbMaterial { Name = name, Class = cls, Sub = sub, Keynote = keynote, CostCode = cost, Supplier = "[SUPPLIER]", Graphics = "Shaded #D8D2C4 · surface 600x600 grid · cut none" };

        public Task<MaterialDatabase> DatabaseAsync(string cls, string query)
        {
            var db = new MaterialDatabase { Ok = true, File = @"Z:\00_Standards\07_Materials\FMC_Materials.json", Version = "1.3", Count = 214 };
            db.Classes.AddRange(new[] { "Concrete", "Masonry", "Finishes", "Metals", "Timber", "Glass", "MEP" });
            var tile = M("FMC_Tile_Porcelain_600", "Finishes", "floor", "F.TIL_02", "M.20.04");
            tile.Maps.Add(("Colour", "tile_porc_600_col.jpg", "600 mm"));
            tile.Maps.Add(("Bump", "tile_porc_600_bmp.jpg", "600 mm"));
            var all = new[]
            {
                M("FMC_Concrete_C25-30", "Concrete", "structural", "C.CON_01", "M.05.01"), M("FMC_Block_Hollow_230", "Masonry", "walls", "M.BLK_02", "M.10.02"),
                M("FMC_Paint_Int_Matt_White", "Finishes", "wall", "F.PNT_01", "M.20.11"), tile, M("FMC_Glass_Clear_6mm", "Glass", "glazing", "G.GLZ_01", "M.30.01"),
            };
            db.Materials.AddRange(all.Where(m => (cls == "All" || cls.Length == 0 || m.Class == cls) &&
                (query.Length == 0 || m.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)));
            return Task.FromResult(db);
        }

        public Task<(bool Ok, string Message, List<MaterialCheck> Checks)> AuditAsync() => Task.FromResult((true, "Audited F26001-FMC-ZZ-ZZ-M3-A-0001.rvt.", new List<MaterialCheck>
        {
            new MaterialCheck("Materials not in the database", 17, "Warn", new[] { "Concrete", "Plaster" }),
            new MaterialCheck("Duplicates (\"Concrete (1)\", \"Default\")", 6, "Warn", new[] { "Concrete (1)" }),
            new MaterialCheck("Broken texture paths", 4, "Fail", new[] { "Tile old" }),
            new MaterialCheck("Unused materials", 38, "Info", new[] { "Glass old" }),
            new MaterialCheck("Names not FMC_ standard", 11, "Warn", new[] { "Concrete" }),
        }));

        public Task<AssignPlan> AssignAsync(string material, string target, string category, string contains, string parameter, bool dryRun)
        {
            Assigns.Add((material, dryRun));
            var p = new AssignPlan { Ok = true, CreatesMaterial = true, Message = dryRun ? "Plan only: nothing changed." : "Assigned " + material + " to 2 types. Logged in FMC_MCP_FileLog.csv." };
            p.Types.Add(("Floor - Porcelain 600 on screed", 38, "finish layer → " + material));
            p.Types.Add(("Floor - Porcelain 600 wet area", 12, "finish layer → " + material));
            return Task.FromResult(p);
        }

        public Task<(bool Ok, string Message, List<string> Materials)> PurgeAsync(bool dryRun)
        {
            Purges.Add(dryRun);
            return Task.FromResult((true, dryRun ? "Would purge 2 unused materials." : "Purged 2 unused materials.", new List<string> { "Glass old", "Render (2)" }));
        }

        public Task<string> RequestAsync(string name, string text)
        {
            Requests.Add(name + ": " + text);
            return Task.FromResult("Requested " + name + ". The BIM Manager adds it to the database with its textures.");
        }

        public Task<string> UpdatesAsync() => Task.FromResult("The material database is v1.3: no update since you last checked.");
    }
}
