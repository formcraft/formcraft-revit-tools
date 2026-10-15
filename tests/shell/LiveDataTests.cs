using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;
using revit_mcp_plugin.Fmc;

namespace Formcraft.Shell.Tests
{
    /// <summary>
    /// Keep FMC data filled (docs/LIVE_DATA.md): the updater's pure rules (plugin/Fmc/LiveDataRules.cs, compiled here as
    /// is) and the switch in Settings › Manage.
    /// </summary>
    public class LiveDataTests
    {
        // ---------- role code from the model's file name ----------

        [Test]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-E-0001.rvt", "E")]
        [Arguments(@"Z:\Projects\F26001\01_WIP\F26001-FMC-ZZ-ZZ-M3-FP-0001.rvt", "FP")]
        [Arguments(@"\\server\share\F26001-FMC-B1-01-M3-A-0002.rvt", "A")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-S-0001_jdoe.rvt", "S")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-LP-0001.0003.rvt", "LP")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-M-0001", "M")]
        public async Task The_role_comes_from_a_name_that_follows_the_naming_rule(string name, string role)
        {
            await Assert.That(LiveDataRules.RoleFromModelName(name)).IsEqualTo(role);
        }

        [Test]
        [Arguments("Project1.rvt")]
        [Arguments("F26001-FMC-ZZ-ZZ-E-0001.rvt")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-e-0001.rvt")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-ELEC-0001.rvt")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-E-XX01.rvt")]
        [Arguments("F26001-FMC-ZZ-ZZ-M3-E-0001-EXTRA.rvt")]
        [Arguments("")]
        public async Task A_name_that_doesnt_follow_the_rule_gives_no_role(string name)
        {
            await Assert.That(LiveDataRules.RoleFromModelName(name)).IsEqualTo("");
        }

        // ---------- circuit reference ----------

        [Test]
        [Arguments("DB-GF-01", "3", "DB-GF-01/3")]
        [Arguments(" DB-GF-01 ", " 1,3,5 ", "DB-GF-01/1,3,5")]
        [Arguments("DB-GF-01", "", "")]
        [Arguments("", "3", "")]
        public async Task The_circuit_reference_is_panel_slash_circuit(string panel, string circuit, string expected)
        {
            await Assert.That(LiveDataRules.CircuitRefFor(panel, circuit)).IsEqualTo(expected);
        }

        [Test]
        public async Task No_circuit_gives_no_reference()
        {
            await Assert.That(LiveDataRules.CircuitRefFor(null!, null!)).IsEqualTo("");
        }

        // ---------- when to write ----------

        [Test]
        [Arguments("", "E", false, true)]      // empty: filled
        [Arguments("E", "E", false, false)]    // already right
        [Arguments("A", "E", false, false)]    // a person typed another value: kept
        [Arguments("A", "E", true, true)]      // a pure copy that's stale: updated
        [Arguments("E", "", true, false)]      // nothing to write: never cleared
        [Arguments("  ", "E", false, true)]    // blanks count as empty
        public async Task Only_empty_or_stale_copies_are_written(string current, string proposed, bool pureCopy, bool write)
        {
            await Assert.That(LiveDataRules.ShouldWrite(current, proposed, pureCopy)).IsEqualTo(write);
        }

        [Test]
        public async Task The_updater_writes_only_its_derived_fields()
        {
            await Assert.That(string.Join(",", LiveDataRules.Fields)).IsEqualTo(
                "FMC_Keynote_Code,FMC_Code_Description,FMC_Code_Group,FMC_Role_Code,FMC_Panel_ID,FMC_Circuit_Ref,FMC_Data_Sync_Stamp");
        }

        [Test]
        public async Task The_stamp_is_kit_version_and_date()
        {
            var day = new DateTime(2026, 10, 15, 14, 30, 0);
            await Assert.That(LiveDataRules.Stamp("2.2", day)).IsEqualTo("FMC Kit v2.2 2026-10-15");
            await Assert.That(LiveDataRules.Stamp("", day)).IsEqualTo("FMC Kit ? 2026-10-15");
        }

        [Test]
        public async Task Keynotes_are_read_from_the_kit_table()
        {
            var codes = LiveDataRules.ParseKeynotes("\uFEFF# comment\r\nE\tElectrical\t\r\nE.SOC_01\tSocket outlet, twin 13 A\tE.SOC\r\nbad line\r\n");
            await Assert.That(codes.Count).IsEqualTo(2);
            await Assert.That(codes["E.SOC_01"].Description).IsEqualTo("Socket outlet, twin 13 A");
            await Assert.That(codes["E.SOC_01"].Group).IsEqualTo("E.SOC");
        }

        [Test]
        public async Task A_log_row_has_six_columns_and_quotes_commas()
        {
            var line = LiveDataRules.LogLine(new DateTime(2026, 10, 15, 9, 5, 0), "F26001-FMC-ZZ-ZZ-M3-E-0001", "123456",
                "FMC_Code_Description", "", "Socket outlet, \"twin\"");
            await Assert.That(LiveDataRules.LogHeader).IsEqualTo("timestamp,model,element_id,field,old,new");
            await Assert.That(line).IsEqualTo("2026-10-15T09:05:00,F26001-FMC-ZZ-ZZ-M3-E-0001,123456,FMC_Code_Description,,\"Socket outlet, \"\"twin\"\"\"");
        }

        // ---------- Settings › Manage ----------

        private sealed class Licence : ILicenceService
        {
            public Licence(string role, bool admin)
            {
                Current = new LicenceState(new Account("[NAME A]", "a@formcraft.example", "Formcraft", role, "Team", admin),
                    new[] { new ModuleLicence(FmcModule.Core, ModuleStatus.Included, null), new ModuleLicence(FmcModule.Manage, ModuleStatus.Active, null) },
                    DateTime.Now, 14);
            }

            public LicenceState Current { get; }
            public event EventHandler? Changed { add { } remove { } }
            public Task<SignInResult> SignInAsync(string email, string password) => throw new NotSupportedException();
            public Task<SignInResult> VerifyCodeAsync(string code) => throw new NotSupportedException();
            public Task<SignInResult> SignInWithAsync(SignInProvider provider) => throw new NotSupportedException();
            public Task<SignInResult> UseOfflineLicenceAsync(string path) => throw new NotSupportedException();
            public Task CheckNowAsync() => Task.CompletedTask;
            public Task SignOutAsync() => Task.CompletedTask;
            public Task ReleaseSeatAsync() => Task.CompletedTask;
            public Task<bool> ActivateKeyAsync(string key) => Task.FromResult(false);
            public Task RequestModuleAsync(FmcModule module) => Task.CompletedTask;
            public Task<bool> StartTrialAsync(FmcModule module) => Task.FromResult(false);
        }

        private static ShellViewModel Pane(ILiveDataService? live, string role = "BIM Manager", bool admin = false) =>
            new ShellViewModel(new Licence(role, admin), new MockConnectionService(), new MockDocumentContext(), new InMemoryUserSettings(),
                theme: new ThemeService(PaneTheme.Light), liveData: live);

        private static SettingsGroup Group(ShellViewModel vm) =>
            vm.Settings.Tabs.Single(t => t.Name == "Manage").Groups.Single(g => g.Title == SettingsViewModel.LiveDataGroup);

        private static string Value(SettingsGroup g, string label) =>
            g.Items.OfType<ReadOnlySetting>().Single(i => i.Label == label).Value;

        private static string Buttons(SettingsGroup g) =>
            string.Join(",", g.Items.OfType<ButtonsSetting>().SelectMany(b => b.Buttons).Select(b => b.Label));

        [Test]
        public async Task The_BIM_Manager_switches_it_on_after_a_yes_and_off_again()
        {
            var (before, buttons, asked, after, offButton, status, off) = Sta.Run(() =>
            {
                var live = new MockLiveDataService();
                var vm = Pane(live);
                var b = Value(Group(vm), "This project");
                var btn = Buttons(Group(vm));
                Group(vm).Items.OfType<ButtonsSetting>().Single().Buttons.Single().Command.Execute(null);
                var a = vm.Dialog?.Title ?? "";
                vm.Dialog!.ConfirmCommand!.Execute(null);
                var on = Value(Group(vm), "This project");
                var ob = Buttons(Group(vm));
                var st = vm.Status;
                live.SetOn(false, _ => { });
                return (b, btn, a, on, ob, st, Value(Group(vm), "This project"));
            });

            await Assert.That(before).IsEqualTo("Off");
            await Assert.That(buttons).IsEqualTo("Switch on for this project");
            await Assert.That(asked).IsEqualTo("Keep FMC data filled");
            await Assert.That(after).StartsWith("On · switched on by BIM Manager");
            await Assert.That(offButton).IsEqualTo("Switch off for this project");
            await Assert.That(status).Contains("is on for this project");
            await Assert.That(off).IsEqualTo("Off");
        }

        [Test]
        public async Task Only_the_BIM_Manager_or_an_admin_can_switch_it()
        {
            var (modeller, admin) = Sta.Run(() =>
            {
                var m = Pane(new MockLiveDataService(), role: "Modeller");
                var a = Pane(new MockLiveDataService(), role: "BIM Coordinator", admin: true);
                return (Buttons(Group(m)) + "|" + string.Join("|", Group(m).Items.OfType<NoteSetting>().Select(n => n.Text)), Buttons(Group(a)));
            });

            await Assert.That(modeller).StartsWith("|Only the BIM Manager switches this on or off");
            await Assert.That(admin).IsEqualTo("Switch on for this project");
        }

        [Test]
        public async Task A_family_or_no_model_shows_why_and_no_switch()
        {
            var (family, buttons) = Sta.Run(() =>
            {
                var live = new MockLiveDataService();
                var vm = Pane(live);
                live.Show(new LiveDataState("Door.rfa", false, false, why: "Families don't use it: it runs in project models."));
                return (Group(vm).Items.OfType<ReadOnlySetting>().First().Hint, Buttons(Group(vm)));
            });

            await Assert.That(family).IsEqualTo("Families don't use it: it runs in project models.");
            await Assert.That(buttons).IsEqualTo("");
        }

        [Test]
        public async Task Outside_Revit_the_group_says_where_it_runs()
        {
            var first = Sta.Run(() => Group(Pane(null)).Items.OfType<NoteSetting>().First().Text);
            await Assert.That(first).IsEqualTo("Keep FMC data filled runs in Revit, from the Formcraft add-in.");
        }
    }
}
