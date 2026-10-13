using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;

namespace Formcraft.Shell.Services
{
    /// <summary>One line of the kit check (board account/PaneWelcome): what was looked for, and a chip.</summary>
    public sealed class KitCheckLine
    {
        public KitCheckLine(string label, bool found, string status, ChipKind kind)
        {
            Label = label;
            Found = found;
            Status = status;
            Kind = kind;
        }

        public string Label { get; }
        public bool Found { get; }
        public string Status { get; }
        public ChipKind Kind { get; }
    }

    public sealed class KitCheck
    {
        public KitCheck(string folder, IReadOnlyList<KitCheckLine> lines, bool kitFound, bool isSample)
        {
            Folder = folder;
            Lines = lines;
            KitFound = kitFound;
            IsSample = isSample;
        }

        public string Folder { get; }
        public IReadOnlyList<KitCheckLine> Lines { get; }
        /// <summary>The folder is a Formcraft kit (its FMC_Kit.json was read).</summary>
        public bool KitFound { get; }
        public bool IsSample { get; }
        public bool AllGood => Lines.Count > 0 && System.Linq.Enumerable.All(Lines, l => l.Found);
    }

    /// <summary>Checks a kit folder. Reads what is in the kit; never makes kit data up (CLAUDE.md rule 7).</summary>
    public interface IKitService
    {
        KitCheck Check(string folder);
    }

    /// <summary>
    /// Looks at the folder on disk. Paths follow fmc_guard.example.json: 01_Shared_Parameters\FMC_SharedParameters.txt and
    /// the _Staging write folders. The kit and rulebook versions come from FMC_Kit.json at the kit root
    /// (decision for U05, to confirm against the real kit: a kit change request if it is named differently).
    /// </summary>
    public sealed class FolderKitService : IKitService
    {
        [DataContract]
        private sealed class Manifest
        {
            [DataMember(Name = "kit")] public string? Kit { get; set; }
            [DataMember(Name = "rulebooks")] public string? Rulebooks { get; set; }
            [DataMember(Name = "sample")] public bool Sample { get; set; }
        }

        public KitCheck Check(string folder)
        {
            var lines = new List<KitCheckLine>();
            folder = (folder ?? "").Trim();
            if (folder.Length == 0 || !Directory.Exists(folder))
            {
                lines.Add(new KitCheckLine("No folder at this path", false, "Missing", ChipKind.Bad));
                return new KitCheck(folder, lines, false, false);
            }

            Manifest? manifest = null;
            var manifestPath = Path.Combine(folder, "FMC_Kit.json");
            if (File.Exists(manifestPath))
            {
                try
                {
                    using var file = File.OpenRead(manifestPath);
                    manifest = (Manifest?)new DataContractJsonSerializer(typeof(Manifest)).ReadObject(file);
                }
                catch (SerializationException)
                {
                    manifest = null;
                }
            }

            var sample = manifest?.Sample == true ? " (sample)" : "";
            lines.Add(manifest?.Kit is string kit
                ? new KitCheckLine("FMC Kit v" + kit + " found" + sample, true, "OK", ChipKind.Good)
                : new KitCheckLine("No Formcraft kit here (FMC_Kit.json)", false, "Missing", ChipKind.Bad));

            var sharedParameters = File.Exists(Path.Combine(folder, "01_Shared_Parameters", "FMC_SharedParameters.txt"));
            lines.Add(new KitCheckLine("Shared parameters file", sharedParameters, sharedParameters ? "OK" : "Missing", sharedParameters ? ChipKind.Good : ChipKind.Bad));

            lines.Add(manifest?.Rulebooks is string rb
                ? new KitCheckLine("Rulebooks v" + rb, true, "OK", ChipKind.Good)
                : new KitCheckLine("Rulebooks", false, "Not listed", ChipKind.Warn));

            var write = Directory.Exists(Path.Combine(folder, "04_Families", "_Staging")) && Directory.Exists(Path.Combine(folder, "06_Templates", "_Staging"));
            lines.Add(new KitCheckLine("Write folders (01_WIP, _Staging)", write, write ? "OK" : "Missing", write ? ChipKind.Good : ChipKind.Warn));

            return new KitCheck(folder, lines, manifest?.Kit != null, manifest?.Sample == true);
        }
    }
}
