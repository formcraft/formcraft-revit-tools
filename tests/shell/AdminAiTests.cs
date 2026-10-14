using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U28: Admin › AI involvement (board core/PaneAdminAI; docs/AI_ASSISTED_MODELLER.md).</summary>
    public class AdminAiTests
    {
        private static (AdminViewModel Admin, MockAiTools Ai, ShellViewModel Vm) Pane()
        {
            var ai = new MockAiTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), ai: ai);
            licence.SetSignedIn();
            vm.Admin.Section = "AI involvement";
            return (vm.Admin, ai, vm);
        }

        [Test]
        public async Task The_section_shows_each_group_with_its_level_and_why()
        {
            var (groups, hints) = Sta.Run(() =>
            {
                var (admin, _, _) = Pane();
                var levels = admin.Groups.Single(g => g.Title.StartsWith("Operation groups")).Items.OfType<ChoiceSetting>().ToList();
                return (admin.Groups.Select(g => g.Title).ToList(), levels.Select(l => l.Label + "=" + l.Selected + "|" + l.Hint).ToList());
            });

            await Assert.That(groups).Contains("Waiting for approval");
            await Assert.That(groups).Contains("Never, at any level");
            await Assert.That(hints[1]).StartsWith("Views and annotation=Auto in WIP|Allowed now");
            await Assert.That(hints[3]).Contains("Unlocks at 21%");
        }

        [Test]
        public async Task Auto_is_offered_only_where_the_rulebook_allows_it()
        {
            var (views, brief) = Sta.Run(() =>
            {
                var (admin, _, _) = Pane();
                var levels = admin.Groups.Single(g => g.Title.StartsWith("Operation groups")).Items.OfType<ChoiceSetting>().ToList();
                return (levels.Single(l => l.Label == "Views and annotation").Options.Count, levels.Single(l => l.Label == "Create from brief").Options.Count);
            });

            await Assert.That(views).IsEqualTo(4);
            await Assert.That(brief).IsEqualTo(3);
        }

        [Test]
        public async Task A_person_approves_a_waiting_batch()
        {
            var status = Sta.Run(() =>
            {
                var (admin, ai, _) = Pane();
                var approve = admin.Groups.Single(g => g.Title == "Waiting for approval").Items.OfType<ButtonsSetting>().First()
                    .Buttons.Single(b => b.Label == "Approve");
                approve.Command.Execute(null);
                return ai.Queue[0].Status;
            });

            await Assert.That(status).IsEqualTo("approved");
        }

        [Test]
        public async Task Save_asks_first_and_lists_what_changes()
        {
            var (title, changes, saved) = Sta.Run(() =>
            {
                var (admin, ai, vm) = Pane();
                admin.Groups.Single(g => g.Title == "AI modelling").Items.OfType<TextSetting>().Single().Value = "35";
                admin.Groups.Single(g => g.Title.StartsWith("Operation groups")).Items.OfType<ButtonsSetting>().Single()
                    .Buttons.Single(b => b.Label == "Save policy").Command.Execute(null);
                var t = vm.Dialog!.Title;
                var c = vm.Dialog.Items!.OfType<ReadOnlySetting>().Single().Value;
                vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, c, ai.Involvement);
            });

            await Assert.That(title).IsEqualTo("Save the AI policy?");
            await Assert.That(changes).IsEqualTo("Involvement: 20% → 35%");
            await Assert.That(saved).IsEqualTo(35);
        }

        [Test]
        public async Task Stop_AI_then_resume()
        {
            var (stopped, label) = Sta.Run(() =>
            {
                var (admin, ai, _) = Pane();
                admin.Groups.Single(g => g.Title == "Stop AI").Items.OfType<ButtonsSetting>().Single().Buttons.Single().Command.Execute(null);
                var after = admin.Groups.Single(g => g.Title == "Stop AI").Items.OfType<ButtonsSetting>().Single().Buttons.Single().Label;
                return (ai.Stopped, after);
            });

            await Assert.That(stopped).IsTrue();
            await Assert.That(label).IsEqualTo("Resume AI");
        }
    }
}
