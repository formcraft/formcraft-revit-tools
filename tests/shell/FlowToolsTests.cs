using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U22: Flow's view tools from the quick tools strip, and Settings › Flow › Keyboard Shortcuts.</summary>
    public class FlowToolsTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockFlowTools Flow { get; } = new MockFlowTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), flow: Flow);
                Licence.SetSignedIn();
            }
        }

        [Test]
        public async Task Quick_tools_run_in_revit_and_say_what_to_do_next()
        {
            var (ran, status) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Vm.QuickToolCommand.Execute("Section Box");
                var s = p.Vm.Status;
                p.Vm.QuickToolCommand.Execute("Tag Tidy");
                p.Vm.QuickToolCommand.Execute("Align");
                return (string.Join(",", p.Flow.Ran), s);
            });

            await Assert.That(ran).IsEqualTo("Section Box,Tag Tidy,Align");
            await Assert.That(status).Contains("drag the area");
        }

        [Test]
        public async Task Touch_still_opens_settings_and_runs_nothing()
        {
            var ran = Sta.Run(() =>
            {
                var p = new Pane();
                p.Vm.QuickToolCommand.Execute("Touch");
                return p.Flow.Ran.Count;
            });

            await Assert.That(ran).IsEqualTo(0);
        }

        [Test]
        public async Task Keyboard_shortcuts_says_the_kit_has_no_standard_then_opens_revits_dialog()
        {
            var (title, message, before, after) = Sta.Run(() =>
            {
                var p = new Pane();
                var flow = p.Vm.Settings.Tabs.Single(t => t.Name == "Flow");
                var button = flow.Groups.Single(g => g.Title == "Flow · 3D and shortcuts").Items.OfType<ButtonsSetting>().Single()
                    .Buttons.Single(b => b.Label == "Keyboard Shortcuts");
                button.Command.Execute(null);
                var t = p.Vm.Dialog!.Title;
                var m = p.Vm.Dialog.Message;
                var b = p.Flow.Ran.Count;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, m, b, string.Join(",", p.Flow.Ran));
            });

            await Assert.That(title).IsEqualTo("Keyboard Shortcuts");
            await Assert.That(message).Contains("no Formcraft shortcuts file");
            await Assert.That(before).IsEqualTo(0);
            await Assert.That(after).IsEqualTo("Shortcuts import");
        }
    }
}
