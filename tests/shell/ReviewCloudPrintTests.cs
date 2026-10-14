using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U20: Team › Review, revision clouds (dry run first) and the prints of a sheet.</summary>
    public class ReviewCloudPrintTests
    {
        private static (ShellViewModel Vm, MockReviewTools Tools, InMemoryUserSettings Settings) Pane()
        {
            var tools = new MockReviewTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            s.Set("settings.project.folder", @"Z:\Projects\F26001");
            s.Set("settings.review.filter", "All");
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), review: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Review"));
            vm.Review.RefreshCommand.Execute(null);
            return (vm, tools, s);
        }

        [Test]
        public async Task A_cloud_is_drawn_only_after_a_dry_run_and_a_yes()
        {
            var (runs, cloud) = Sta.Run(() =>
            {
                var (vm, tools, _) = Pane();
                var table = vm.Review.Groups.Single(g => g.Title == "Review register").Items.OfType<TableSetting>().Single();
                table.Selected = table.Rows.Single(r => ((ReviewItemInfo)r.Tag!).Id == "F26001-ISS-0014");
                vm.Review.CloudCommand.Execute(null);
                var before = tools.Clouds.Select(c => c.Dry).ToList();
                vm.Dialog!.ConfirmCommand!.Execute(null);
                return ((before, tools.Clouds.Select(c => c.Dry).ToList()), tools.Items.Single(i => i.Id == "F26001-ISS-0014").Cloud);
            });
            await Assert.That(runs.before).IsEquivalentTo(new[] { true });
            await Assert.That(runs.Item2).IsEquivalentTo(new[] { true, false });
            await Assert.That(cloud).StartsWith("A-1001");
        }

        [Test]
        public async Task A_print_needs_a_sheet_and_lands_in_the_history()
        {
            var (warned, history) = Sta.Run(() =>
            {
                var (vm, _, s) = Pane();
                vm.Review.PrintRevisedCommand.Execute(null);
                var w = vm.Status;
                s.Set("settings.review.sheet", "a-1001");
                vm.Review.PrintRevisedCommand.Execute(null);
                var t = vm.Review.Groups.Single(g => g.Title == "Prints of a sheet").Items.OfType<TableSetting>().Single();
                return (w, t.Rows.Select(r => r.Cells[1]).ToList());
            });
            await Assert.That(warned).Contains("sheet number");
            await Assert.That(history).IsEquivalentTo(new[] { "As revised" });
        }
    }
}
