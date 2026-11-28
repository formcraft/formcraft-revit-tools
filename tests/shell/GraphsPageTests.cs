using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>D6 (Builder 7): Check › Graphs, a Dynamo graph as a staff form; dry run, a person's approval, then Run. Mock tools only.</summary>
    public class GraphsPageTests
    {
        private static ShellViewModel Pane()
        {
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), graphs: new MockGraphTools());
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Graphs"));
            vm.Graphs.RefreshCommand.Execute(null);
            return vm;
        }

        private static void Pick(ShellViewModel vm, string contains) =>
            vm.Graphs.Groups.Single(g => g.Title == "Graph").Items.OfType<ChoiceSetting>().Single().Selected =
                vm.Graphs.Groups.Single(g => g.Title == "Graph").Items.OfType<ChoiceSetting>().Single().Options.First(o => o.Contains(contains));

        private static string Lines(ShellViewModel vm) =>
            string.Join(" | ", vm.Graphs.Groups.Single(g => g.Title == "Plan").Items.OfType<MessagesSetting>().Single().Lines.Select(l => l.Text));

        [Test]
        public async Task The_form_draws_each_input_by_its_control_and_element_pickers_are_not_typed()
        {
            var (kinds, element, hint) = Sta.Run(() =>
            {
                var vm = Pane();
                Pick(vm, "form_inputs");
                var form = vm.Graphs.Groups.Single(g => g.Title.StartsWith("Form · "));
                var k = string.Join(",", form.Items.Select(i => i.GetType().Name));
                var e = form.Items.OfType<ReadOnlySetting>().Single(r => r.Label == "Pick a wall").Value;
                var h = form.Items.OfType<TextSetting>().Single(t => t.Label == "Output folder").Hint;
                return (k, e, h);
            });

            await Assert.That(kinds).Contains("TextSetting,ToggleSetting,ChoiceSetting,TextSetting,ReadOnlySetting");
            await Assert.That(element).IsEqualTo("Picked in Revit");
            await Assert.That(hint).Contains("Must already exist");
        }

        [Test]
        public async Task A_Python_graph_needs_a_person_even_for_a_preview_and_the_approval_is_single_use()
        {
            var (noPlan, planned, beforeAsk, pending, afterApprove, again) = Sta.Run(() =>
            {
                var vm = Pane();
                Pick(vm, "ModelHealth");
                vm.Graphs.RunCommand.Execute(null);
                var a = Lines(vm);
                vm.Graphs.PlanCommand.Execute(null);
                var b = vm.Graphs.CurrentPlan!.NeedsApproval + " " + vm.Graphs.CurrentPlan.PlanHash;
                vm.Graphs.RunCommand.Execute(null);
                var c = Lines(vm);
                vm.Graphs.AskCommand.Execute(null);
                var d = vm.Graphs.Approval!.Status;
                vm.Graphs.ApproveCommand.Execute(null);
                vm.Graphs.RunCommand.Execute(null);
                var e = Lines(vm);
                vm.Graphs.RunCommand.Execute(null);
                return (a, b, c, d, e, Lines(vm));
            });

            await Assert.That(noPlan).Contains("Press Plan first");
            await Assert.That(planned).StartsWith("True sha256:");
            await Assert.That(beforeAsk).Contains("APPROVAL-NEEDED");
            await Assert.That(pending).IsEqualTo("pending");
            await Assert.That(afterApprove).Contains("nothing runs");
            await Assert.That(again).Contains("Press Plan first");
        }

        [Test]
        public async Task A_refused_approval_never_runs_and_a_changed_input_needs_a_new_plan()
        {
            var (refused, changed) = Sta.Run(() =>
            {
                var vm = Pane();
                Pick(vm, "form_inputs");
                vm.Graphs.Groups.Single(g => g.Title == "Plan").Items.OfType<ChoiceSetting>().Single(c => c.Label == "Mode").Selected = "apply";
                vm.Graphs.PlanCommand.Execute(null);
                vm.Graphs.AskCommand.Execute(null);
                vm.Graphs.RefuseCommand.Execute(null);
                vm.Graphs.RunCommand.Execute(null);
                var r = Lines(vm);
                vm.Graphs.PlanCommand.Execute(null);
                vm.Graphs.Groups.Single(g => g.Title.StartsWith("Form · ")).Items.OfType<TextSetting>().First().Value = "7";
                return (r, vm.Graphs.CurrentPlan == null);
            });

            await Assert.That(refused).Contains("REFUSED");
            await Assert.That(changed).IsTrue();
        }
    }
}
