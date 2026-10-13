using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Formcraft.Shell.Services
{
    /// <summary>A parts switch: a module's piece of the pane a person can hide (each module's Settings tab).</summary>
    [DataContract]
    public sealed class PartDef
    {
        [DataMember(Name = "id")] public string Id { get; set; } = "";
        [DataMember(Name = "module")] public string ModuleName { get; set; } = "";
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        public FmcModule Module => (FmcModule)Enum.Parse(typeof(FmcModule), ModuleName);
    }

    [DataContract]
    public sealed class SectionDef
    {
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "module")] public string ModuleName { get; set; } = "";
        [DataMember(Name = "tag")] public string? Tag { get; set; }
        /// <summary>Shown while any of these parts is on (none: always).</summary>
        [DataMember(Name = "parts")] public string[]? Parts { get; set; }
        /// <summary>The module tag shows while any of these parts is on (none: always).</summary>
        [DataMember(Name = "tagParts")] public string[]? TagParts { get; set; }
        [DataMember(Name = "phase")] public string Phase { get; set; } = "";
        /// <summary>Board file under design/boards, without ".dc.html".</summary>
        [DataMember(Name = "board")] public string Board { get; set; } = "";
        public FmcModule Module => (FmcModule)Enum.Parse(typeof(FmcModule), ModuleName);
        public string IconKey => "Icon." + Name;
    }

    [DataContract]
    public sealed class GroupDef
    {
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "parts")] public string[]? Parts { get; set; }
        [DataMember(Name = "sections")] public SectionDef[] Sections { get; set; } = new SectionDef[0];
    }

    [DataContract]
    public sealed class QuickToolDef
    {
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "parts")] public string[]? Parts { get; set; }
    }

    /// <summary>
    /// Every group, section, quick tool and parts switch of the pane, from sections.json (embedded). The shell builds
    /// its navigation from this; search (U04) and the ribbon (U10) read the same list.
    /// </summary>
    [DataContract]
    public sealed class SectionRegistry
    {
        [DataMember(Name = "parts")] public PartDef[] Parts { get; set; } = new PartDef[0];
        [DataMember(Name = "groups")] public GroupDef[] Groups { get; set; } = new GroupDef[0];
        [DataMember(Name = "quickTools")] public QuickToolDef[] QuickTools { get; set; } = new QuickToolDef[0];

        public IEnumerable<SectionDef> Sections => Groups.SelectMany(g => g.Sections);

        public PartDef Part(string id) =>
            Parts.FirstOrDefault(p => p.Id == id) ?? throw new KeyNotFoundException("No part '" + id + "' in sections.json");

        /// <summary>The registry shipped in Formcraft.Shell.dll.</summary>
        public static SectionRegistry Default { get; } = LoadEmbedded();

        public static SectionRegistry LoadEmbedded()
        {
            using var stream = typeof(SectionRegistry).Assembly.GetManifestResourceStream("Formcraft.Shell.sections.json")
                ?? throw new InvalidOperationException("sections.json is not embedded in Formcraft.Shell");
            return Load(stream);
        }

        public static SectionRegistry Load(Stream json)
        {
            var registry = (SectionRegistry?)new DataContractJsonSerializer(typeof(SectionRegistry)).ReadObject(json)
                ?? throw new InvalidDataException("sections.json is empty");
            registry.Validate();
            return registry;
        }

        public static SectionRegistry Load(string json) => Load(new MemoryStream(Encoding.UTF8.GetBytes(json)));

        /// <summary>Fails early on a typo: unknown module, unknown part, duplicate name.</summary>
        public void Validate()
        {
            var errors = new List<string>();
            var modules = Enum.GetNames(typeof(FmcModule));
            var partIds = new HashSet<string>();
            foreach (var p in Parts)
            {
                if (!partIds.Add(p.Id)) errors.Add("Duplicate part " + p.Id);
                if (!modules.Contains(p.ModuleName)) errors.Add($"Part {p.Id}: unknown module {p.ModuleName}");
            }

            void CheckParts(string where, string[]? ids)
            {
                foreach (var id in ids ?? new string[0])
                    if (!partIds.Contains(id)) errors.Add($"{where}: unknown part {id}");
            }

            var names = new HashSet<string>();
            foreach (var g in Groups)
            {
                CheckParts("Group " + g.Name, g.Parts);
                if (g.Sections == null || g.Sections.Length == 0)
                {
                    errors.Add("Group " + g.Name + " has no sections");
                    continue;
                }
                foreach (var s in g.Sections)
                {
                    if (!names.Add(s.Name)) errors.Add("Duplicate section " + s.Name);
                    if (!modules.Contains(s.ModuleName)) errors.Add($"Section {s.Name}: unknown module {s.ModuleName}");
                    if (string.IsNullOrEmpty(s.Board)) errors.Add($"Section {s.Name}: no board");
                    CheckParts("Section " + s.Name, s.Parts);
                    CheckParts("Section " + s.Name + " tag", s.TagParts);
                }
            }
            foreach (var t in QuickTools) CheckParts("Quick tool " + t.Name, t.Parts);

            if (errors.Count > 0) throw new InvalidDataException("sections.json: " + string.Join("; ", errors));
        }
    }
}
