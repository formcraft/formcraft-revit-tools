using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class LinkLine
    {
        public LinkLine(long id, string model, bool pinned, bool loaded, string workset, IReadOnlyList<string> problems)
        {
            Id = id; Model = model; Pinned = pinned; Loaded = loaded; Workset = workset; Problems = problems;
        }
        public long Id { get; }
        public string Model { get; }
        public bool Pinned { get; }
        public bool Loaded { get; }
        public string Workset { get; }
        public IReadOnlyList<string> Problems { get; }
        public string State => Problems.Count == 0 ? "OK" : "Fix";
    }

    public sealed class LinkCandidate
    {
        public LinkCandidate(string path, string name, string role, bool linked, bool own)
        {
            Path = path; Name = name; Role = role; Linked = linked; Own = own;
        }
        public string Path { get; }
        public string Name { get; }
        public string Role { get; }
        public bool Linked { get; }
        public bool Own { get; }
    }

    public sealed class LinkAudit
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Model { get; set; } = "";
        public bool Workshared { get; set; }
        public string Site { get; set; } = "";
        public string Crs { get; set; } = "";
        public string Easting { get; set; } = "";
        public string Northing { get; set; } = "";
        public string Elevation { get; set; } = "";
        public string Angle { get; set; } = "";
        public List<LinkLine> Links { get; } = new List<LinkLine>();
        public List<LinkCandidate> Candidates { get; } = new List<LinkCandidate>();
        public string FolderProblem { get; set; } = "";
    }

    /// <summary>Team › Links: fmc_links through the server (coordinates, the links audit, link and pin).</summary>
    public interface ILinkTools
    {
        Task<LinkAudit> AuditAsync(string linkFrom);
        Task<ToolResult> LinkAsync(IReadOnlyList<string> models, bool pin, bool dryRun);
        Task<ToolResult> PinAsync(bool dryRun);
    }

    /// <summary>Sample values from board manage/PaneLinks.</summary>
    public sealed class MockLinkTools : ILinkTools
    {
        public List<string> Folders { get; } = new List<string>();
        public List<(IReadOnlyList<string> Models, bool Dry)> Linked { get; } = new List<(IReadOnlyList<string>, bool)>();
        public List<bool> Pins { get; } = new List<bool>();

        public Task<LinkAudit> AuditAsync(string linkFrom)
        {
            Folders.Add(linkFrom);
            var a = new LinkAudit { Ok = true, Model = "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", Workshared = true, Site = "Internal", Crs = "Arc 1960 / UTM zone 36S (EPSG:21036)",
                Easting = "0", Northing = "0", Elevation = "0", Angle = "0.00", Message = "3 links, 1 to fix." };
            a.Links.Add(new LinkLine(11, "F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", true, true, "Z_Links_S", new string[0]));
            a.Links.Add(new LinkLine(12, "F26001-FMC-ZZ-ZZ-M3-M-0001.rvt", false, true, "Z_Links_M", new[] { "not pinned" }));
            a.Links.Add(new LinkLine(13, "F26001-FMC-ZZ-ZZ-M3-Z-0001.rvt", true, true, "Z_Links_Z", new string[0]));
            if (linkFrom.Length > 0)
                a.Candidates.AddRange(new[]
                {
                    new LinkCandidate(linkFrom + @"\A\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", "A", false, true),
                    new LinkCandidate(linkFrom + @"\E\F26001-FMC-ZZ-ZZ-M3-E-0001.rvt", "F26001-FMC-ZZ-ZZ-M3-E-0001.rvt", "E", false, false),
                    new LinkCandidate(linkFrom + @"\S\F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", "F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", "S", true, false),
                });
            return Task.FromResult(a);
        }

        public Task<ToolResult> LinkAsync(IReadOnlyList<string> models, bool pin, bool dryRun)
        {
            Linked.Add((models, dryRun));
            var r = new ToolResult { Ok = true, Count = models.Count };
            if (dryRun) r.Details.AddRange(models.Select(m => System.IO.Path.GetFileName(m) + ": would link by shared coordinates" + (pin ? " and pin" : "")));
            else r.Messages.Add(new ToolMessage(ChipKind.Good, models.Count + " models linked by shared coordinates" + (pin ? " and pinned." : ".")));
            return Task.FromResult(r);
        }

        public Task<ToolResult> PinAsync(bool dryRun)
        {
            Pins.Add(dryRun);
            var r = new ToolResult { Ok = true, Count = 1 };
            if (dryRun) r.Details.Add("F26001-FMC-ZZ-ZZ-M3-M-0001.rvt");
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "1 link pinned."));
            return Task.FromResult(r);
        }
    }
}
