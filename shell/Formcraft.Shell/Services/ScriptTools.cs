using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One script in the kit's 05_Scripts, as its own header describes it (fmc_scripts list).</summary>
    public sealed class ScriptInfo
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public string File { get; set; } = "";
        public string Does { get; set; } = "";
        public string Status { get; set; } = "";
        public string Manual { get; set; } = "";
        public List<string> Inputs { get; } = new List<string>();
        public bool ChangesModel { get; set; }
        public string RunsIn { get; set; } = "";
        /// <summary>The Formcraft section that does the same job (with a dry run), or "".</summary>
        public string Formcraft { get; set; } = "";
    }

    /// <summary>What an automation run did, step by step; it stops at the first step that fails.</summary>
    public sealed class AutomationRun
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public List<(string Title, bool Ok, string Summary)> Steps { get; } = new List<(string, bool, string)>();
        public List<string> Skipped { get; } = new List<string>();
    }

    /// <summary>An automation: Formcraft's own checks in a row, run by hand.</summary>
    public sealed class Automation
    {
        public Automation(string name, params string[] steps) { Name = name; Steps = steps.ToList(); }
        public string Name { get; }
        public List<string> Steps { get; }
    }

    /// <summary>Check › Scripts (U24): fmc_scripts through the server.</summary>
    public interface IScriptTools
    {
        Task<(bool Ok, string Message, List<ScriptInfo> Scripts)> ListAsync(string kitFolder);
        Task<AutomationRun> RunAsync(Automation automation, string kitFolder, string projectFolder, string projectCode);
    }

    public static class AutomationSteps
    {
        /// <summary>The steps an automation can chain, as fmc_scripts names them. None changes the model.</summary>
        public static readonly IReadOnlyList<(string Id, string Title)> All = new[]
        {
            ("selftest", "Self-test (connection, add-in, kit)"),
            ("qa", "QA check (the gate's rules)"),
            ("links", "Links audit"),
            ("workshare", "Workshare check"),
            ("annotate", "Annotation check (current view)"),
            ("review", "Open review items"),
            ("report", "Weekly project report (Markdown and CSV)"),
            // Hub step T: kit tables by script. Both only read; the real import is a person's yes (fmc_tables import).
            ("tables", "Kit tables check (the kit's Excel against its CSV and JSON)"),
            ("tables_import", "Edited kit tables (dry run of the workbooks in staging)"),
        };

        public static string Title(string id) => All.FirstOrDefault(s => s.Id == id).Title ?? id;
        public static string Id(string title) => All.FirstOrDefault(s => s.Title == title).Id ?? title;

        public static readonly IReadOnlyList<Automation> Defaults = new[]
        {
            new Automation("Before sync", "selftest", "qa", "workshare"),
            new Automation("Model check", "selftest", "links", "annotate", "qa"),
            new Automation("Friday issue prep", "qa", "review", "report"),
            new Automation("Kit tables (dry run)", "tables", "tables_import"),
        };
    }

    /// <summary>Sample values from board model/PaneScripts.</summary>
    public sealed class MockScriptTools : IScriptTools
    {
        public List<Automation> Ran { get; } = new List<Automation>();
        public string? FailAt { get; set; }

        public Task<(bool Ok, string Message, List<ScriptInfo> Scripts)> ListAsync(string kitFolder)
        {
            var list = new List<ScriptInfo>
            {
                new ScriptInfo { Name = "FMC_CreateSheetsFromRegister", Type = "pyRevit", Status = "PILOT-TEST before production (Manual Part 17)", ChangesModel = true,
                    Does = "Creates a role's sheets from FMC_Sheet_Register.csv; never deletes or renames", RunsIn = "pyRevit › FMC tab › Create Sheets from Register",
                    Formcraft = "Drawings › Sheets (Create, dry run first)" },
                new ScriptInfo { Name = "FMC_ModelHealth", Type = "Dynamo (Python node)", Status = "Pilot test before production", Does = "Measures the model against the BEP thresholds",
                    RunsIn = "Dynamo Player (a Python Script node in a graph)", Formcraft = "Check › QA", Manual = "Manual Part 14.2" },
                new ScriptInfo { Name = "fmc_boq_build", Type = "Python tool", Status = "Not stated in the file", Does = "Formcraft BoQ builder (Manual Part 11)", RunsIn = "python fmc_boq_build.py (outside Revit)" },
            };
            list[1].Inputs.AddRange(new[] { "IN[0] String - output folder", "IN[1] String - full path to FMC_Master_Data.json" });
            return Task.FromResult((true, list.Count + " scripts in the kit's 05_Scripts.", list));
        }

        public Task<AutomationRun> RunAsync(Automation automation, string kitFolder, string projectFolder, string projectCode)
        {
            Ran.Add(automation);
            var run = new AutomationRun { Ok = true };
            foreach (var s in automation.Steps)
            {
                bool ok = s != FailAt;
                run.Steps.Add((AutomationSteps.Title(s), ok, ok ? "done (sample)" : "Revit isn't reachable (sample)"));
                if (!ok) { run.Ok = false; run.Skipped.AddRange(automation.Steps.SkipWhile(x => x != s).Skip(1).Select(AutomationSteps.Title)); break; }
            }
            run.Message = run.Ok ? "Every step ran." : "Stopped at " + run.Steps.Last().Title + ".";
            return Task.FromResult(run);
        }
    }
}
