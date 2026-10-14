using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U29: Setup › Templates › Builder (board manage/PaneTemplatesBuilder; Phase 1, templates as data).</summary>
    public class TemplateBuilderTests
    {
        private static (ShellViewModel Vm, MockTemplateTools Tools) Pane()
        {
            var tools = new MockTemplateTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), templates: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Templates"));
            return (vm, tools);
        }

        private static SettingsGroup Builder(ShellViewModel vm) => vm.Templates.Groups.Single(g => g.Title.StartsWith("Builder"));

        [Test]
        public async Task The_recipe_shows_what_the_kit_holds_and_the_readings_made()
        {
            var (rows, readings) = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                vm.Templates.RecipeCommand.Execute(null);
                var b = Builder(vm);
                return (b.Items.OfType<TableSetting>().Single().Rows.Count, b.Items.OfType<ReadOnlySetting>().Single().Value);
            });

            await Assert.That(rows).IsEqualTo(7);
            await Assert.That(readings).Contains("Line weights");
        }

        [Test]
        public async Task Build_shows_a_dry_run_first_then_builds_in_staging()
        {
            var (title, before, after) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Templates.BuildCommand.Execute(null);
                var t = vm.Dialog!.Title;
                var b = string.Join(",", tools.Builds.Select(x => x.Dry));
                vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, b, string.Join(",", tools.Builds.Select(x => x.Dry)));
            });

            await Assert.That(title).StartsWith("Build FMC_Base_Template_v2.2.rte");
            await Assert.That(before).IsEqualTo("True");
            await Assert.That(after).IsEqualTo("True,False");
        }

        [Test]
        public async Task Compare_lists_what_the_template_lacks()
        {
            var row = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                vm.Templates.CompareCommand.Execute(null);
                return string.Join("|", Builder(vm).Items.OfType<TableSetting>().Single().Rows[0].Cells);
            });

            await Assert.That(row).IsEqualTo("view templates|2|VT_W_SitePlan_Phase, VT_W_3D_Logistics");
        }
    }
}
