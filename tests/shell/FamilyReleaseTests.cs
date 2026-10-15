using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U30: Setup › Families › Quality and release (board manage/PaneFamiliesRelease; Phase 2).</summary>
    public class FamilyReleaseTests
    {
        private static (ShellViewModel Vm, MockReleaseTools Tools) Pane(bool pass = true)
        {
            var tools = new MockReleaseTools { Pass = pass };
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            s.Set("settings.families.release.file", @"K:\04_Families\_Staging\A\FMC_A_Door_SteelFanlight.rfa");
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), release: tools);
            licence.SetSignedIn();
            return (vm, tools);
        }

        private static SettingsGroup Release(ShellViewModel vm) => vm.Families.Groups.Single(g => g.Title == "Quality and release");

        [Test]
        public async Task Gate_A_lists_each_check_and_release_needs_a_reviewer_and_a_note()
        {
            var (rows, warned, released) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Families.GateCommand.Execute(null);
                var r = Release(vm).Items.OfType<TableSetting>().Single().Rows.Count;
                vm.Families.ReleaseCommand.Execute(null);
                var w = Release(vm).Items.OfType<MessagesSetting>().Single().Lines.First().Text;
                vm.Families.ReleaseDraft.Set("reviewer", "Lead A");
                vm.Families.ReleaseDraft.Set("note", "Checked against the Roofings datasheet");
                vm.Families.ReleaseCommand.Execute(null);
                vm.Dialog!.ConfirmCommand!.Execute(null);
                return (r, w, tools.Log.Single());
            });

            await Assert.That(rows).IsEqualTo(5);
            await Assert.That(warned).IsEqualTo("A reviewer and a note are needed.");
            await Assert.That(released).IsEqualTo("released Lead A Checked against the Roofings datasheet");
        }

        [Test]
        public async Task A_failing_gate_offers_only_send_back()
        {
            var (labels, log) = Sta.Run(() =>
            {
                var (vm, tools) = Pane(pass: false);
                vm.Families.GateCommand.Execute(null);
                var l = string.Join(",", Release(vm).Items.OfType<ButtonsSetting>().Last().Buttons.Select(b => b.Label));
                vm.Families.ReleaseDraft.Set("reviewer", "Lead A");
                vm.Families.ReleaseDraft.Set("note", "800 is under the 900 mm clear opening");
                vm.Families.SendBackCommand.Execute(null);
                return (l, tools.Log.Single());
            });

            await Assert.That(labels).IsEqualTo("Send back");
            await Assert.That(log).StartsWith("sent back Lead A");
        }
    }
}
