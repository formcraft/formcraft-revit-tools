using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U19: Drawings › Annotate (board manage/PaneAnnotate).</summary>
    public class AnnotatePageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockAnnotateTools Tools { get; } = new MockAnnotateTools();
            public MockQaTools Qa { get; } = new MockQaTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), qa: Qa, annotate: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Annotate"));
                Vm.Annotate.Load().GetAwaiter().GetResult();
            }

            public AnnotatePage Page => Vm.Annotate;
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task The_standard_shows_pens_and_switches_tabs()
        {
            var (pens, text) = OnSta(() =>
            {
                var p = new Pane();
                TableSetting Table() => p.Page.Groups[0].Items.OfType<TableSetting>().Single();
                var a = Table().Rows.Count;
                p.Settings.Set("settings.annotate.tab", "Text");
                p.Page.Rebuild();
                return (a, Table().Rows.Select(r => r.Cells[0]).First());
            });
            await Assert.That(pens).IsEqualTo(8);
            await Assert.That(text).IsEqualTo("FMC_Arial_1.8");
        }

        [Test]
        public async Task The_check_lists_findings_and_zoom_selects_them()
        {
            var (rows, selected) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.CheckCommand.Execute(null);
                var table = p.Page.Groups.Single(g => g.Title == "Check against the standard").Items.OfType<TableSetting>().Single();
                var r = table.Rows.Select(x => x.Cells[2]).ToList();
                table.Selected = table.Rows[1];
                p.Page.ZoomCommand.Execute(null);
                return (r, p.Qa.Selected.ToList());
            });
            await Assert.That(rows).IsEquivalentTo(new[] { "Fail", "Fail", "Proposed", "Fail" });
            await Assert.That(selected).IsEquivalentTo(new long[] { 10, 11 });
        }

        [Test]
        public async Task Missing_tags_report_by_category_for_the_chosen_scope()
        {
            var (rows, scope) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.annotate.scope", "Views on the current sheet");
                p.Page.MissingCommand.Execute(null);
                var table = p.Page.Groups.Single(g => g.Title == "Missing tags · report").Items.OfType<TableSetting>().Single();
                return (table.Rows.Select(x => x.Cells[0] + " " + x.Cells[1]).ToList(), p.Tools.Scopes.Single());
            });
            await Assert.That(rows).IsEquivalentTo(new[] { "Doors 6", "Windows 2", "Rooms 0", "Electrical fixtures 14" });
            await Assert.That(scope).IsEqualTo("sheet_views");
        }
    }
}
