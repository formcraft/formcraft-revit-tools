using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>F-004 and F-006 from docs/TEST_FEEDBACK.md: the footer says why nothing ran, and belongs to its section.</summary>
    public class FooterStatusTests
    {
        private static ShellViewModel Pane(InMemoryUserSettings settings)
        {
            settings.SetBool(SettingKeys.SetupDone, true);
            settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), settings, theme: new ThemeService());
            licence.SetSignedIn();
            return vm;
        }

        private static void Open(ShellViewModel vm, string name) =>
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == name));

        [Test]
        public async Task A_tool_that_stops_early_says_why_in_the_footer()
        {
            var status = Sta.Run(() =>
            {
                var vm = Pane(new InMemoryUserSettings());
                Open(vm, "Issue");
                vm.Issue.CheckCommand.Execute(null); // no register, no revision: stops before running
                return vm.Status;
            });
            await Assert.That(status).Contains("sheet register");
        }

        [Test]
        public async Task Opening_another_section_clears_the_footer_message()
        {
            var (before, after) = Sta.Run(() =>
            {
                var vm = Pane(new InMemoryUserSettings());
                Open(vm, "Issue");
                vm.Issue.CheckCommand.Execute(null);
                var b = vm.Status;
                Open(vm, "Sheets");
                return (b, vm.Status);
            });
            await Assert.That(before).IsNotEqualTo(ShellViewModel.ReadyStatus);
            await Assert.That(after).IsEqualTo(ShellViewModel.ReadyStatus);
        }
    }
}
