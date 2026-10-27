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
        public async Task Approvals_have_their_own_page_for_everyone_with_a_live_badge_and_Approve_runs_the_batch()
        {
            var (badge, open, titles, afterBadge, afterStatus, afterResult) = Sta.Run(() =>
            {
                var (_, ai, vm) = Pane();
                ai.Queue.Clear();
                vm.Approvals.RefreshAsync().GetAwaiter().GetResult();
                ai.Add(new AiQueueLine { Id = "21249e26", Model = "OGL", Summary = "create_point_based_element: 22 data", Elements = 22, Status = "pending", EstimateS = 40 });
                var b = vm.HasAiWaiting + "|" + vm.AiWaitingText;
                vm.OpenApprovalsCommand.Execute(null);
                var t = vm.Approvals.Groups.Select(g => g.Title).ToList();
                vm.Approvals.Groups[0].Items.OfType<ButtonsSetting>().First().Buttons[0].Command.Execute(null);
                return (b, vm.IsApprovalsOpen, t, vm.HasAiWaiting, ai.Queue[0].Status, ai.Queue[0].Result);
            });
            await Assert.That(badge).IsEqualTo("True|AI: 1 waiting");
            await Assert.That(open).IsTrue();
            await Assert.That(titles[0]).IsEqualTo("Waiting for your approval");
            await Assert.That(afterBadge).IsFalse();
            await Assert.That(afterStatus).IsEqualTo("used");
            await Assert.That(afterResult).IsEqualTo("done");
        }

        [Test]
        public async Task Send_to_AI_sends_the_note_from_the_approvals_page_and_clears_it()
        {
            var (title, sent, after) = Sta.Run(() =>
            {
                var (_, ai, vm) = Pane();
                vm.Approvals.RefreshAsync().GetAwaiter().GetResult();
                var g = vm.Approvals.Groups.First(x => x.Title == "Show the AI a problem");
                var note = g.Items.OfType<TextSetting>().First();
                note.Value = "this wall is doubled";
                g.Items.OfType<ButtonsSetting>().First().Buttons[0].Command.Execute(null);
                return (g.Title, string.Join("|", ai.Sent), note.Value);
            });
            await Assert.That(title).IsEqualTo("Show the AI a problem");
            await Assert.That(sent).IsEqualTo("this wall is doubled");
            await Assert.That(after).IsEqualTo("");
        }

        [Test]
        public async Task The_general_AI_switch_goes_off_on_off_from_the_header_and_Stop_AI_overrides_it()
        {
            var (states, stoppedState, status) = Sta.Run(() =>
            {
                var (_, ai, vm) = Pane();
                var seen = new System.Collections.Generic.List<string>();
                vm.RefreshAiAsync().GetAwaiter().GetResult(); seen.Add(vm.AiStateText);
                vm.ToggleAiAsync().GetAwaiter().GetResult(); seen.Add(vm.AiStateText);
                vm.ToggleAiAsync().GetAwaiter().GetResult(); seen.Add(vm.AiStateText);
                ai.Stopped = true;
                vm.ToggleAiAsync().GetAwaiter().GetResult();
                return (seen, vm.AiStateText, vm.Status);
            });
            await Assert.That(string.Join(",", states)).IsEqualTo("AI Off,AI On,AI Off");
            await Assert.That(stoppedState).IsEqualTo("Stopped");
            await Assert.That(status).Contains("Stop AI overrides the switch");
        }

        [Test]
        public async Task Admin_shows_the_general_switch_first_and_involvement_and_levels_under_Advanced()
        {
            var titles = Sta.Run(() => Pane().Admin.Groups.Select(g => g.Title).ToList());
            await Assert.That(titles[0]).IsEqualTo("General AI switch");
            await Assert.That(titles).Contains("Advanced · involvement (admins)");
            await Assert.That(titles).Contains("Advanced · operation groups, level each (admins)");
        }

        [Test]
        public async Task The_section_shows_each_group_with_its_level_and_why()
        {
            var (groups, hints) = Sta.Run(() =>
            {
                var (admin, _, _) = Pane();
                var levels = admin.Groups.Single(g => g.Title.StartsWith("Advanced · operation groups")).Items.OfType<ChoiceSetting>().ToList();
                return (admin.Groups.Select(g => g.Title).ToList(), levels.Select(l => l.Label + "=" + l.Selected + "|" + l.Hint).ToList());
            });

            await Assert.That(groups).Contains("Waiting for approval");
            await Assert.That(groups).Contains("Admins only, always");
            await Assert.That(hints[1]).StartsWith("Views and annotation=Auto in WIP|Allowed now");
            await Assert.That(hints[3]).Contains("Unlocks at 21%");
        }

        [Test]
        public async Task Auto_is_offered_only_where_the_rulebook_allows_it()
        {
            var (views, brief) = Sta.Run(() =>
            {
                var (admin, _, _) = Pane();
                var levels = admin.Groups.Single(g => g.Title.StartsWith("Advanced · operation groups")).Items.OfType<ChoiceSetting>().ToList();
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

            await Assert.That(status).IsEqualTo("used"); // owner 26 Oct: Approve runs the batch
        }

        [Test]
        public async Task Save_asks_first_and_lists_what_changes()
        {
            var (title, changes, saved) = Sta.Run(() =>
            {
                var (admin, ai, vm) = Pane();
                admin.Groups.Single(g => g.Title == "Advanced · involvement (admins)").Items.OfType<TextSetting>().Single().Value = "35";
                admin.Groups.Single(g => g.Title.StartsWith("Advanced · operation groups")).Items.OfType<ButtonsSetting>().Single()
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
