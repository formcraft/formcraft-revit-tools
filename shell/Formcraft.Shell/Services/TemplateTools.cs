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
    public interface ITemplateTools
    {
        Task<AuditResult> AuditAsync(string templatePath, BrandPack? brand);
        Task<ToolResult> BrandAsync(string templatePath, BrandPack brand, bool dryRun);
    }

    public sealed class MockTemplateTools : ITemplateTools
    {
        public List<(string Path, bool Dry)> Brands { get; } = new List<(string, bool)>();

        public Task<AuditResult> AuditAsync(string templatePath, BrandPack? brand)
        {
            var r = new AuditResult { Ok = true, Message = "Audited " + Path.GetFileName(templatePath) + "." };
            r.Lines.Add(new AuditLine("Shared parameters vs FMC_SharedParameters.txt", "Must", "2 differ", "Same name, different GUID: FMC_Asset_Tag, FMC_Room_Code"));
            r.Lines.Add(new AuditLine("View templates and filters", "Pass", "Pass", "40 view templates · 22 filters"));
            if (brand != null) r.Lines.Add(new AuditLine("Fonts vs the brand pack (" + brand.Name + ")", "Should", "1 off-brand", "Text Generic 2.5: Times New Roman"));
            r.Lines.Add(new AuditLine("Text and dimension styles", "Advice", "14 + 6", "14 text types, 6 dimension types"));
            r.Lines.Add(new AuditLine("Title blocks and schedules", "Pass", "Pass", "2 title block types · 12 schedules"));
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
