using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U16: Check › QA and Check › Rules (boards manage/PaneQA, manage/PaneRules).</summary>
    public class QaPagesTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockQaTools Qa { get; } = new MockQaTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), qa: Qa);
                Licence.SetSignedIn();
            }

            public void Open(string section) => Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == section));
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Qa_runs_a_gate_and_lists_failures_first_with_the_blocking_summary()
        {
            var (counts, summary, rows, footer) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("QA");
                p.Vm.Qa.RunCommand.Execute(null);
                var checks = p.Vm.Qa.Groups.Single(g => g.Title.StartsWith("Checks ·"));
                var table = p.Vm.Qa.Groups.Single(g => g.Title == "Results").Items.OfType<TableSetting>().Single();
                return (checks.Items.OfType<ReadOnlySetting>().Single().Value, checks.Items.OfType<NoteSetting>().Single().Text,
                        table.Rows.Select(r => r.Cells[0]).ToList(), string.Join(",", p.Vm.FooterActions.Select(a => a.Label)));
            });
            await Assert.That(counts).IsEqualTo("41 checks ran · 36 pass · 2 fail · 0 warnings · 3 not applicable · 0 not checked");
            await Assert.That(summary).Contains("2 Must rules block the move");
            await Assert.That(rows).IsEquivalentTo(new[] { "NAM-012", "QA-011" });
            await Assert.That(footer).IsEqualTo("Run QA,Zoom");
        }

        [Test]
        public async Task Zoom_selects_the_failing_elements_of_the_clicked_result()
        {
            var selected = OnSta(() =>
            {
                var p = new Pane();
                p.Open("QA");
                p.Vm.Qa.RunCommand.Execute(null);
                p.Vm.Qa.Select("NAM-012");
                p.Vm.Qa.ZoomCommand.Execute(null);
                return p.Qa.Selected.ToList();
            });
            await Assert.That(selected).IsEquivalentTo(new long[] { 101, 102, 103 });
        }

        [Test]
        public async Task Not_checked_rules_say_why_and_the_trend_and_report_show()
        {
            var (why, trend, report) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("QA");
                p.Settings.Set("settings.qa.show", "Not checked");
                p.Vm.Qa.RunCommand.Execute(null);
                var row = p.Vm.Qa.Groups.Single(g => g.Title == "Results").Items.OfType<TableSetting>().Single().Rows.Single();
                return (row.Cells[3], p.Vm.Qa.Groups.Single(g => g.Title == "Trend").Items.OfType<ReadOnlySetting>().Single().Value,
                        p.Vm.Qa.Groups.Single(g => g.Title == "Report").Items.OfType<ReadOnlySetting>().Single().Value);
            });
            await Assert.That(why).Contains("doesn't run check kind");
            await Assert.That(trend).IsEqualTo("2 new · 15 recurring · 6 resolved");
            await Assert.That(report).EndsWith(".md");
        }

        [Test]
        public async Task Rules_filter_by_book_severity_source_and_search()
        {
            var (all, must, proposed, search) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Rules");
                p.Vm.Rules.Load().GetAwaiter().GetResult();
                var a = p.Vm.Rules.Filtered().Count();
                p.Settings.Set("settings.rules.severity", "Must");
                var m = p.Vm.Rules.Filtered().Select(r => r.Id).ToList();
                p.Settings.Set("settings.rules.severity", "All");
                p.Settings.Set("settings.rules.source", "Proposed");
                var pr = p.Vm.Rules.Filtered().Select(r => r.Id).ToList();
                p.Settings.Set("settings.rules.source", "All");
                p.Settings.Set("settings.rules.query", "sheet");
                return (a, m, pr, p.Vm.Rules.Filtered().Select(r => r.Id).ToList());
            });
            await Assert.That(all).IsEqualTo(5);
            await Assert.That(must).IsEquivalentTo(new[] { "ANN-003", "ANN-034", "NAM-012" });
            await Assert.That(proposed).IsEquivalentTo(new[] { "ANN-030" });
            await Assert.That(search).IsEquivalentTo(new[] { "SHT-022" });
        }

        [Test]
        public async Task A_rule_shows_its_details_and_a_change_request_needs_a_reason()
        {
            var (why, error, request) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Rules");
                p.Vm.Rules.Load().GetAwaiter().GetResult();
                p.Vm.Rules.Select("ANN-034");
                var w = p.Vm.Rules.Groups.Single(g => g.Title == "Selected rule · ANN-034").Items.OfType<ReadOnlySetting>().Single(r => r.Label == "Why it exists").Value;
                p.Vm.Rules.ChangeCommand.Execute(null);
                var d = p.Vm.Dialog!;
                d.ConfirmCommand!.Execute(null);
                var e = d.Error;
                d.Items.OfType<TextSetting>().Single(t => t.Label == "Why").Value = "Leads are on site this month";
                d.ConfirmCommand!.Execute(null);
                return (w, e, p.Qa.Requests.Single());
            });
            await Assert.That(why).IsEqualTo("Tags on live models change sheets other people are printing.");
            await Assert.That(error).Contains("Say why");
            await Assert.That(request).StartsWith("change ANN-034");
        }

        [Test]
        public async Task Only_an_admin_approves_a_proposed_rule()
        {
            var (approvable, requests) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Rules");
                p.Vm.Rules.Load().GetAwaiter().GetResult();
                p.Vm.Rules.Select("ANN-030");
                var buttons = p.Vm.Rules.Groups.Single(g => g.Title == "Selected rule · ANN-030").Items.OfType<ButtonsSetting>().Single().Buttons.Select(b => b.Label).ToList();
                p.Vm.Rules.ApproveCommand.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (buttons, p.Qa.Requests.ToList());
            });
            await Assert.That(approvable).Contains("Approve (BIM Manager)");
            await Assert.That(requests.Single()).StartsWith("approve ANN-030 Should");
        }
    }
}
