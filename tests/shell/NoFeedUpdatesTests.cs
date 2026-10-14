using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>F-013: in Revit there is no update feed yet; the pane says so and never offers a sample update.</summary>
    public class NoFeedUpdatesTests
    {
        [Test]
        public async Task Without_a_feed_Updates_shows_the_build_and_no_update()
        {
            var (groups, installed, status) = Sta.Run(() =>
            {
                var s = new InMemoryUserSettings();
                s.SetBool(SettingKeys.SetupDone, true);
                s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                var licence = new MockLicenceService();
                var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(),
                                            updates: new NoFeedUpdateService("build 6a6b61e · 2026-10-14 07:47:36 UTC"));
                licence.SetSignedIn();
                vm.OpenSettingsCommand.Execute(null);
                vm.Settings.Open("Updates");
                var tab = vm.Settings.Tabs.Single(t => t.Name == "Updates");
                vm.Settings.CheckForUpdates();
                return (string.Join(" | ", tab.Groups.Select(g => g.Title)), tab.Groups[0].Items.OfType<ReadOnlySetting>().First().Value, vm.Status);
            });
            await Assert.That(groups).DoesNotContain("Update available");
            await Assert.That(groups).Contains("Updates");
            await Assert.That(installed).StartsWith("build 6a6b61e");
            await Assert.That(status).IsEqualTo(SettingsViewModel.NoFeed);
        }
    }
}
