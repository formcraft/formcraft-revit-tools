using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U25: Engineer › Systems and Structural (boards model/PaneModelSystems, PaneModelStructural).</summary>
    public class SystemsPagesTests
    {
        private static (ShellViewModel Vm, MockSystemTools Tools) Pane(string section)
        {
            var tools = new MockSystemTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            s.Set("settings.project.folder", @"Z:\Projects\F26001");
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), systems: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == section));
            return (vm, tools);
        }

        [Test]
        public async Task Statuses_are_honest_no_system_is_done_yet()
        {
            var done = SystemCapabilities.Systems.Values.SelectMany(x => x).Select(SystemCapabilities.Done).Max();
            await Assert.That(done).IsEqualTo(0);
            await Assert.That(SystemCapabilities.Status("Power distribution", "1 Enrich")).IsEqualTo("Planned");
            await Assert.That(SystemCapabilities.Status("Power distribution", "3 Diagram")).IsEqualTo("Built, Revit check due");
            await Assert.That(SystemCapabilities.Status("Drainage", "4 Calculate")).IsEqualTo("Built, Revit check due");
            await Assert.That(SystemCapabilities.Status("Structural", "Diagram")).IsEqualTo("Not applicable");
            await Assert.That(SystemCapabilities.Cell("Power distribution", "1 Enrich")!.Note).Contains("Electrical 0.1");
        }

        [Test]
        public async Task The_grid_comes_from_the_one_matrix_file_all_23_systems()
        {
            var json = System.IO.Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "docs", "tracker", "mep_matrix.json");
            await Assert.That(SystemCapabilities.Matrix.Systems.Length).IsEqualTo(23);
            await Assert.That(SystemCapabilities.Matrix.Cells.Length).IsEqualTo(161);
            await Assert.That(SystemCapabilities.Systems.Values.Sum(x => x.Length)).IsEqualTo(23);
            await Assert.That(SystemCapabilities.Capabilities.Length).IsEqualTo(7);
            await Assert.That(SystemCapabilities.Disciplines).Contains("Plumbing");
            await Assert.That(SystemCapabilities.Headline()).StartsWith("0 of 159 cells tested in Revit");
            if (System.IO.File.Exists(json))
            {
                using var file = System.IO.File.OpenRead(json);
                await Assert.That(SystemCapabilities.Load(file).Cells.Length).IsEqualTo(SystemCapabilities.Matrix.Cells.Length);
            }
        }

        [Test]
        public async Task The_electrical_check_fills_the_board_manager_and_saves_the_list()
        {
            var (boards, saved, ran) = Sta.Run(() =>
            {
                var (vm, tools) = Pane("Systems");
                vm.Systems.CheckCommand.Execute(null);
                var table = vm.Systems.Groups.Single(g => g.Title.StartsWith("Board manager")).Items.OfType<TableSetting>().First();
                vm.Systems.SaveCommand.Execute(null);
                return (table.Rows.Select(r => string.Join("|", r.Cells)).ToList(), vm.Systems.Last!.Saved, string.Join(",", tools.Ran));
            });

            await Assert.That(boards[0]).IsEqualTo("MDB|86.0 / 61.0|6|—|Pass");
            await Assert.That(saved).Contains(@"06_QA\Systems");
            await Assert.That(ran).IsEqualTo("electrical,electrical save");
        }

        [Test]
        public async Task Other_disciplines_say_they_have_no_tools_yet()
        {
            var (note, footer) = Sta.Run(() =>
            {
                var (vm, _) = Pane("Systems");
                vm.Systems.Groups.Single(g => g.Title == "System").Items.OfType<ChoiceSetting>().Single().Selected = "Plumbing";
                var n = vm.Systems.Groups.Single(g => g.Title == "Run on this model").Items.OfType<NoteSetting>().Single().Text;
                return (n, vm.Systems.Footer.Count());
            });

            await Assert.That(note).StartsWith("Plumbing: no checks run from here yet");
            await Assert.That(footer).IsEqualTo(0);
        }

        [Test]
        public async Task Diagrams_scan_and_plan_read_only_and_generate_only_after_a_yes()
        {
            var (before, after, title, ran, sheets, gate, structural) = Sta.Run(() =>
            {
                var (vm, tools) = Pane("Systems");
                vm.Systems.Groups.Single(g => g.Title == "System").Items.OfType<ChoiceSetting>().Single().Selected = "Plumbing";
                string Buttons() => string.Join(",", vm.Systems.Groups.Single(g => g.Title == "Diagrams · Plumbing").Items.OfType<ButtonsSetting>().Single().Buttons.Select(b => b.Label));
                var b0 = Buttons();
                vm.Systems.DiagramScanCommand.Execute(null);
                vm.Systems.DiagramGenerateCommand.Execute(null); // refused: no plan yet
                var noDialog = vm.Dialog == null;
                vm.Systems.DiagramPlanCommand.Execute(null);
                var b1 = Buttons();
                vm.Systems.DiagramGenerateCommand.Execute(null);
                var t = vm.Dialog!.Title;
                vm.Dialog.ConfirmCommand!.Execute(null);
                var s = vm.Systems.Groups.Single(g => g.Title == "Diagrams · Plumbing").Items.OfType<TableSetting>().Single(x => x.Label == "Sheets").Rows.Count;
                vm.Systems.DiagramGateCommand.Execute(null);
                var g = vm.Systems.Groups.Single(x => x.Title == "Diagrams · Plumbing").Items.OfType<TableSetting>().Any(x => x.Label.StartsWith("Gate D"));
                vm.Systems.Groups.Single(x => x.Title == "System").Items.OfType<ChoiceSetting>().Single().Selected = "Structural";
                var st = vm.Systems.Groups.Any(x => x.Title.StartsWith("Diagrams"));
                return (b0, b1, noDialog ? t : "dialog before the plan", string.Join(",", tools.Ran), s, g, st);
            });

            await Assert.That(before).IsEqualTo("Scan (read only),Plan (dry run),Gate D (read only)");
            await Assert.That(after).IsEqualTo("Scan (read only),Plan (dry run),Generate,Gate D (read only)");
            await Assert.That(title).IsEqualTo("Generate the plumbing diagrams?");
            await Assert.That(ran).IsEqualTo("diagram scan p_water+p_drainage,diagram plan p_water+p_drainage,diagram generate p_water+p_drainage,diagram gate p_water+p_drainage");
            await Assert.That(sheets).IsEqualTo(2);
            await Assert.That(gate).IsTrue();
            await Assert.That(structural).IsFalse();
        }

        [Test]
        public async Task The_structural_check_lists_problems_and_results_and_leaves_design_to_the_engineer()
        {
            var (checks, results, warn) = Sta.Run(() =>
            {
                var (vm, _) = Pane("Structural");
                vm.Structural.CheckCommand.Execute(null);
                var c = vm.Structural.Groups.Single(g => g.Title == "Analytical model check").Items.OfType<TableSetting>().Single().Rows.Count;
                var r = vm.Structural.Groups.Single(g => g.Title == "Results back from analysis");
                return (c, r.Items.OfType<TableSetting>().Single().Rows.First().Cells[2], r.Items.OfType<NoteSetting>().Single().Text);
            });

            await Assert.That(checks).IsEqualTo(5);
            await Assert.That(results).IsEqualTo("1.12");
            await Assert.That(warn).Contains("never changes a structural section");
        }
    }
}
