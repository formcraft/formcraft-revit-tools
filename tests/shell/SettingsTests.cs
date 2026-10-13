using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U06: one Settings page (boards account/PaneAccount, core/PaneSettings, */PaneSettings*).</summary>
    public class SettingsTests
    {
        private static readonly (FmcModule, ModuleStatus)[] Everything =
        {
            (FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Active),
            (FmcModule.Model, ModuleStatus.Trial), (FmcModule.Build, ModuleStatus.Active),
        };

        private sealed class Pane
        {
            public SectionsTests.TestLicence Licence { get; } = new SectionsTests.TestLicence();
            public InMemoryUserSettings Settings { get; }
            public ThemeService Theme { get; } = new ThemeService(PaneTheme.Light);
            public ShellViewModel Vm { get; }

            public Pane(InMemoryUserSettings? settings = null, params (FmcModule, ModuleStatus)[] modules)
            {
                Settings = settings ?? new InMemoryUserSettings();
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: Theme);
                Licence.Grant(modules.Length == 0 ? Everything : modules);
            }

            public SettingsViewModel S => Vm.Settings;
            public SettingsTab Tab(string name) => S.Tabs.Single(t => t.Name == name);
            public T Item<T>(string tab, string label) where T : SettingItem =>
                Tab(tab).Groups.SelectMany(g => g.Items).OfType<T>().Single(i => i.Label == label);
            public string Groups(string tab) => string.Join(" | ", Tab(tab).Groups.Select(g => g.Title));
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Account_and_General_always_then_a_tab_per_licensed_module()
        {
            var (all, someOnly) = OnSta(() =>
            {
                var a = string.Join(",", new Pane().S.TabNames);
                var s = string.Join(",", new Pane(null, (FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Active)).S.TabNames);
                return (a, s);
            });

            await Assert.That(all).IsEqualTo("Account,General,Manage,Flow,Model,Build,Updates");
            await Assert.That(someOnly).IsEqualTo("Account,General,Manage,Flow,Updates");
        }

        [Test]
        public async Task A_licence_change_adds_the_tab_at_once()
        {
            var (before, after) = OnSta(() =>
            {
                var p = new Pane(null, (FmcModule.Manage, ModuleStatus.Active));
                var b = string.Join(",", p.S.TabNames);
                p.Licence.Grant((FmcModule.Manage, ModuleStatus.Active), (FmcModule.Build, ModuleStatus.Trial));
                return (b, string.Join(",", p.S.TabNames));
            });

            await Assert.That(before).IsEqualTo("Account,General,Manage,Updates");
            await Assert.That(after).IsEqualTo("Account,General,Manage,Build,Updates");
        }

        [Test]
        [Arguments("General", "Modules | General · you | General · kit | General · pane | General · start-of-day card and notifications | General · defaults, privacy, updates | Module tabs | Author's considerations")]
        [Arguments("Manage", "Manage · parts in the pane | Manage · ribbon buttons | Manage · sync and start-of-day card | Manage · QA and issues | Manage · materials | Works with | Author's considerations")]
        [Arguments("Flow", "Flow · parts in the pane | Flow · ribbon buttons | Flow · touch | Flow · sheet layout and tags | Flow · 3D and shortcuts | Works with | Author's considerations")]
        [Arguments("Model", "Model · parts in the pane | Model · ribbon buttons | Model · systems | Model · structural | Model · enrich and links | Works with | Author's considerations")]
        [Arguments("Build", "Build · parts in the pane | Build · ribbon buttons | Build · views on the model | Build · BoQ and rates | Build · 4D and web app | Works with | Author's considerations")]
        public async Task Every_group_on_the_board_is_there(string tab, string groups)
        {
            var shown = OnSta(() => new Pane().Groups(tab));
            await Assert.That(shown).IsEqualTo(groups);
        }

        [Test]
        public async Task Values_save_and_reload()
        {
            var (choice, toggle, chips, considerations) = OnSta(() =>
            {
                var settings = new InMemoryUserSettings();
                var p = new Pane(settings);
                p.Item<ChoiceSetting>("Manage", "Remind me to sync after").Selected = "Never";
                p.Item<ToggleSetting>("Flow", "Touch on in this view").IsOn = true;
                p.Item<MultiSetting>("Model", "Systems I work on").Options.Single(o => o.Name == "HVAC").IsOn = true;
                var c = p.Tab("Build").Groups.SelectMany(g => g.Items).OfType<ConsiderationsSetting>().Single();
                c.Text = "Client prints A3.";
                c.SaveCommand.Execute(null);

                var again = new Pane(settings);
                return (again.Item<ChoiceSetting>("Manage", "Remind me to sync after").Selected,
                        again.Item<ToggleSetting>("Flow", "Touch on in this view").IsOn,
                        string.Join(",", again.Item<MultiSetting>("Model", "Systems I work on").On),
                        again.Tab("Build").Groups.SelectMany(g => g.Items).OfType<ConsiderationsSetting>().Single().Text);
            });

            await Assert.That(choice).IsEqualTo("Never");
            await Assert.That(toggle).IsTrue();
            await Assert.That(chips).IsEqualTo("Power,Small power,Lighting,HVAC");
            await Assert.That(considerations).IsEqualTo("Client prints A3.");
        }

        [Test]
        public async Task Locked_rows_never_change()
        {
            var (approval, outsiders) = OnSta(() =>
            {
                var p = new Pane();
                var a = p.Item<ToggleSetting>("Model", "Section changes need SEoR approval");
                a.IsOn = false;
                var o = p.Item<ToggleSetting>("Build", "Outsiders' accounts");
                o.IsOn = true;
                return ((a.Locked, a.IsOn), (o.Locked, o.IsOn));
            });

            await Assert.That(approval.Item1).IsTrue();
            await Assert.That(approval.Item2).IsTrue();
            await Assert.That(outsiders.Item1).IsTrue();
            await Assert.That(outsiders.Item2).IsFalse();
        }

        [Test]
        public async Task The_theme_setting_drives_the_pane_and_comes_back_next_time()
        {
            var (now, restored) = OnSta(() =>
            {
                var settings = new InMemoryUserSettings();
                var p = new Pane(settings);
                p.Item<ChoiceSetting>("General", "Theme").Selected = "Dark";
                var n = p.Theme.Choice;
                return (n, new Pane(settings).Theme.Choice);
            });

            await Assert.That(now).IsEqualTo(ThemeChoice.Dark);
            await Assert.That(restored).IsEqualTo(ThemeChoice.Dark);
        }

        [Test]
        public async Task Parts_chips_in_a_module_tab_switch_the_pane()
        {
            var (groups, same) = OnSta(() =>
            {
                var p = new Pane();
                var parts = p.Item<PartsSetting>("Manage", "Show these parts");
                parts.Parts.Switches.Single(s => s.Name == "Team").IsOn = false;
                return (string.Join(",", p.Vm.Groups.Select(g => g.Name)), ReferenceEquals(parts.Parts, p.Vm.Parts.Single(m => m.Module == FmcModule.Manage)));
            });

            await Assert.That(groups).IsEqualTo("Setup,Drawings,Check,Engineer,Build");
            await Assert.That(same).IsTrue();
        }

        [Test]
        public async Task Works_with_follows_the_licence()
        {
            var rows = OnSta(() =>
            {
                var p = new Pane(null, (FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Active));
                return string.Join(" | ", p.Tab("Manage").Groups.SelectMany(g => g.Items).OfType<WorksWithSetting>().Single().Rows.Select(r => r.Text + " = " + r.Status));
            });

            await Assert.That(rows).IsEqualTo("Core: pane, Connect AI, log file, roles = Always | Flow: sheet and annotation rules = Licensed | Model: families, materials, QA = Not licensed | Build: schedules and issues = Not licensed");
        }

        [Test]
        public async Task Reset_mine_asks_then_puts_the_defaults_back()
        {
            var (title, before, after, tab) = OnSta(() =>
            {
                var p = new Pane();
                p.Item<ChoiceSetting>("Manage", "Remind me to sync after").Selected = "Never";
                p.Vm.OpenSettingsCommand.Execute(null);
                p.Vm.ResetSettingsCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                var b = p.Item<ChoiceSetting>("Manage", "Remind me to sync after").Selected;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, b, p.Item<ChoiceSetting>("Manage", "Remind me to sync after").Selected, p.S.TabNames.Count);
            });

            await Assert.That(title).IsEqualTo("Reset my settings");
            await Assert.That(before).IsEqualTo("Never");
            await Assert.That(after).IsEqualTo("2 hours");
            await Assert.That(tab).IsEqualTo(7);
        }

        [Test]
        public async Task The_footer_has_Save_and_Reset_mine_on_Settings()
        {
            var (inSettings, inSection) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.Screen = ShellScreen.Main;
                p.Vm.OpenSettingsCommand.Execute(null);
                var a = string.Join(",", p.Vm.FooterActions.Select(f => f.Label));
                p.Vm.OpenSettingsCommand.Execute(null);
                return (a, string.Join(",", p.Vm.FooterActions.Select(f => f.Label)));
            });

            await Assert.That(inSettings).IsEqualTo("Save,Reset mine");
            await Assert.That(inSection).IsEqualTo("");
        }

        [Test]
        public async Task A_setting_found_by_search_opens_its_tab()
        {
            var (open, tab) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.Search.Query = "sheet grid";
                p.Vm.Search.OpenSelected();
                return (p.Vm.SettingsOpen, p.S.CurrentName);
            });

            await Assert.That(open).IsTrue();
            await Assert.That(tab).IsEqualTo("Flow");
        }

        [Test]
        public async Task The_open_tab_is_remembered()
        {
            var tab = OnSta(() =>
            {
                var settings = new InMemoryUserSettings();
                new Pane(settings).S.Open("Model");
                return new Pane(settings).S.CurrentName;
            });

            await Assert.That(tab).IsEqualTo("Model");
        }

        [Test]
        public async Task Account_shows_modules_with_request_and_a_licence_key_dialog()
        {
            var (rows, request, keyError, keyOk) = OnSta(() =>
            {
                var p = new MockLicenceService();
                var vm = new ShellViewModel(p, new MockConnectionService(), new MockDocumentContext(), new InMemoryUserSettings(), theme: new ThemeService());
                p.SignInAsync("a@formcraft.example", "x").GetAwaiter().GetResult();
                p.VerifyCodeAsync("123456").GetAwaiter().GetResult();
                var r = string.Join(" | ", vm.Account.Modules.Select(m => m.Name + " " + m.Status.Split('·')[0].Trim() + (m.CanRequest ? " [" + m.RequestText + "]" : "")));
                vm.Account.RequestModuleCommand.Execute(vm.Account.Modules.Single(m => m.CanRequest));
                var req = vm.Status;
                vm.Account.EnterKeyCommand.Execute(null);
                vm.Dialog!.Input = "nonsense";
                vm.Dialog.ConfirmCommand!.Execute(null);
                var err = vm.Dialog.Error;
                vm.Dialog.Input = "FMC-1234-5678";
                vm.Dialog.ConfirmCommand!.Execute(null);
                return (r, req, err, vm.Dialog == null ? vm.Status : "still open");
            });

            await Assert.That(rows).IsEqualTo("Core Included | Manage Active | Flow Active | Model Trial | Build Not on your licence [Request Build]");
            await Assert.That(request).IsEqualTo("Request for Build sent to your admin (Admin › Licences and seats › Requests).");
            await Assert.That(keyError).IsEqualTo("That key wasn't accepted. Check it on the Formcraft account website.");
            await Assert.That(keyOk).IsEqualTo("Licence key activated.");
        }
    }
}
