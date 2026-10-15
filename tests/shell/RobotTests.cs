using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U33: Engineer › Structural › Robot (track R). The engineer's form has no defaults; every write asks first.</summary>
    public class RobotTests
    {
        private static (ShellViewModel Vm, MockRobotTools Tools) Pane()
        {
            var tools = new MockRobotTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), robot: tools);
            licence.SetSignedIn();
            return (vm, tools);
        }

        private static SettingsGroup Robot(ShellViewModel vm) => vm.Structural.Groups.Single(g => g.Title == "Robot (analysis hand-off)");

        [Test]
        public async Task Nothing_goes_to_Robot_until_the_engineer_fills_the_form()
        {
            var (warned, sent) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Structural.RobotPreviewCommand.Execute(null);
                return (vm.Structural.RobotMessages.Lines.First().Text, tools.Log.Count);
            });

            await Assert.That(warned).Contains("Choose the column-base supports.");
            await Assert.That(warned).Contains("Name at least one load case.");
            await Assert.That(warned).Contains("The engineer's name is needed.");
            await Assert.That(sent).IsEqualTo(0);
        }

        [Test]
        public async Task Preview_then_send_with_a_confirmation()
        {
            var (beforeSend, log, run) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Structural.RobotDraft.Set("supports", "Fixed");
                vm.Structural.RobotDraft.Set("cases", "G: permanent, self-weight; Q: imposed");
                vm.Structural.RobotDraft.Set("engineer", "Eng. A");
                vm.Structural.RobotPreviewCommand.Execute(null);
                var labels = string.Join(",", Robot(vm).Items.OfType<ButtonsSetting>().First(b => b.Buttons.Any(x => x.Label.StartsWith("Preview"))).Buttons.Select(b => b.Label));
                vm.Structural.RobotSendCommand.Execute(null);
                vm.Dialog!.ConfirmCommand!.Execute(null);
                return (labels, string.Join("|", tools.Log), vm.Structural.RobotDraft.Get("run"));
            });

            await Assert.That(beforeSend).IsEqualTo("Preview (dry run),Send to Robot");
            await Assert.That(log).IsEqualTo("send dry Fixed 2 Eng. A|send Fixed 2 Eng. A");
            await Assert.That(run).IsEqualTo("FEA-20261015-0930");
        }

        [Test]
        public async Task Results_are_a_dry_run_first_and_written_only_after_a_yes()
        {
            var (rows, log) = Sta.Run(() =>
            {
                var (vm, tools) = Pane();
                vm.Structural.RobotDraft.Set("run", "FEA-20261015-0930");
                vm.Structural.RobotResultsCommand.Execute(null);
                var r = Robot(vm).Items.OfType<TableSetting>().Single().Rows.Count;
                vm.Structural.RobotWriteCommand.Execute(null);
                vm.Dialog!.ConfirmCommand!.Execute(null);
                return (r, string.Join("|", tools.Log));
            });

            await Assert.That(rows).IsEqualTo(3);
            await Assert.That(log).IsEqualTo("results dry FEA-20261015-0930|results FEA-20261015-0930");
        }

        [Test]
        public async Task Load_cases_in_plain_words()
        {
            var problems = new List<string>();
            var cases = StructuralPage.ParseCases("G: permanent, self-weight; Q: imposed; W: wind; X: heavy", problems);

            await Assert.That(string.Join(",", cases.Select(c => c.Name + "=" + c.Nature + (c.SelfWeight ? "+sw" : "")))).IsEqualTo("G=PERMANENT+sw,Q=EXPLOATATION,W=WIND");
            await Assert.That(problems.Single()).StartsWith("'X: heavy'");
        }
    }
}
