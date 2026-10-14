using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U24: Check › Scripts (boards model/PaneScripts, model/M_Automation).</summary>
    public class ScriptsPageTests
    {
        private static (ShellViewModel Vm, MockScriptTools Tools, InMemoryUserSettings Settings) Pane(bool project = true)
        {
            var tools = new MockScriptTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            if (project) { s.Set("settings.project.folder", @"Z:\Projects\F26001"); s.Set("settings.project.code", "F26001"); }
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), scripts: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Scripts"));
            vm.Scripts.RefreshCommand.Execute(null);
            return (vm, tools, s);
        }

        [Test]
        public async Task The_library_lists_the_kit_scripts_and_a_click_shows_where_each_runs()
        {
            var (rows, filtered, details) = Sta.Run(() =>
            {
                var (vm, _, s) = Pane();
                var table = vm.Scripts.Groups.Single(g => g.Title == "Script library").Items.OfType<TableSetting>().Single();
                var count = table.Rows.Count;
                table.Selected = table.Rows.First();
                var d = vm.Scripts.Groups.Single(g => g.Title.StartsWith("Selected · ")).Items.OfType<NoteSetting>().Select(n => n.Text);
                vm.Scripts.Groups.Single(g => g.Title == "Script library").Items.OfType<ChoiceSetting>().Single().Selected = "Changes the model";
                var after = vm.Scripts.Groups.Single(g => g.Title == "Script library").Items.OfType<TableSetting>().Single().Rows.Count;
                return (count, after, string.Join(" ", d));
            });

            await Assert.That(rows).IsEqualTo(3);
            await Assert.That(filtered).IsEqualTo(1);
            await Assert.That(details).Contains("Drawings › Sheets");
            await Assert.That(details).Contains("doesn't run kit scripts");
        }

        [Test]
        public async Task An_automation_runs_its_steps_in_order_and_stops_at_the_first_that_fails()
        {
            var (lines, ran) = Sta.Run(() =>
            {
                var (vm, tools, _) = Pane();
                tools.FailAt = "qa";
                vm.Scripts.RunCommand.Execute(null);
                vm.Dialog!.ConfirmCommand!.Execute(null);
                return (vm.Scripts.RunLines.Lines.Select(l => l.Kind + ":" + l.Text).ToList(), tools.Ran.Single().Name);
            });

            await Assert.That(ran).IsEqualTo("Before sync");
            await Assert.That(lines.Count).IsEqualTo(3);
            await Assert.That(lines[0]).StartsWith("Good:Self-test");
            await Assert.That(lines[1]).StartsWith("Bad:QA check");
            await Assert.That(lines[2]).IsEqualTo("Grey:Workshare check: didn't run");
        }

        [Test]
        public async Task A_new_automation_is_saved_for_the_person_and_can_be_deleted()
        {
            var (added, error, afterDelete) = Sta.Run(() =>
            {
                var (vm, _, _) = Pane();
                vm.Scripts.NewAutomationCommand.Execute(null);
                vm.Dialog!.ConfirmCommand!.Execute(null);
                var err = vm.Dialog?.Error;
                vm.Dialog!.Items.OfType<TextSetting>().Single().Value = "Before Ready to issue";
                var steps = vm.Dialog.Items.OfType<MultiSetting>().Single();
                steps.Options.Single(o => o.Name.StartsWith("Self-test")).IsOn = true;
                steps.Options.Single(o => o.Name.StartsWith("Open review")).IsOn = true;
                vm.Dialog.ConfirmCommand!.Execute(null);
                var a = vm.Scripts.Chosen!;
                var text = a.Name + "=" + string.Join(",", a.Steps);
                vm.Scripts.DeleteAutomationCommand.Execute(null);
                vm.Dialog!.ConfirmCommand!.Execute(null);
                return (text, err, vm.Scripts.Automations.Count);
            });

            await Assert.That(added).IsEqualTo("Before Ready to issue=selftest,review");
            await Assert.That(error).IsEqualTo("Give it a name.");
            await Assert.That(afterDelete).IsEqualTo(3);
        }

        [Test]
        public async Task Report_and_review_steps_need_the_project_folder()
        {
            var (dialog, ran) = Sta.Run(() =>
            {
                var (vm, tools, s) = Pane(project: false);
                s.Set("settings.scripts.automation", "Friday issue prep");
                vm.Scripts.RunCommand.Execute(null);
                return (vm.Dialog == null, tools.Ran.Count);
            });

            await Assert.That(dialog).IsTrue();
            await Assert.That(ran).IsEqualTo(0);
        }
    }
}
