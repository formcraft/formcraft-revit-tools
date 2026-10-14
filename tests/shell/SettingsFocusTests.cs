using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>F-012: search finds the kit setting, and it and the kit banner land on the kit field.</summary>
    public class SettingsFocusTests
    {
        private static ShellViewModel Pane(bool kit)
        {
            var settings = new InMemoryUserSettings();
            settings.SetBool(SettingKeys.SetupDone, true);
            settings.Set(SettingKeys.KitFolder, kit ? SetupTests.SampleKit : @"Z:\nowhere");
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), settings, theme: new ThemeService());
            licence.SetSignedIn();
            return vm;
        }

        [Test]
        public async Task Search_finds_the_kit_folder_and_opens_Settings_on_it()
        {
            var (titles, tab, focus) = Sta.Run(() =>
            {
                var vm = Pane(kit: true);
                vm.Search.Query = "kit";
                var t = vm.Search.Results.Select(r => r.Title).ToList();
                vm.Search.OpenCommand.Execute(vm.Search.Results.First(r => r.Title == "Kit folder"));
                return (t, vm.Settings.CurrentName, vm.Settings.FocusGroup);
            });
            await Assert.That(titles).Contains("Kit folder");
            await Assert.That(tab).IsEqualTo("General");
            await Assert.That(focus).IsEqualTo("General · kit");
        }

        [Test]
        public async Task The_kit_banner_opens_Settings_on_the_kit_field()
        {
            var focus = Sta.Run(() =>
            {
                var vm = Pane(kit: false);
                vm.StateBanner!.Command!.Execute(null);
                return vm.Settings.FocusGroup;
            });
            await Assert.That(focus).IsEqualTo("General · kit");
        }
    }
}
