using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U20: Team › Workshare (board manage/PaneWorkshare). The pane prepares the sync; it never syncs.</summary>
    public class WorksharePageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockWorkshareTools Tools { get; } = new MockWorkshareTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.code", "F26001");
                Settings.Set("settings.workshare.linked", "A|S");
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), workshare: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Workshare"));
                Vm.Workshare.RefreshCommand.Execute(null);
            }

            public WorksharePage Page => Vm.Workshare;
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Worksets_show_naming_problems_and_the_missing_standard_set()
        {
            var (states, missing) = OnSta(() =>
            {
                var p = new Pane();
                var table = p.Page.Groups.First(g => g.Title.StartsWith("Worksets")).Items.OfType<TableSetting>().Single();
                return (table.Rows.Select(r => r.Cells[2]).ToList(), p.Page.LastFacts!.Missing.ToList());
            });
            await Assert.That(states).IsEquivalentTo(new[] { "OK", "OK", "OK", "Fix" });
            await Assert.That(missing).IsEquivalentTo(new[] { "Z_Links_S", "A_Site" });
        }

        [Test]
        public async Task The_standard_set_is_created_only_after_a_dry_run_and_a_yes()
        {
            var runs = OnSta(() =>
            {
                var p = new Pane();
                p.Page.CreateCommand.Execute(null);
                var before = p.Tools.Created.Select(c => c.Dry).ToList();
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (before, p.Tools.Created.Select(c => c.Dry).ToList());
            });
            await Assert.That(runs.before).IsEquivalentTo(new[] { true });
            await Assert.That(runs.Item2).IsEquivalentTo(new[] { true, false });
        }

        [Test]
        public async Task The_sync_message_needs_what_you_did_and_keeps_the_fixed_format()
        {
            var (refused, message) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.ComposeCommand.Execute(null);
                var r = p.Page.Message;
                p.Settings.Set("settings.workshare.revision", "p02");
                p.Settings.Set("settings.workshare.worked", "ISS-0014");
                p.Settings.Set("settings.workshare.what", "Beam B12 reduced");
                p.Page.ComposeCommand.Execute(null);
                return (r, p.Page.Message);
            });
            await Assert.That(refused).IsEqualTo("");
            await Assert.That(message).IsEqualTo("F26001 | A | P02 | Worked: ISS-0014 | Beam B12 reduced | [name.b]");
        }

        [Test]
        public async Task Nothing_on_the_page_syncs()
        {
            var labels = OnSta(() => new Pane().Page.Groups.SelectMany(g => g.Items).OfType<ButtonsSetting>().SelectMany(b => b.Buttons).Select(b => b.Label).ToList());
            await Assert.That(labels.Any(l => l.StartsWith("Sync", StringComparison.OrdinalIgnoreCase))).IsFalse();
        }
    }
}
