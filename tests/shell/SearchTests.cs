using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U04: search (Ctrl+K) against board core/UI_Palette (design/generators/gen_ui.py, Q).</summary>
    public class SearchTests
    {
        private static readonly (FmcModule, ModuleStatus)[] Everything =
        {
            (FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Active),
            (FmcModule.Model, ModuleStatus.Active), (FmcModule.Build, ModuleStatus.Active),
        };

        private sealed class Pane
        {
            public SectionsTests.TestLicence Licence { get; } = new SectionsTests.TestLicence();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(params (FmcModule, ModuleStatus)[] modules)
            {
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings);
                Licence.Grant(modules.Length == 0 ? Everything : modules);
            }

            /// <summary>"HEADING: title (detail) | ..." in the order shown.</summary>
            public string Find(string query)
            {
                Vm.Search.Query = query;
                return string.Join(" | ", Vm.Search.Results.Select(r => $"{r.Heading}: {r.Title} ({r.Detail})"));
            }
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Sheet_finds_what_the_board_shows()
        {
            var found = OnSta(() => new Pane().Find("sheet"));

            await Assert.That(found).IsEqualTo(
                "SECTIONS: Drawings › Sheets (Manage) | SECTIONS: Ready to issue (Manage) | " +
                "ACTIONS: Sheet Layout: align viewports (Flow · FA) | ACTIONS: Create sheets from the register (Manage · dry run first) | " +
                "SETTINGS: Sheet grid and title block guides (Settings › Flow)");
        }

        [Test]
        public async Task Qa_finds_what_the_board_shows()
        {
            var found = OnSta(() => new Pane().Find("qa"));

            await Assert.That(found).IsEqualTo(
                "SECTIONS: Check › QA (Manage) | " +
                "ACTIONS: Run QA on this model (Manage · ribbon button) | ACTIONS: Brief compliance check (Manage › QA · uses the CIS) | " +
                "HELP: QA rulebook (Rules)");
        }

        [Test]
        public async Task Level_finds_what_the_board_shows()
        {
            var found = OnSta(() => new Pane().Find("level"));

            await Assert.That(found).IsEqualTo(
                "ACTIONS: Start from brief: create levels (Model · new files only) | ACTIONS: Find levels that break the naming rule (Manage › QA) | " +
                "HELP: Level naming (decision D3) (Manual 4.6)");
        }

        [Test]
        public async Task Case_and_extra_spaces_do_not_matter_and_every_word_must_match()
        {
            var (upper, twoWords, oneMissing) = OnSta(() =>
            {
                var p = new Pane();
                return (p.Find("  QA "), p.Find("run qa"), p.Find("run roof"));
            });

            await Assert.That(upper).StartsWith("SECTIONS: Check › QA");
            await Assert.That(twoWords).IsEqualTo("ACTIONS: Run QA on this model (Manage · ribbon button)");
            await Assert.That(oneMissing).IsEqualTo("");
        }

        [Test]
        public async Task Nothing_found_offers_the_samples()
        {
            var (nothing, text, samples, open) = OnSta(() =>
            {
                var p = new Pane();
                p.Find("roof");
                return (p.Vm.Search.NothingFound, p.Vm.Search.NothingFoundText, string.Join(",", p.Vm.Search.Samples), p.Vm.Search.IsOpen);
            });

            await Assert.That(nothing).IsTrue();
            await Assert.That(text).IsEqualTo("Nothing found for “roof”.");
            await Assert.That(samples).IsEqualTo("sheet,qa,level");
            await Assert.That(open).IsTrue();
        }

        [Test]
        public async Task A_sample_runs_its_search()
        {
            var found = OnSta(() =>
            {
                var p = new Pane();
                p.Find("roof");
                p.Vm.Search.TryCommand.Execute("level");
                return p.Vm.Search.Results.Count;
            });

            await Assert.That(found).IsEqualTo(3);
        }

        [Test]
        public async Task Arrows_move_and_wrap_Enter_opens_Esc_closes()
        {
            var (first, second, wrapped, opened, closed, status) = OnSta(() =>
            {
                var p = new Pane();
                p.Find("qa");
                var s = p.Vm.Search;
                var f = s.Selected!.Title;
                s.MoveNext();
                var n = s.Selected!.Title;
                s.MovePrevious();
                s.MovePrevious();
                var w = s.Selected!.Title;
                s.MoveNext();
                s.MoveNext();
                s.OpenSelected(); // Run QA on this model
                var o = p.Vm.Body!.Title;
                var st = p.Vm.Status;
                return (f, n, w, o, !s.IsOpen && s.Query == "", st);
            });

            await Assert.That(first).IsEqualTo("Check › QA");
            await Assert.That(second).IsEqualTo("Run QA on this model");
            await Assert.That(wrapped).IsEqualTo("QA rulebook");
            await Assert.That(opened).IsEqualTo("Check › QA");
            await Assert.That(closed).IsTrue();
            await Assert.That(status).IsEqualTo("Run QA on this model: runs from Check › QA, dry run first. It arrives with that section.");
        }

        [Test]
        public async Task Esc_puts_the_section_back()
        {
            var (before, open, after) = OnSta(() =>
            {
                var p = new Pane();
                var b = p.Vm.Body!.Title;
                p.Find("sheet");
                var o = p.Vm.Search.IsOpen;
                p.Vm.Search.Close();
                return (b, o, p.Vm.Body!.Title + (p.Vm.Search.IsOpen ? " (still open)" : ""));
            });

            await Assert.That(open).IsTrue();
            await Assert.That(after).IsEqualTo(before);
        }

        [Test]
        public async Task Picking_each_kind_does_what_its_button_would()
        {
            var (section, alias, setting, help) = OnSta(() =>
            {
                var p = new Pane();
                string Pick(string query, string title)
                {
                    p.Vm.Search.Query = query;
                    p.Vm.Search.OpenCommand.Execute(p.Vm.Search.Results.Single(r => r.Title == title));
                    return p.Vm.SettingsOpen ? "Settings | " + p.Vm.Status : p.Vm.Body!.Title + " | " + p.Vm.Status;
                }

                var s = Pick("sheet", "Drawings › Sheets");
                var a = Pick("sheet", "Ready to issue");
                var st = Pick("sheet", "Sheet grid and title block guides");
                var h = Pick("level", "Level naming (decision D3)");
                return (s, a, st, h);
            });

            await Assert.That(section).StartsWith("Drawings › Sheets |");
            await Assert.That(alias).StartsWith("Drawings › Issue |");
            await Assert.That(setting).IsEqualTo("Settings | Sheet grid and title block guides: Settings › Flow.");
            await Assert.That(help).EndsWith("| Help: Level naming (decision D3) · Manual 4.6.");
        }

        [Test]
        public async Task Results_you_cannot_run_show_dimmed_with_why()
        {
            var (allowed, detail, status) = OnSta(() =>
            {
                var p = new Pane((FmcModule.Manage, ModuleStatus.Active));
                p.Find("sheet layout");
                var r = p.Vm.Search.Results.Single();
                p.Vm.Search.OpenCommand.Execute(r);
                return (r.Allowed, r.Detail, p.Vm.Status);
            });

            await Assert.That(allowed).IsFalse();
            await Assert.That(detail).IsEqualTo("Flow · FA · not on your licence, ask your admin");
            await Assert.That(status).IsEqualTo("Sheet Layout: align viewports: Flow isn't on your licence. Ask your admin, or start a 14-day trial.");
        }

        [Test]
        public async Task Hidden_parts_are_not_found()
        {
            var (sheet, qa) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.SetPart("flow.sheetlayout", false);
                var s = p.Find("sheet");
                p.Settings.SetPart("manage.check", false);
                return (s, p.Find("qa"));
            });

            await Assert.That(sheet).DoesNotContain("Sheet Layout: align viewports");
            await Assert.That(sheet).Contains("Drawings › Sheets");
            await Assert.That(qa).IsEqualTo("");
        }

        [Test]
        public async Task A_parts_change_updates_open_results_at_once()
        {
            var (before, after) = OnSta(() =>
            {
                var p = new Pane();
                p.Find("qa");
                var b = p.Vm.Search.Results.Count;
                p.Settings.SetPart("manage.check", false);
                return (b, p.Vm.Search.Results.Count);
            });

            await Assert.That(before).IsEqualTo(4);
            await Assert.That(after).IsEqualTo(0);
        }

        [Test]
        public async Task Every_search_entry_opens_something_real()
        {
            var registry = SectionRegistry.LoadEmbedded();
            var sections = registry.Sections.Select(s => s.Name).ToHashSet();
            var bad = (registry.Search ?? new SearchEntryDef[0])
                .Where(e => e.Opens != null && e.Opens != "Settings" && !sections.Contains(e.Opens))
                .Select(e => e.Title).ToList();

            await Assert.That(string.Join("; ", bad)).IsEqualTo("");
            await Assert.That((registry.Search ?? new SearchEntryDef[0]).Length).IsEqualTo(17);
        }
    }
}
