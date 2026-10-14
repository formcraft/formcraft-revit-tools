using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U23: Model › Start from brief (board model/PaneModelBrief).</summary>
    public class BriefPageTests
    {
        private static (ShellViewModel Vm, MockBriefTools Tools) Pane(bool savedModel = false, bool cis = true)
        {
            var tools = new MockBriefTools { SavedModel = savedModel };
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            if (cis) s.Set("settings.model.cis", @"Z:\Projects\F26001\00_Brief\F26001_CIS_R4.json");
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), brief: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Brief"));
            return (vm, tools);
        }

        [Test]
        public async Task Read_shows_what_will_be_created_then_a_dry_run_comes_before_create()
        {
            var (groups, title, applied) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Brief.ReadCommand.Execute(null);
                var g = string.Join(",", vm.Brief.Groups.Select(x => x.Title));
                vm.Brief.DryRunCommand.Execute(null);
                var t = vm.Dialog!.Title;
                var before = string.Join(",", tools.Applied);
                vm.Dialog.ConfirmCommand!.Execute(null);
                return (g, t, before + "|" + string.Join(",", tools.Applied));
            });

            await Assert.That(groups).Contains("What will be created");
            await Assert.That(title).IsEqualTo("Start from brief · dry run");
            await Assert.That(applied).IsEqualTo("True|True,False");
        }

        [Test]
        public async Task A_saved_model_is_locked_and_nothing_runs()
        {
            var (note, applied) = Sta.Run(() =>
            {
                var (vm, tools) = Pane(savedModel: true);
                vm.Brief.ReadCommand.Execute(null);
                vm.Brief.DryRunCommand.Execute(null);
                var n = vm.Brief.Groups.First().Items.OfType<NoteSetting>().First().Text;
                return (n, tools.Applied.Count + (vm.Dialog == null ? 0 : 100));
            });

            await Assert.That(note).Contains("runs only on a new, unsaved model");
            await Assert.That(applied).IsEqualTo(0);
        }

        [Test]
        public async Task Without_a_cis_it_asks_for_one()
        {
            var (status, applied) = Sta.Run(() =>
            {
                var (vm, tools) = Pane(cis: false);
                vm.Brief.DryRunCommand.Execute(null);
                return (vm.Status, tools.Applied.Count);
            });

            await Assert.That(status).Contains("Choose the CIS file");
            await Assert.That(applied).IsEqualTo(0);
        }

        [Test]
        public async Task Blanks_and_skipped_materials_are_said_not_guessed()
        {
            var notes = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                vm.Brief.ReadCommand.Execute(null);
                var rows = vm.Brief.Groups.Single(g => g.Title == "What will be created").Items.OfType<TableSetting>().First().Rows;
                var skipped = vm.Brief.Groups.Single(g => g.Title == "What will be created").Items.OfType<NoteSetting>().Select(n => n.Text);
                return string.Join(" ", rows.Select(r => string.Join(":", r.Cells))) + " " + string.Join(" ", skipped);
            });

            await Assert.That(notes).Contains("Blank in the CIS: left blank:2");
            await Assert.That(notes).Contains("no materials library");
        }
    }
}
