using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U12: Connect (board core/PaneConnect) on live values from the host.</summary>
    public class ConnectTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockConnectInfo Info { get; } = new MockConnectInfo();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(bool kit = true)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                if (kit) Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), connect: Info);
                Licence.SetSignedIn();
                Vm.OpenConnectCommand.Execute(null);
            }

            public SettingsGroup Group(string title) => Vm.Connect.Groups.Single(g => g.Title == title);
            public CheckListSetting Health => Group("Start-up health check").Items.OfType<CheckListSetting>().Single();
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Connect_has_the_groups_and_footer_of_the_board()
        {
            var (groups, footer, placeholder) = OnSta(() =>
            {
                var p = new Pane();
                return (p.Vm.Connect.Groups.Select(g => g.Title).ToList(), string.Join(",", p.Vm.FooterActions.Select(a => a.Label)), p.Vm.ShowSection);
            });
            await Assert.That(groups).IsEquivalentTo(new[] { "Start-up health check", "Kit and rules", "Folders the plugin may write",
                "AI connection (MCP) · experimental", "AI buttons · Phase 2", "Safety", "Support", "Author's considerations" });
            await Assert.That(footer).IsEqualTo("Health check,Feedback");
            await Assert.That(placeholder).IsFalse();
        }

        [Test]
        public async Task Health_check_has_host_kit_licence_and_ai_lines()
        {
            var labels = OnSta(() => new Pane().Health.Rows.Select(r => r.Label + "=" + r.Status).ToList());
            await Assert.That(labels).Contains("fmc_guard.json=Found");
            await Assert.That(labels).Contains("FMC Kit folder=Sample kit");
            await Assert.That(labels.Any(l => l.StartsWith("Licence="))).IsTrue();
            await Assert.That(labels).Contains("AI service=Not used yet");
        }

        [Test]
        public async Task A_missing_guard_offers_its_fix_and_the_fix_clears_it()
        {
            var (fix, after) = OnSta(() =>
            {
                var p = new Pane();
                p.Info.SetGuardMissing();
                var row = p.Health.Rows.Single(r => r.Label == "fmc_guard.json");
                var label = row.FixLabel + "|" + row.HasFix;
                row.FixCommand!.Execute(null);
                return (label, p.Health.Rows.Single(r => r.Label == "fmc_guard.json").Status);
            });
            await Assert.That(fix).IsEqualTo("Create from example…|True");
            await Assert.That(after).IsEqualTo("Found");
        }

        [Test]
        public async Task No_kit_says_so_and_points_to_settings()
        {
            var (status, page) = OnSta(() =>
            {
                var p = new Pane(kit: false);
                var row = p.Health.Rows.Single(r => r.Label == "FMC Kit folder");
                row.FixCommand!.Execute(null);
                return (row.Status, p.Vm.Settings.CurrentName);
            });
            await Assert.That(status).IsEqualTo("Not set");
            await Assert.That(page).IsEqualTo("General");
        }

        [Test]
        public async Task Switch_on_when_Revit_starts_is_saved_per_person()
        {
            var saved = OnSta(() =>
            {
                var p = new Pane();
                p.Group("AI connection (MCP) · experimental").Items.OfType<ToggleSetting>().Single(t => t.Label == "Switch on when Revit starts").IsOn = false;
                return p.Settings.Get("settings." + ConnectViewModel.AutoStartKey);
            });
            // On by default (fmc_connect.json start_with_revit); switching it off is saved.
            await Assert.That(saved).IsEqualTo("false");
        }

        [Test]
        public async Task Mcp_switch_starts_and_stops_the_service()
        {
            var (on, off) = OnSta(() =>
            {
                var p = new Pane();
                p.Group("AI connection (MCP) · experimental").Items.OfType<ToggleSetting>().First().IsOn = true;
                bool a = p.Info.ServiceRunning;
                p.Group("AI connection (MCP) · experimental").Items.OfType<ToggleSetting>().First().IsOn = false;
                return (a, p.Info.ServiceRunning);
            });
            await Assert.That(on).IsTrue();
            await Assert.That(off).IsFalse();
        }

        [Test]
        public async Task Shared_models_is_the_persons_own_switch_and_admin_only_shows_where()
        {
            var (saved, locks, admin) = OnSta(() =>
            {
                var p = new Pane();
                var safety = p.Group("Safety").Items.OfType<ToggleSetting>().ToList();
                safety.Single(t => t.Label == "AI in shared models").IsOn = true;
                var lockedLabels = string.Join(",", safety.Where(t => t.Locked).Select(t => t.Label));
                var adminRow = p.Vm.Admin.Groups.SelectMany(g => g.Items)
                                .OfType<ReadOnlySetting>().Single(r => r.Label == "AI in shared models").Value;
                return (p.Settings.Get("settings." + ConnectViewModel.SharedModelsKey), lockedLabels, adminRow);
            });
            await Assert.That(saved).IsEqualTo("true");
            await Assert.That(locks).IsEqualTo("Live-model lock,Dry run first,AI never saves, syncs or moves coordinates");
            await Assert.That(admin).Contains("Connect › Safety");
        }

        [Test]
        public async Task Feedback_needs_a_line_then_saves_it()
        {
            var (error, saved) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.Connect.FeedbackCommand.Execute(null);
                var dialog = p.Vm.Dialog!;
                dialog.ConfirmCommand!.Execute(null);
                var e = dialog.Error;
                dialog.Items.OfType<TextSetting>().Single().Value = "Tag Tidy moved a tag onto a wall.";
                dialog.ConfirmCommand!.Execute(null);
                return (e, p.Info.LastFeedback);
            });
            await Assert.That(error).Contains("what happened");
            await Assert.That(saved).Contains("Tag Tidy moved a tag onto a wall.");
        }

        [Test]
        public async Task Probe_reports_in_plain_words()
        {
            var status = OnSta(() =>
            {
                var p = new Pane();
                p.Group("AI connection (MCP) · experimental").Items.OfType<ButtonsSetting>().Single().Buttons.Single().Command.Execute(null);
                return p.Vm.Status;
            });
            await Assert.That(status).Contains("AI connection is off");
        }
    }
}
