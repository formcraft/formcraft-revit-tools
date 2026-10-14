using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U18: Setup › Materials (board manage/PaneMaterials).</summary>
    public class MaterialsPageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockMaterialTools Tools { get; } = new MockMaterialTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), materials: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Materials"));
            }

            public MaterialsPage Page => Vm.Materials;
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task The_database_lists_materials_filters_by_class_and_shows_one()
        {
            var (all, finishes, keynote, maps) = OnSta(() =>
            {
                var p = new Pane();
                var a = p.Page.Database!.Materials.Count;
                p.Settings.Set("settings.materials.class", "Finishes");
                p.Page.Load().GetAwaiter().GetResult();
                var f = p.Page.Database!.Materials.Select(m => m.Name).ToList();
                p.Page.Select("FMC_Tile_Porcelain_600");
                var sel = p.Page.Groups.Single(g => g.Title == "Selected · FMC_Tile_Porcelain_600");
                return (a, f, sel.Items.OfType<ReadOnlySetting>().Single(r => r.Label == "Keynote").Value,
                        sel.Items.OfType<TableSetting>().Single().Rows.Count);
            });
            await Assert.That(all).IsEqualTo(5);
            await Assert.That(finishes).IsEquivalentTo(new[] { "FMC_Paint_Int_Matt_White", "FMC_Tile_Porcelain_600" });
            await Assert.That(keynote).IsEqualTo("F.TIL_02");
            await Assert.That(maps).IsEqualTo(2);
        }

        [Test]
        public async Task Assign_needs_a_material_then_dry_runs_and_applies_after_a_yes()
        {
            var (warning, title, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.AssignCommand.Execute(null);
                var w = p.Page.AssignMessages.Lines.Single().Text;
                p.Page.Select("FMC_Tile_Porcelain_600");
                p.Page.AssignCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (w, t, p.Tools.Assigns.Select(a => a.Dry).ToList());
            });
            await Assert.That(warning).Contains("Pick a material");
            await Assert.That(title).IsEqualTo("Assign FMC_Tile_Porcelain_600 · dry run");
            await Assert.That(runs).IsEquivalentTo(new[] { true, false });
        }

        [Test]
        public async Task The_audit_lists_its_checks_and_purge_asks_first()
        {
            var (checks, purges) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.AuditCommand.Execute(null);
                var c = p.Page.Groups.Single(g => g.Title == "Audit this model").Items.OfType<CheckListSetting>().Single().Rows.Select(r => r.Status).ToList();
                p.Page.PurgeCommand.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (c, p.Tools.Purges.ToList());
            });
            await Assert.That(checks).IsEquivalentTo(new[] { "17 · Warn", "6 · Warn", "4 · Fail", "38 · Info", "11 · Warn" });
            await Assert.That(purges).IsEquivalentTo(new[] { true, false });
        }

        [Test]
        public async Task A_new_material_is_a_request()
        {
            var request = OnSta(() =>
            {
                var p = new Pane();
                p.Page.RequestCommand.Execute(null);
                p.Vm.Dialog!.Items.OfType<TextSetting>().First().Value = "FMC_Tile_Terrazzo_400";
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return p.Tools.Requests.Single();
            });
            await Assert.That(request).StartsWith("FMC_Tile_Terrazzo_400");
        }
    }
}
