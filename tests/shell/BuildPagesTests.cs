using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U26: Build pane, workspace window and Revit views (boards build/PaneBuild, B_Workspace, B_RevitViews).</summary>
    public class BuildPagesTests
    {
        private static (ShellViewModel Vm, MockBuildTools Tools) Pane()
        {
            var tools = new MockBuildTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            s.Set("settings.project.folder", @"Z:\Projects\F26001");
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), build: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Build"));
            return (vm, tools);
        }

        [Test]
        public async Task Measure_fills_the_bills_the_legend_and_the_workspace()
        {
            var (bills, legend, workspace) = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                vm.Build.MeasureCommand.Execute(null);
                var b = vm.Build.Groups.Single(g => g.Title == "BOQ and quantities").Items.OfType<TableSetting>().Single().Rows.Select(r => string.Join("|", r.Cells)).ToList();
                var l = vm.Build.Groups.Single(g => g.Title == "Views on the model").Items.OfType<TableSetting>().Single().Rows.Count;
                var w = vm.BuildWorkspace.Groups.Single(g => g.Title.StartsWith("BOQ · ")).Items.OfType<TableSetting>().Single().Rows.Select(r => string.Join("|", r.Cells)).ToList();
                return (b, l, w);
            });

            await Assert.That(bills[1]).IsEqualTo("C.COL|1|1");
            await Assert.That(legend).IsEqualTo(4);
            await Assert.That(workspace[1]).IsEqualTo("C.COL_01|RC column C25/30|m3|38.4|36.1|Yes");
            await Assert.That(workspace[2]).IsEqualTo("J.HRD_01|Door ironmongery set|set|QS|—|");
        }

        [Test]
        public async Task Rates_never_show_and_unmapped_elements_are_said()
        {
            var text = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                vm.Build.MeasureCommand.Execute(null);
                return string.Join(" ", vm.Build.Groups.SelectMany(g => g.Items).OfType<NoteSetting>().Select(n => n.Text));
            });

            await Assert.That(text).Contains("Rates are never shown here");
            await Assert.That(text).Contains("14 Furniture");
        }

        [Test]
        public async Task Colour_asks_revit_with_the_chosen_mode_and_the_baseline_asks_first()
        {
            var (ran, title) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Build.Groups.Single(g => g.Title == "Views on the model").Items.OfType<ChoiceSetting>().Single().Selected = "Package";
                vm.Build.ColourCommand.Execute(null);
                vm.Build.BaselineCommand.Execute(null);
                var t = vm.Dialog!.Title;
                var before = string.Join(",", tools.Ran);
                vm.Dialog.ConfirmCommand!.Execute(null);
                return (before + "|" + string.Join(",", tools.Ran), t);
            });

            await Assert.That(ran).IsEqualTo("colour Package|colour Package,baseline,measure");
            await Assert.That(title).IsEqualTo("Set as baseline");
        }

        [Test]
        public async Task Open_workspace_asks_the_view_for_the_window_and_tabs_switch()
        {
            var (asked, packages) = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                int n = 0;
                vm.OpenWorkspaceRequested += (_, __) => n++;
                vm.Build.OpenWorkspaceCommand.Execute(null);
                vm.Build.MeasureCommand.Execute(null);
                vm.BuildWorkspace.Groups.First().Items.OfType<ChoiceSetting>().Single().Selected = "Packages";
                return (n, vm.BuildWorkspace.Groups.Any(g => g.Title.StartsWith("Packages")));
            });

            await Assert.That(asked).IsEqualTo(1);
            await Assert.That(packages).IsTrue();
        }
    }
}
