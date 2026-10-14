using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U27: Ask Claude in the pane (board core/PaneAsk), the old "ask …" command carried into the search box.</summary>
    public class AskPageTests
    {
        private static (ShellViewModel Vm, MockAskTools Tools) Pane(bool key = true)
        {
            var tools = new MockAskTools { KeySaved = key };
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), ask: tools);
            licence.SetSignedIn();
            return (vm, tools);
        }

        [Test]
        public async Task Ask_in_the_search_box_opens_ask_and_sends_the_question()
        {
            var (section, asked, turns, query) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Search.Query = "ask how many sheets are in this model?";
                vm.Search.OpenSelected();
                return (vm.HostContent is AskPage, tools.Asked.Single().Question, vm.Ask.Turns.Select(t => t.Role + ":" + t.Meta).ToList(), vm.Search.Query);
            });

            await Assert.That(section).IsTrue();
            await Assert.That(asked).IsEqualTo("how many sheets are in this model?");
            await Assert.That(turns[1]).IsEqualTo("Claude:Read: document_info, model_statistics · 2,140 tokens · claude-sonnet-5-5");
            await Assert.That(query).IsEqualTo("");
        }

        [Test]
        public async Task Follow_ups_carry_the_conversation_until_ask_reset()
        {
            var (second, afterReset) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Ask.Input.Value = "how many views?";
                vm.Ask.SendCommand.Execute(null);
                vm.Ask.Input.Value = "and sheets?";
                vm.Ask.SendCommand.Execute(null);
                var h = tools.Asked[1].History;
                vm.Ask.ResetCommand.Execute(null);
                vm.Ask.Input.Value = "again";
                vm.Ask.SendCommand.Execute(null);
                return (h, tools.Asked[2].History);
            });

            await Assert.That(second).IsEqualTo(2);
            await Assert.That(afterReset).IsEqualTo(0);
        }

        [Test]
        public async Task Without_a_key_it_says_so_and_the_status_shows_where_it_goes()
        {
            var (said, key, log) = Sta.Run(() =>
            {
                var (vm, _) = Pane(key: false);
                vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Ask"));
                vm.Search.Query = "? which views are not on a sheet";
                vm.Search.OpenSelected();
                var k = vm.Ask.Groups.Single(g => g.Title == "Key and budget (admin)").Items.OfType<ReadOnlySetting>().First().Value;
                var l = vm.Ask.Groups.Single(g => g.Title == "Log").Items.OfType<TableSetting>().Single().Columns;
                return (vm.Ask.Turns.Last().Role + ":" + vm.Ask.Turns.Last().Text, k, string.Join(",", l));
            });

            await Assert.That(said).IsEqualTo("Formcraft:No Claude API key on this PC.");
            await Assert.That(key).StartsWith("Not saved");
            await Assert.That(log).IsEqualTo("Time,Read,Tokens,Result");
        }

        [Test]
        public async Task Other_searches_still_search()
        {
            var (ran, open) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Search.Query = "asking price";
                vm.Search.OpenSelected();
                return (tools.Asked.Count, vm.Search.IsOpen);
            });

            await Assert.That(ran).IsEqualTo(0);
            await Assert.That(open).IsTrue();
            await Assert.That(AskPage.QuestionIn("ASK what?")).IsEqualTo("what?");
            await Assert.That(AskPage.QuestionIn("askew")).IsNull();
        }
    }
}
