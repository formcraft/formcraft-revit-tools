using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U08: the states of board account/PaneStates. Each says what happened and the next step; typed input stays.</summary>
    public class StatesTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockConnectionService Connection { get; } = new MockConnectionService();
            public MockDocumentContext Document { get; } = new MockDocumentContext();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, Connection, Document, Settings, theme: new ThemeService());
                Licence.SignInAsync("a@formcraft.example", "x").GetAwaiter().GetResult();
                Licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
            }

            public string Banner => Vm.StateBanner == null ? "none" : Vm.StateBanner.Says + " | " + Vm.StateBanner.StillWorks + " | " + (Vm.StateBanner.Action ?? "-");
            public void Open(string section) => Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == section));
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task All_is_well_shows_no_banner()
        {
            var (state, banner) = OnSta(() => { var p = new Pane(); return (p.Vm.State, p.Banner); });
            await Assert.That(state).IsEqualTo(PaneState.Normal);
            await Assert.That(banner).IsEqualTo("none");
        }

        [Test]
        public async Task Offline_says_when_it_was_checked_and_how_long_is_left()
        {
            var banner = OnSta(() => { var p = new Pane(); p.Licence.SetOffline(3, 11); return p.Banner; });
            await Assert.That(banner).IsEqualTo("Licence checked 3 days ago · 11 days left | Everything still works | Check now");
        }

        [Test]
        public async Task Check_now_goes_back_online()
        {
            var state = OnSta(() =>
            {
                var p = new Pane();
                p.Licence.SetOffline(3, 11);
                p.Vm.StateBanner!.Command!.Execute(null);
                return p.Vm.State;
            });
            await Assert.That(state).IsEqualTo(PaneState.Normal);
        }

        [Test]
        public async Task Grace_over_locks_sections_but_not_Connect()
        {
            var (banner, locked, connect) = OnSta(() =>
            {
                var p = new Pane();
                p.Licence.SetGraceOver();
                var b = p.Banner;
                var l = p.Vm.Body!.Locked && p.Vm.Body.GraceOver;
                p.Vm.OpenConnectCommand.Execute(null);
                return (b, l, p.Vm.Body!.Locked);
            });

            await Assert.That(banner).IsEqualTo("Sign in to keep using Formcraft | Connect, Log and Help still work | Sign in");
            await Assert.That(locked).IsTrue();
            await Assert.That(connect).IsFalse();
        }

        [Test]
        public async Task Not_connected_shows_on_the_chip_only_and_the_chip_opens_Connect()
        {
            var (banner, tip, page) = OnSta(() =>
            {
                var p = new Pane();
                p.Connection.Set(ConnectionState.NotConnected);
                var b = p.Banner;
                var t = p.Vm.ConnectionTip;
                p.Vm.OpenConnectCommand.Execute(null);
                return (b, t, p.Vm.Page);
            });

            await Assert.That(banner).IsEqualTo("none");
            await Assert.That(tip).Contains("click to open Connect");
            await Assert.That(page).IsEqualTo(ShellPage.Connect);
        }

        [Test]
        public async Task Kit_missing_points_to_Settings_and_clears_when_the_kit_is_found()
        {
            var (banner, page, tab, after) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.Set(SettingKeys.KitFolder, Path.Combine(Path.GetTempPath(), "no-kit-" + Guid.NewGuid().ToString("N")));
                var b = p.Banner;
                p.Vm.StateBanner!.Command!.Execute(null);
                var pg = p.Vm.Page;
                var t = p.Vm.Settings.CurrentName;
                p.Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                return (b, pg, t, p.Vm.State);
            });

            await Assert.That(banner).IsEqualTo("Point to the kit folder in Settings | Connect and Settings still work | Open Settings");
            await Assert.That(page).IsEqualTo(ShellPage.Settings);
            await Assert.That(tab).IsEqualTo("General");
            await Assert.That(after).IsEqualTo(PaneState.Normal);
        }

        [Test]
        public async Task Revit_busy_starts_nothing_new()
        {
            var (banner, ready, busy) = OnSta(() =>
            {
                var p = new Pane();
                p.Connection.Set(ConnectionState.RevitBusy);
                return (p.Banner, p.Vm.RevitReady, p.Vm.StateBanner!.IsBusy);
            });

            await Assert.That(banner).IsEqualTo("Waiting for Revit to finish… | Nothing new starts until Revit is ready | -");
            await Assert.That(ready).IsFalse();
            await Assert.That(busy).IsTrue();
        }

        [Test]
        public async Task Live_model_is_the_document_banner()
        {
            var (doc, state) = OnSta(() =>
            {
                var p = new Pane();
                p.Document.Open(MockDocumentContext.LiveProject);
                return (p.Vm.Document.LockText, p.Vm.State);
            });

            await Assert.That(doc).IsEqualTo("Live project: AI reads and reports");
            await Assert.That(state).IsEqualTo(PaneState.Normal);
        }

        [Test]
        public async Task The_most_urgent_state_wins()
        {
            var (both, graceAndConnection) = OnSta(() =>
            {
                var p = new Pane();
                p.Licence.SetOffline(2, 12);
                p.Connection.Set(ConnectionState.NotConnected);
                var b = p.Vm.State;
                p.Licence.SetGraceOver();
                return (b, p.Vm.State);
            });

            await Assert.That(both).IsEqualTo(PaneState.Offline);
            await Assert.That(graceAndConnection).IsEqualTo(PaneState.GraceOver);
        }

        [Test]
        public async Task Not_licensed_offers_a_trial_and_the_trial_unlocks_it()
        {
            var (text, adds, footer, after, status) = OnSta(() =>
            {
                var p = new Pane();
                p.Licence.SetModule(FmcModule.Model, ModuleStatus.NotLicensed);
                p.Vm.Screen = ShellScreen.Main;
                p.Open("Systems");
                var t = p.Vm.Body!.LockedText;
                var a = p.Vm.Body.WhatItAdds;
                var f = string.Join(",", p.Vm.FooterActions.Select(x => x.Label));
                p.Vm.StartTrialCommand.Execute(null);
                return (t, a, f, p.Vm.Body!.Locked, p.Vm.Status);
            });

            await Assert.That(text).IsEqualTo("Formcraft Model isn't on your licence.");
            await Assert.That(adds).IsEqualTo("Start from brief, MEP systems, structural checks, quantities");
            await Assert.That(footer).IsEqualTo("Start a trial");
            await Assert.That(after).IsFalse();
            await Assert.That(status).IsEqualTo("Formcraft Model trial started: 14 days.");
        }

        [Test]
        public async Task Opening_a_section_from_another_group_brings_its_group()
        {
            var group = OnSta(() => { var p = new Pane(); p.Open("Systems"); return p.Vm.CurrentGroup!.Name; });
            await Assert.That(group).IsEqualTo("Engineer");
        }

        [Test]
        public async Task Typed_input_is_never_lost_when_the_state_changes()
        {
            var (query, code) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.Search.Query = "sheet";
                p.Vm.Account.EnterKeyCommand.Execute(null);
                p.Vm.Dialog!.Input = "FMC-12";
                p.Licence.SetOffline(3, 11);
                p.Connection.Set(ConnectionState.RevitBusy);
                p.Connection.Set(ConnectionState.Connected);
                return (p.Vm.Search.Query, p.Vm.Dialog?.Input);
            });

            await Assert.That(query).IsEqualTo("sheet");
            await Assert.That(code).IsEqualTo("FMC-12");
        }
    }
}
