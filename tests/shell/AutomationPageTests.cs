using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>F74: Check › Automation, the automation balance and the move list (board manage/PaneAutomation, a placeholder).</summary>
    public class AutomationPageTests
    {
        private static (ShellViewModel Vm, MockBalanceTools Tools, InMemoryUserSettings Settings) Pane(bool project = true, bool empty = false)
        {
            var tools = new MockBalanceTools { Empty = empty };
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            if (project) { s.Set("settings.project.folder", @"Z:\Projects\F26001"); s.Set("settings.project.code", "F26001"); }
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), balance: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Automation"));
            vm.Automation.RefreshCommand.Execute(null);
            return (vm, tools, s);
        }

        [Test]
        public async Task The_section_sits_under_Check_after_Scripts()
        {
            var check = Sta.Run(() => string.Join(",", Pane().Vm.Groups.Single(g => g.Name == "Check").Sections.Select(x => x.Name)));
            await Assert.That(check).IsEqualTo("QA,Rules,Reports,Scripts,Automation");
        }

        [Test]
        public async Task It_shows_the_share_bars_by_kind_who_started_the_tools_and_the_trend_by_week()
        {
            var (headline, kinds, starters, weeks, scope) = Sta.Run(() =>
            {
                var (vm, tools, _) = Pane();
                var g = vm.Automation.Groups;
                var balance = g.Single(x => x.Title == "Balance by kind");
                return (balance.Items.OfType<NoteSetting>().First().Text,
                        string.Join("|", balance.Items.OfType<ShareBarsSetting>().Single().Bars.Select(b => b.Label + "=" + b.Value + "/" + b.Tone)),
                        string.Join("|", g.Single(x => x.Title == "Who started the plugin tools").Items.OfType<ShareBarsSetting>().Single().Bars.Select(b => b.Label)),
                        g.Single(x => x.Title.StartsWith("Trend by week")).Items.OfType<ShareBarsSetting>().Single().Bars.Select(b => b.Label + " " + b.Share).ToList(),
                        tools.LastProject);
            });

            await Assert.That(headline).StartsWith("AI code: 55% of 160 calls");
            await Assert.That(kinds).IsEqualTo("AI code=55% · 88/ai|Plugin tools=32.5% · 52/tool|Saved add-ons=2.5% · 4/addon|External automation=10% · 16/external");
            await Assert.That(starters).IsEqualTo("An AI (MCP client)|The pane|A job or flow|A schedule");
            await Assert.That(weeks.Count).IsEqualTo(4);
            await Assert.That(weeks[0]).IsEqualTo("w/c 28 Sep 80");
            await Assert.That(scope).IsEqualTo("F26001");
        }

        [Test]
        public async Task The_move_list_ranks_the_AI_code_and_a_click_shows_its_home_and_status()
        {
            var (rows, first, detail, warn) = Sta.Run(() =>
            {
                var (vm, _, _) = Pane();
                var move = vm.Automation.Groups.Single(x => x.Title.StartsWith("Move list"));
                var table = move.Items.OfType<TableSetting>().Single();
                var count = table.Rows.Count;
                var top = string.Join("|", table.Rows[0].Cells);
                table.Selected = table.Rows[2];
                var sel = vm.Automation.Groups.Single(x => x.Title.StartsWith("Selected · ")).Items.OfType<ReadOnlySetting>()
                    .Select(r => r.Label + ": " + r.Value).ToList();
                var note = vm.Automation.Groups.Single(x => x.Title.StartsWith("Move list")).Items.OfType<NoteSetting>().Single().Text;
                return (count, top, sel, note);
            });

            await Assert.That(rows).IsEqualTo(4);
            await Assert.That(first).IsEqualTo("1|Export sheet PNGs|14|52 s|fmc_view screenshot and fmc_sheets export pdf|planned");
            await Assert.That(detail).Contains("Suggested home: fmc_legend build");
            await Assert.That(detail).Contains("Status: built (tracker F67: Built, Revit check due)");
            await Assert.That(detail).Contains("Calls: 6 (1 failed) · 5.2 min in all");
            await Assert.That(warn).Contains("purpose");
        }

        [Test]
        public async Task Every_project_drops_the_project_filter()
        {
            var (before, after) = Sta.Run(() =>
            {
                var (vm, tools, _) = Pane();
                var b = tools.LastProject;
                vm.Automation.Groups.Single(x => x.Title == "Balance by kind").Items.OfType<ChoiceSetting>().Single(c => c.Label == "Calls of").Selected = "Every project";
                return (b, tools.LastProject);
            });

            await Assert.That(before).IsEqualTo("F26001");
            await Assert.That(after).IsEqualTo("");
        }

        [Test]
        public async Task Export_runs_a_dry_run_then_writes_only_after_a_yes()
        {
            var (afterDry, files, afterYes, line) = Sta.Run(() =>
            {
                var (vm, tools, _) = Pane();
                vm.Automation.ExportCommand.Execute(null);
                var dry = tools.Calls.Where(c => c.Op == "export").ToList();
                var f = vm.Dialog!.Items.OfType<ReadOnlySetting>().Single().Value;
                vm.Dialog.ConfirmCommand!.Execute(null);
                var all = tools.Calls.Where(c => c.Op == "export").Select(c => c.Dry).ToList();
                return (dry.Count, f, all, vm.Automation.Messages.Lines.Single().Text);
            });

            await Assert.That(afterDry).IsEqualTo(1);
            await Assert.That(files).Contains(@"Z:\Projects\F26001\01_WIP\_Exchange\Balance\FMC_Balance_Calls.csv");
            await Assert.That(string.Join(",", afterYes)).IsEqualTo("True,False");
            await Assert.That(line).StartsWith("Saved for Power BI");
        }

        [Test]
        public async Task Export_needs_the_project_folder_and_an_empty_ledger_says_so()
        {
            var (calls, message, empty) = Sta.Run(() =>
            {
                var (vm, tools, _) = Pane(project: false, empty: true);
                vm.Automation.ExportCommand.Execute(null);
                return (tools.Calls.Count(c => c.Op == "export"), vm.Automation.Messages.Lines.Single().Text,
                        vm.Automation.Groups.Single(x => x.Title == "Balance by kind").Items.OfType<NoteSetting>().Single().Text);
            });

            await Assert.That(calls).IsEqualTo(0);
            await Assert.That(message).Contains("Setup › Project");
            await Assert.That(empty).StartsWith("No calls recorded");
        }
    }
}
