using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U19: Drawings › Sheets (board manage/PaneSheets).</summary>
    public class SheetsPageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockSheetTools Tools { get; } = new MockSheetTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), sheets: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Sheets"));
            }

            public SheetsPage Page => Vm.Sheets;
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task The_register_defaults_to_the_projects_00_Info()
        {
            var register = OnSta(() => new Pane().Page.Register());
            await Assert.That(register).IsEqualTo(@"Z:\Projects\F26001\00_Info\FMC_Sheet_Register.xlsx");
        }

        [Test]
        public async Task Compare_lists_differences_and_completeness()
        {
            var (diffs, done) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.CompareCommand.Execute(null);
                var d = p.Page.Groups.Single(g => g.Title.StartsWith("Planned vs")).Items.OfType<TableSetting>().Single().Rows.Select(r => r.Cells[1]).ToList();
                var c = p.Page.Groups.Single(g => g.Title == "Completeness").Items.OfType<TableSetting>().Single().Rows.Select(r => r.Cells[1] + " " + r.Cells[2]).ToList();
                return (d, c);
            });
            await Assert.That(diffs).IsEquivalentTo(new[] { "Missing", "Extra", "Name differs: Foundations" });
            await Assert.That(done).IsEquivalentTo(new[] { "Done 100%", "In work 80%", "Due 0%", "In work 60%" });
        }

        [Test]
        public async Task Create_missing_runs_a_dry_run_asks_then_creates_and_model_wins_refuses()
        {
            var (title, runs, refused) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.CompareCommand.Execute(null);
                p.Page.CreateCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                var r = p.Tools.Runs.Select(x => x.Action + ":" + x.Dry).ToList();
                p.Settings.Set("settings.sheets.disagree", "Model wins");
                p.Page.RenameCommand.Execute(null);
                return (t, r, p.Page.Messages.Lines.Single().Text);
            });
            await Assert.That(title).IsEqualTo("Create 1 sheets?");
            await Assert.That(runs).IsEquivalentTo(new[] { "create:True", "create:False" });
            await Assert.That(refused).Contains("Model wins");
        }
    }
}
