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
            await Assert.That(SystemCapabilities.Status("Power distribution", "1 Enrich")).IsEqualTo("Waits on the kit");
            await Assert.That(SystemCapabilities.Status("Drainage", "4 Calculate")).IsEqualTo("Planned");
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

            await Assert.That(note).StartsWith("Plumbing: no tools yet");
            await Assert.That(footer).IsEqualTo(0);
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
