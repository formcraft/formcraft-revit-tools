using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U22: Settings › Flow › Touch (board flow/PaneFlowTouch), live on Flow's touch engine.</summary>
    public class TouchTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockTouchService Touch { get; } = new MockTouchService();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(bool withTouch = true)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(),
                                        touch: withTouch ? Touch : null);
                Licence.SetSignedIn();
            }

            public SettingsTab Flow => Vm.Settings.Tabs.Single(t => t.Name == "Flow");
            public T Item<T>(string group, string label = "") where T : SettingItem =>
                Flow.Groups.Single(g => g.Title == group).Items.OfType<T>().First(i => label.Length == 0 || i.Label == label);
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Touch_in_the_quick_tools_opens_settings_on_flow()
        {
            var (page, tab) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.QuickToolCommand.Execute("Touch");
                return (p.Vm.Page, p.Vm.Settings.CurrentName);
            });
            await Assert.That(page).IsEqualTo(ShellPage.Settings);
            await Assert.That(tab).IsEqualTo("Flow");
        }

        [Test]
        public async Task Flow_tab_has_the_touch_groups_from_the_board()
        {
            var groups = OnSta(() => new Pane().Flow.Groups.Select(g => g.Title).ToList());
            await Assert.That(groups).Contains("Flow · touch");
            await Assert.That(groups).Contains("Flow · gestures");
            await Assert.That(groups).Contains("Flow · on the view");
        }

        [Test]
        public async Task Master_switch_drives_touch_and_follows_the_ribbon()
        {
            var (afterPane, shownAfterRibbon) = OnSta(() =>
            {
                var p = new Pane();
                var master = p.Item<ToggleSetting>("Flow · touch", "Touch on");
                master.IsOn = false;
                bool off = p.Touch.MasterOn;
                p.Touch.SetMaster(true); // the ribbon's Touch on
                return (off, master.IsOn);
            });
            await Assert.That(afterPane).IsFalse();
            await Assert.That(shownAfterRibbon).IsTrue();
        }

        [Test]
        public async Task Views_list_on_screen_then_background_and_switch_one_or_all()
        {
            var (onScreen, background, oneOn, allOff) = OnSta(() =>
            {
                var p = new Pane();
                var views = p.Item<TouchViewsSetting>("Flow · touch");
                var a = views.OnScreen.Select(v => v.Name + "|" + v.Type).ToList();
                var b = views.Background.Count;
                views.Background.First().On = true;
                bool one = p.Touch.Views.Single(v => v.Name == "Level 2 - GA Plan").On;
                views.AllOffCommand.Execute(null);
                bool all = views.OnScreen.Concat(views.Background).All(v => !v.On);
                return (a, b, one, all);
            });
            await Assert.That(onScreen[0]).IsEqualTo("Level 1 - GA Plan|Plan · active");
            await Assert.That(onScreen.Count).IsEqualTo(3);
            await Assert.That(background).IsEqualTo(2);
            await Assert.That(oneOn).IsTrue();
            await Assert.That(allOff).IsTrue();
        }

        [Test]
        public async Task Gestures_default_to_the_flow_plan_and_save_to_touch()
        {
            var (select, twoFinger, saved) = OnSta(() =>
            {
                var p = new Pane();
                var sel = p.Item<ChoiceSetting>("Flow · gestures", "Select elements with");
                var two = p.Item<ChoiceSetting>("Flow · gestures", "Two-finger tap");
                var s0 = sel.Selected;
                var t0 = two.Selected;
                sel.Selected = "Tap";
                return (s0, t0, p.Touch.Get(TouchKeys.SelectWith));
            });
            await Assert.That(select).IsEqualTo("Long press");
            await Assert.That(twoFinger).IsEqualTo("Right-click menu");
            await Assert.That(saved).IsEqualTo("Tap");
        }

        [Test]
        public async Task Reset_asks_first_then_puts_the_defaults_back()
        {
            var (title, after) = OnSta(() =>
            {
                var p = new Pane();
                p.Touch.Set(TouchKeys.Zoom, "Fast");
                var reset = p.Item<ButtonsSetting>("Flow · on the view").Buttons.Single(b => b.Label == "Reset touch settings");
                reset.Command.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, p.Touch.Get(TouchKeys.Zoom));
            });
            await Assert.That(title).IsEqualTo("Reset touch settings");
            await Assert.That(after).IsEqualTo("Normal");
        }

        [Test]
        public async Task Probe_opens_from_the_touch_page()
        {
            var opened = OnSta(() =>
            {
                var p = new Pane();
                p.Item<ButtonsSetting>("Flow · on the view").Buttons.Single(b => b.Label == "Touch probe").Command.Execute(null);
                return p.Touch.ProbeOpened;
            });
            await Assert.That(opened).IsEqualTo(1);
        }

        [Test]
        public async Task Without_touch_the_page_says_where_it_runs()
        {
            var text = OnSta(() => ((NoteSetting)new Pane(withTouch: false).Flow.Groups.Single(g => g.Title == "Flow · touch").Items[0]).Text);
            await Assert.That(text).Contains("Revit 2025");
        }

        [Test]
        public async Task Touch_that_failed_to_start_says_why_and_offers_the_probe()
        {
            var labels = OnSta(() =>
            {
                var p = new Pane(withTouch: false);
                var touch = new MockTouchService { Available = false, Problem = "Touch didn't start: the pointer hook failed." };
                var vm = new ShellViewModel(p.Licence, new MockConnectionService(), new MockDocumentContext(), p.Settings, theme: new ThemeService(), touch: touch);
                var g = vm.Settings.Tabs.Single(t => t.Name == "Flow").Groups.Single(x => x.Title == "Flow · touch");
                return ((NoteSetting)g.Items[0]).Text + " | " + string.Join(",", ((ButtonsSetting)g.Items[1]).Buttons.Select(b => b.Label));
            });
            await Assert.That(labels).IsEqualTo("Touch didn't start: the pointer hook failed. | Touch probe");
        }
    }
}
