using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U20: Team › Links (board manage/PaneLinks).</summary>
    public class LinksPageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockLinkTools Tools { get; } = new MockLinkTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), links: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Links"));
            }

            public LinksPage Page => Vm.Links;
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Opening_audits_links_from_the_projects_02_Shared()
        {
            var (folder, states) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.AuditCommand.Execute(null);
                var table = p.Page.Groups.Single(g => g.Title == "Links").Items.OfType<TableSetting>().Single();
                return (p.Tools.Folders.Last(), table.Rows.Select(r => r.Cells[2]).ToList());
            });
            await Assert.That(folder).IsEqualTo(@"Z:\Projects\F26001\02_Shared");
            await Assert.That(states).IsEquivalentTo(new[] { "OK", "Fix", "OK" });
        }

        [Test]
        public async Task Link_offers_only_unlinked_models_other_than_this_one_then_dry_runs_before_linking()
        {
            var (options, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.LinkCommand.Execute(null);
                var o = p.Vm.Dialog!.Items.OfType<MultiSetting>().Single().Options.Select(x => x.Name).ToList();
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (o, p.Tools.Linked.Select(l => l.Dry).ToList());
            });
            await Assert.That(options).IsEquivalentTo(new[] { "F26001-FMC-ZZ-ZZ-M3-E-0001.rvt" });
            await Assert.That(runs).IsEquivalentTo(new[] { true, false });
        }

        [Test]
        public async Task Pin_all_asks_after_a_dry_run()
        {
            var pins = OnSta(() =>
            {
                var p = new Pane();
                p.Page.PinCommand.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return p.Tools.Pins.ToList();
            });
            await Assert.That(pins).IsEquivalentTo(new[] { true, false });
        }
    }
}
