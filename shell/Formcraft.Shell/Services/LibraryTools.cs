using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One check on a family: what was checked, pass, fail or not applicable, and why.</summary>
    public sealed class FamilyCheckLine
    {
        public FamilyCheckLine(string check, string state, string detail) { Check = check; State = state; Detail = detail; }
        public string Check { get; }
        public string State { get; }
        public string Detail { get; }
        public ChipKind Kind => State == "pass" ? ChipKind.Good : State == "fail" ? ChipKind.Bad : ChipKind.Grey;
        public string StatusText => State == "pass" ? "Pass" : State == "fail" ? "Fail" : "—";
    }

    /// <summary>A family against the kit: score, Compliant / Fixable / Needs a person, the checks and the next step.</summary>
    public sealed class FamilyVerdict
    {
        public FamilyVerdict(string name, string category, string from, int score, string state, IReadOnlyList<FamilyCheckLine> checks, string next)
        {
            Name = name; Category = category; From = from; Score = score; State = state; Checks = checks; Next = next;
        }
        public string Name { get; }
        public string Category { get; }
        public string From { get; }
        public int Score { get; }
        public string State { get; }
        public IReadOnlyList<FamilyCheckLine> Checks { get; }
        public string Next { get; }
        public ChipKind Kind => State == "Compliant" ? ChipKind.Good : State == "Fixable" ? ChipKind.Warn : ChipKind.Bad;
    }

    public sealed class ScanResult
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string Document { get; set; } = "";
        public List<FamilyVerdict> Families { get; } = new List<FamilyVerdict>();
        public List<(string Check, int Fail)> ByCheck { get; } = new List<(string, int)>();
        public int Compliant => Families.Count(f => f.State == "Compliant");
        public int Fixable => Families.Count(f => f.State == "Fixable");
        public int NeedAPerson => Families.Count(f => f.State == "Needs a person");
    }

    /// <summary>An outside family checked before it is brought in: its verdict and what the bring-in would do.</summary>
    public sealed class BringInPlan
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public FamilyVerdict? Verdict { get; set; }
        public string ProposedName { get; set; } = "";
        public string SavePath { get; set; } = "";
        public List<string> AddParameters { get; } = new List<string>();
        public double SizeMb { get; set; }
        public int ImportedCad { get; set; }
    }

    public sealed class KitParameter
    {
        public KitParameter(string name, string group, string datatype) { Name = name; Group = group; Datatype = datatype; }
        public string Name { get; }
        public string Group { get; }
        public string Datatype { get; }
    }

    public sealed class KeynoteEntry
    {
        public KeynoteEntry(string code, string description) { Code = code; Description = description; }
        public string Code { get; }
        public string Description { get; }
    }

    public sealed class KeynoteSearch
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public string File { get; set; } = "";
        public List<string> Groups { get; } = new List<string>();
        public List<KeynoteEntry> Keynotes { get; } = new List<KeynoteEntry>();
        public string NextCode { get; set; } = "";
    }

    /// <summary>Setup › Families against the kit: fmc_library through the server, the same code any AI app runs.</summary>
    public interface ILibraryTools
    {
        Task<ScanResult> ScanAsync();
        Task<BringInPlan> InspectAsync(string path, string role, string description, string keynote);
        Task<ToolResult> BringInAsync(string path, string role, string description, string keynote, bool dryRun);
        Task<IReadOnlyList<KitParameter>> ParametersAsync(string query);
        Task<KeynoteSearch> KeynotesAsync(string query, string group);
        Task<string> RequestKeynoteAsync(string group, string text);
    }

    /// <summary>Sample values from board manage/PaneFamilies.</summary>
    public sealed class MockLibraryTools : ILibraryTools
    {
        public List<(string Path, bool Dry)> BringIns { get; } = new List<(string, bool)>();
        public List<string> Requests { get; } = new List<string>();

        private static FamilyCheckLine C(string check, string state, string detail) => new FamilyCheckLine(check, state, detail);

        public Task<ScanResult> ScanAsync()
        {
            var r = new ScanResult { Ok = true, Document = "F26001-FMC-ZZ-ZZ-M3-E-0001.rvt", Message = "Scanned 3 families." };
            r.Families.Add(new FamilyVerdict("FMC_E_ElecFixture_SocketDouble", "Electrical Fixtures", "Loaded", 100, "Compliant",
                new[] { C("Name follows FMC_[Role]_[Category]_[Description]", "pass", ""), C("Keynote set", "pass", "") }, "Nothing: it meets the Families rulebook"));
            r.Families.Add(new FamilyVerdict("F26001_E_ElecFixture_Isolator", "Electrical Fixtures", "Loaded", 67, "Fixable",
                new[] { C("Keynote set", "fail", "1 of 1 types have no keynote") }, "Bring it in again: rename, add the kit's parameters and set the keynote in one pass"));
            r.Families.Add(new FamilyVerdict("Vendor_Socket_MK", "Electrical Fixtures", "Loaded", 41, "Needs a person",
                new[] { C("Name follows FMC_[Role]_[Category]_[Description]", "fail", "Vendor_Socket_MK doesn't follow the kit's naming rule"),
                        C("Required FMC parameters present (by GUID)", "na", "The kit has no spec for this family") }, "The kit has no spec for this family"));
            r.ByCheck.Add(("Name follows FMC_[Role]_[Category]_[Description]", 1));
            r.ByCheck.Add(("Required FMC parameters present (by GUID)", 0));
            r.ByCheck.Add(("Keynote set", 1));
            return Task.FromResult(r);
        }

        public Task<BringInPlan> InspectAsync(string path, string role, string description, string keynote)
        {
            var p = new BringInPlan
            {
                Ok = true, SizeMb = 0.8, ImportedCad = 0,
                ProposedName = role.Length > 0 && description.Length > 0 ? "FMC_" + role + "_ElecFixture_" + string.Concat(description.Split(' ').Select(w => w.Length > 0 ? char.ToUpper(w[0]) + w.Substring(1) : w)) : "",
                Verdict = new FamilyVerdict(System.IO.Path.GetFileNameWithoutExtension(path), "Electrical Fixtures", "Outside file", 41, "Needs a person",
                    new[] { C("Name follows FMC_[Role]_[Category]_[Description]", "fail", "doesn't follow the naming rule") }, "Bring it in"),
            };
            p.SavePath = p.ProposedName.Length > 0 ? @"Z:\00_Standards\04_Families\_Staging\" + role + @"\" + p.ProposedName + ".rfa" : "";
            p.AddParameters.AddRange(new[] { "FMC_Asset_Tag", "FMC_Mounting_Height_mm" });
            return Task.FromResult(p);
        }

        public Task<ToolResult> BringInAsync(string path, string role, string description, string keynote, bool dryRun)
        {
            BringIns.Add((path, dryRun));
            var r = new ToolResult { Ok = true, Count = 1 };
            if (dryRun) r.Details.AddRange(new[] { "Rename → FMC_" + role + "_ElecFixture_SocketMk", "Add FMC_Asset_Tag, FMC_Mounting_Height_mm", "Keynote " + keynote, @"Save to 04_Families\_Staging\" + role });
            else r.Messages.Add(new ToolMessage(ChipKind.Good, "Brought in FMC_" + role + "_ElecFixture_SocketMk to staging. Release stays with the Family Librarian."));
            return Task.FromResult(r);
        }

        public Task<IReadOnlyList<KitParameter>> ParametersAsync(string query) => Task.FromResult<IReadOnlyList<KitParameter>>(new[]
        {
            new KitParameter("FMC_Asset_Tag", "Asset", "TEXT"), new KitParameter("FMC_Mounting_Height_mm", "Electrical", "LENGTH"),
            new KitParameter("FMC_Keynote_Code", "Element Code", "TEXT"),
        }.Where(p => query.Length == 0 || p.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0).ToList());

        public Task<KeynoteSearch> KeynotesAsync(string query, string group)
        {
            var r = new KeynoteSearch { Ok = true, File = @"Z:\00_Standards\02_Keynotes\FMC_Keynotes.txt", NextCode = (group.Length > 0 ? group : "E.SOC") + "_04" };
            r.Groups.AddRange(new[] { "E.SOC", "E.LED", "P.WCS" });
            r.Keynotes.AddRange(new[]
            {
                new KeynoteEntry("E.SOC_00", "13 A twin switched socket outlet, flush"), new KeynoteEntry("E.SOC_01", "13 A single switched socket outlet, flush"),
                new KeynoteEntry("E.SOC_02", "45 A cooker control unit with socket"), new KeynoteEntry("E.SOC_03", "15 A industrial socket outlet"),
            }.Where(k => query.Length == 0 || k.Description.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || k.Code.Contains(query)));
            return Task.FromResult(r);
        }

        public Task<string> RequestKeynoteAsync(string group, string text)
        {
            Requests.Add(group + ": " + text);
            return Task.FromResult("Requested " + group + "_04. The BIM Manager approves it into the kit's keynote file.");
        }
    }
}
