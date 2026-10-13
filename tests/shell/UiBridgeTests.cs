using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U11: what the fmc_ui MCP tool reads from the pane and the few things it may do to it.</summary>
    public class UiBridgeTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }
            public UiBridge Bridge { get; }

            public Pane(bool signedIn = true, bool allowMock = true)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService());
                Bridge = new UiBridge(Vm, Licence, allowMock, () => null);
                if (signedIn) Licence.SetSignedIn();
            }
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Signed_out_pane_reports_the_sign_in_screen()
        {
            var s = OnSta(() => new Pane(signedIn: false).Bridge.GetState());
            await Assert.That(s["screen"]).IsEqualTo("SignIn");
            await Assert.That(s["signed_in"]).IsEqualTo(false);
            await Assert.That(s["page"]).IsNull();
        }

        [Test]
        public async Task State_lists_licence_groups_and_footer()
        {
            var (screen, modules, groups, actions) = OnSta(() =>
            {
                var s = new Pane().Bridge.OpenSection("Settings");
                var licence = (Dictionary<string, object?>)s["licence"]!;
                var g = ((List<Dictionary<string, object?>>)s["groups"]!).Select(x => (string)x["name"]!).ToList();
                var footer = (Dictionary<string, object?>)s["footer"]!;
                return ((string)s["screen"]!, (Dictionary<string, object?>)licence["modules"]!, g, (List<string>)footer["actions"]!);
            });
            await Assert.That(screen).IsEqualTo("Main");
            await Assert.That(modules["Build"]).IsEqualTo("NotLicensed");
            await Assert.That(modules["Model"]).IsEqualTo("Trial");
            await Assert.That(groups).Contains("Setup");
            await Assert.That(actions.Count).IsGreaterThan(0);
        }

        [Test]
        public async Task Open_section_by_name_or_group_and_name()
        {
            var (a, b) = OnSta(() =>
            {
                var p = new Pane();
                var one = p.Bridge.OpenSection("qa");
                var two = p.Bridge.OpenSection("Setup > Templates");
                return ((string)one["group"]! + "|" + one["section"], (string)two["group"]! + "|" + two["section"] + "|" + two["page"]);
            });
            await Assert.That(a).IsEqualTo("Check|QA");
            await Assert.That(b).IsEqualTo("Setup|Templates|Section");
        }

        [Test]
        public async Task Open_settings_tab_and_header_pages()
        {
            var (tab, connect, admin) = OnSta(() =>
            {
                var p = new Pane();
                var settings = p.Bridge.OpenSection("Settings › flow");
                var c = p.Bridge.OpenSection("Connect");
                var ad = p.Bridge.OpenSection("Admin");
                return ((string)settings["page"]! + "|" + settings["settings_tab"], (string)c["page"]!, (string)ad["page"]!);
            });
            await Assert.That(tab).IsEqualTo("Settings|Flow");
            await Assert.That(connect).IsEqualTo("Connect");
            await Assert.That(admin).IsEqualTo("Admin");
        }

        [Test]
        public async Task Unknown_section_says_what_can_be_opened()
        {
            var message = OnSta(() =>
            {
                try { new Pane().Bridge.OpenSection("Nowhere"); return ""; }
                catch (ArgumentException e) { return e.Message; }
            });
            await Assert.That(message).Contains("No section \"Nowhere\"");
            await Assert.That(message).Contains("Check › QA");
        }

        [Test]
        public async Task Open_section_before_sign_in_is_refused()
        {
            var message = OnSta(() =>
            {
                try { new Pane(signedIn: false).Bridge.OpenSection("QA"); return ""; }
                catch (InvalidOperationException e) { return e.Message; }
            });
            await Assert.That(message).Contains("Sign in");
        }

        [Test]
        public async Task Mock_licence_is_refused_outside_test_builds()
        {
            var message = OnSta(() =>
            {
                try { new Pane(allowMock: false).Bridge.SetMockLicence("grace_over"); return ""; }
                catch (InvalidOperationException e) { return e.Message; }
            });
            await Assert.That(message).Contains("test builds only");
        }

        [Test]
        public async Task Mock_licence_presets_and_modules_change_what_the_pane_shows()
        {
            var (banner, build, signedOut) = OnSta(() =>
            {
                var p = new Pane();
                var grace = p.Bridge.SetMockLicence("grace_over");
                var b = (Dictionary<string, object?>)grace["banner"]!;
                var modules = p.Bridge.SetMockLicence("online", new Dictionary<string, string> { ["build"] = "active" });
                var m = (Dictionary<string, object?>)((Dictionary<string, object?>)modules["licence"]!)["modules"]!;
                var o = p.Bridge.SetMockLicence("signed_out");
                return ((string)b["state"]!, (string)m["Build"]!, (string)o["screen"]!);
            });
            await Assert.That(banner).IsEqualTo("GraceOver");
            await Assert.That(build).IsEqualTo("Active");
            await Assert.That(signedOut).IsEqualTo("SignIn");
        }

        [Test]
        public async Task Unknown_preset_lists_the_presets()
        {
            var message = OnSta(() =>
            {
                try { new Pane().Bridge.SetMockLicence("trial_for_ever"); return ""; }
                catch (ArgumentException e) { return e.Message; }
            });
            await Assert.That(message).Contains("signed_in");
        }

        [Test]
        public async Task Screenshot_needs_the_pane_showing()
        {
            var message = OnSta(() =>
            {
                try { new Pane().Bridge.ScreenshotPane(System.IO.Path.GetTempPath()); return ""; }
                catch (InvalidOperationException e) { return e.Message; }
            });
            await Assert.That(message).Contains("isn't showing");
        }
    }
}
