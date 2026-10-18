using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>A brand pack from the kit (06_Templates\FMC_BrandPacks.json): the fonts a template's text takes.</summary>
    [DataContract]
    public sealed class BrandPack
    {
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "main_font")] public string MainFont { get; set; } = "";
        [DataMember(Name = "title_font")] public string TitleFont { get; set; } = "";
    }

    [DataContract]
    internal sealed class BrandPackFile
    {
        [DataMember(Name = "packs")] public List<BrandPack>? Packs { get; set; }
    }

    /// <summary>A template in the kit's library: released in 06_Templates, or waiting in 06_Templates\_Staging.</summary>
    public sealed class KitTemplate
    {
        public KitTemplate(string path, bool staging)
        {
            Path = path;
            Name = System.IO.Path.GetFileNameWithoutExtension(path);
            var m = Regex.Match(Name, @"^(.*?)_v(\d+(\.\d+)*)$");
            Family = m.Success ? m.Groups[1].Value : Name;
            Version = m.Success ? m.Groups[2].Value : "—";
            Staging = staging;
        }

        public string Path { get; }
        public string Name { get; }
        /// <summary>The template without its version, e.g. FMC_A_Template.</summary>
        public string Family { get; }
        public string Version { get; }
        public bool Staging { get; }
        public string Status => Staging ? "Staging" : "Released";
    }

    /// <summary>Reads the kit's templates and brand packs (rule 7: kit data comes from the kit, never from code).</summary>
    public static class KitLibrary
    {
        public static IReadOnlyList<KitTemplate> Templates(string kitFolder)
        {
            var list = new List<KitTemplate>();
            var dir = Path.Combine(kitFolder ?? "", "06_Templates");
            try
            {
                if (Directory.Exists(dir)) list.AddRange(Directory.GetFiles(dir, "*.rte").Select(f => new KitTemplate(f, false)));
                var staging = Path.Combine(dir, "_Staging");
                if (Directory.Exists(staging)) list.AddRange(Directory.GetFiles(staging, "*.rte").Select(f => new KitTemplate(f, true)));
            }
            catch { /* an unreachable kit lists nothing; Connect's health check says why */ }
            return list.OrderBy(t => t.Family).ThenByDescending(t => t.Version).ToList();
        }

        public static IReadOnlyList<BrandPack> BrandPacks(string kitFolder)
        {
            try
            {
                var file = Path.Combine(kitFolder ?? "", "06_Templates", "FMC_BrandPacks.json");
                if (!File.Exists(file)) return new BrandPack[0];
                using (var s = File.OpenRead(file))
                {
                    var data = (BrandPackFile?)new DataContractJsonSerializer(typeof(BrandPackFile)).ReadObject(s);
                    return data?.Packs?.Where(p => p.Name.Length > 0 && p.MainFont.Length > 0).ToList() ?? new List<BrandPack>();
                }
            }
            catch { return new BrandPack[0]; }
        }
    }

    /// <summary>One line of a template audit: area, severity (Must, Should, Advice, Pass), status and detail.</summary>
    public sealed class AuditLine
    {
        public AuditLine(string area, string severity, string status, string detail)
        {
            Area = area; Severity = severity; Status = status; Detail = detail;
        }
        public string Area { get; }
        public string Severity { get; }
        public string Status { get; }
        public string Detail { get; }
        public ChipKind Kind => Severity switch { "Must" => ChipKind.Bad, "Should" => ChipKind.Warn, "Advice" => ChipKind.Info, _ => ChipKind.Good };
    }

    public sealed class AuditResult
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public List<AuditLine> Lines { get; } = new List<AuditLine>();
    }

    /// <summary>Setup › Templates: fmc_template through the server (audit; brand pack with a dry run first).</summary>
    /// <summary>The base template's recipe read from the kit (fmc_template recipe): counts per kind and the readings made.</summary>
    public sealed class TemplateRecipe
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Kit { get; set; } = "";
        public List<(string Kind, int Count)> Counts { get; } = new List<(string, int)>();
        public List<string> Readings { get; } = new List<string>();
        public List<string> Roles { get; } = new List<string>();
    }

    /// <summary>What a template lacks against the recipe (fmc_template compare).</summary>
    public sealed class TemplateCompare
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public bool Matches { get; set; }
        public List<(string Kind, int Missing, string Examples)> Missing { get; } = new List<(string, int, string)>();
    }

    public interface ITemplateTools
    {
        Task<AuditResult> AuditAsync(string templatePath, BrandPack? brand);
        Task<ToolResult> BrandAsync(string templatePath, BrandPack brand, bool dryRun);
        /// <summary>Templates as data (U29): the base recipe read from the kit; nothing is changed.</summary>
        Task<TemplateRecipe> RecipeAsync(string kitFolder);
        Task<TemplateCompare> CompareAsync(string templatePath, string kitFolder);
        /// <summary>Builds the template in staging from the recipe (from the seed when it doesn't exist yet); a dry run unless dryRun is false.</summary>
        Task<ToolResult> BuildAsync(string templatePath, string kitFolder, string seedPath, bool roleCopies, bool dryRun);
    }

    public sealed class MockTemplateTools : ITemplateTools
    {
        public List<(string Path, bool Dry)> Brands { get; } = new List<(string, bool)>();
        public List<(string Path, bool Dry, bool Copies)> Builds { get; } = new List<(string, bool, bool)>();

        public Task<TemplateRecipe> RecipeAsync(string kitFolder)
        {
            var r = new TemplateRecipe { Ok = true, Kit = "FMC_Kit 2.2 r4", Message = "Read from the kit: 13 kinds." };
            r.Counts.AddRange(new[] { ("Parameters", 171), ("Text types", 7), ("Line patterns", 6), ("Fill patterns", 12), ("Filters", 42), ("View templates", 81), ("Schedules", 10) });
            r.Readings.Add("FMC_Solid: Revit allows one solid fill, so the built-in <Solid fill> stands in");
            r.Readings.Add("Line weights: no Revit API sets them; set by hand once in the template");
            r.Roles.AddRange(new[] { "Z", "A", "S", "E", "M", "P" });
            return Task.FromResult(r);
        }

        public Task<TemplateCompare> CompareAsync(string templatePath, string kitFolder)
        {
            var c = new TemplateCompare { Ok = true, Matches = false, Message = "2 names missing." };
            c.Missing.Add(("view_templates", 2, "VT_W_SitePlan_Phase, VT_W_3D_Logistics"));
            return Task.FromResult(c);
        }

        public Task<ToolResult> BuildAsync(string templatePath, string kitFolder, string seedPath, bool roleCopies, bool dryRun)
        {
            Builds.Add((templatePath, dryRun, roleCopies));
            var r = new ToolResult { Ok = true };
            if (dryRun) { r.Details.AddRange(new[] { "units_params: 171 parameters", "filters: 42", "view_templates: 81 (first slice shown)" }); r.Count = 3; }
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "Built in staging. Compare, then audit; publishing is a request to the BIM Manager."));
            return Task.FromResult(r);
        }

        public Task<AuditResult> AuditAsync(string templatePath, BrandPack? brand)
        {
            var r = new AuditResult { Ok = true, Message = "Audited " + Path.GetFileName(templatePath) + "." };
            r.Lines.Add(new AuditLine("Shared parameters vs FMC_SharedParameters.txt", "Must", "2 differ", "Same name, different GUID: FMC_Asset_Tag, FMC_Room_Code"));
            r.Lines.Add(new AuditLine("View templates and filters", "Pass", "Pass", "40 view templates · 22 filters"));
            // F-044: the sample follows the server's audit: both ways, and a check that can't run says Not checked
            r.Lines.Add(new AuditLine("Kit parameters in the template (FMC_Master_Data.json)", "Must", "10 missing", "170 of 180 present; missing FMC_Building_Class, FMC_GFA_m2…"));
            if (brand != null) r.Lines.Add(new AuditLine("Fonts vs the brand pack (" + brand.Name + ")", "Should", "1 off-brand", "Text Generic 2.5: Times New Roman"));
            else r.Lines.Add(new AuditLine("Fonts vs the brand pack", "Advice", "Not checked", "The kit has no font pack (06_Templates\\FMC_BrandPacks.json): a kit change request"));
            r.Lines.Add(new AuditLine("Text and dimension styles", "Advice", "14 + 6", "14 text types, 6 dimension types"));
            r.Lines.Add(new AuditLine("Title blocks vs the Family Register", "Must", "4 kit title blocks missing", "missing FMC_TitleBlock (P1), FMC_TB_Panel_ProjectData (P1)…; loaded instead: A1 metric, A0 metric"));
            r.Lines.Add(new AuditLine("Legends vs the sheet register", "Should", "2 missing", "8 of 10; missing LG_Z_Abbreviations, LG_Z_Symbols"));
            r.Lines.Add(new AuditLine("Materials: the kit's FMC_ materials", "Should", "None from the kit", "158 materials, none of the kit's 167"));
            r.Lines.Add(new AuditLine("Size, unused families, warnings", "Advice", "38 MB · 12 unused", "38 MB · 12 of 60 families unused · 4 warnings"));
            return Task.FromResult(r);
        }

        public Task<ToolResult> BrandAsync(string templatePath, BrandPack brand, bool dryRun)
        {
            Brands.Add((templatePath, dryRun));
            var r = new ToolResult { Ok = true, Count = 2 };
            if (dryRun) r.Details.AddRange(new[] { "Text: Generic 2.5   Times New Roman → " + brand.MainFont, "Text: FMC_Title_5   Arial → " + brand.TitleFont });
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "Brand pack " + brand.Name + " applied to 2 types. Logged in FMC_MCP_FileLog.csv."));
            return Task.FromResult(r);
        }
    }
}
