using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U19: Drawings › Issue, the readiness check (board manage/PaneIssue).</summary>
    public class IssuePageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockIssueTools Tools { get; } = new MockIssueTools();
            public MockQaTools Qa { get; } = new MockQaTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(string revision = "c02")
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Settings.Set("settings.project.code", "F26001");
                if (revision.Length > 0) Settings.Set("settings.issue.revision", revision);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), qa: Qa, issue: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Issue"));
            }

            public IssuePage Page => Vm.Issue;
            public TableSetting Table(string title) => Page.Groups.Single(g => g.Title.StartsWith(title)).Items.OfType<TableSetting>().Single();
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task The_check_sends_the_codes_apart_and_shows_blocked_sheets()
        {
            var (q, result, statuses) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.issue.set", "CONSTRUCTION");
                p.Page.CheckCommand.Execute(null);
                return (p.Tools.Checks.Single(), p.Page.LastCheck!.Result, p.Table("Sheets in this issue").Rows.Select(r => r.Cells[2]).ToList());
            });
            await Assert.That(q.CompanyRevision).IsEqualTo("C02");
            await Assert.That(q.IssueSet).IsEqualTo("CONSTRUCTION");
            await Assert.That(q.Register).IsEqualTo(@"Z:\Projects\F26001\00_Info\FMC_Sheet_Register.xlsx");
            await Assert.That(result).IsEqualTo("Blocked");
            await Assert.That(statuses).IsEquivalentTo(new[] { "Ready", "Ready", "Exception", "Ready", "Blocked" });
        }

        [Test]
        public async Task Without_a_company_revision_nothing_is_checked()
        {
            var (checks, message) = OnSta(() =>
            {
                var p = new Pane(revision: "");
                p.Page.CheckCommand.Execute(null);
                return (p.Tools.Checks.Count, p.Page.Messages.Lines.Single().Text);
            });
            await Assert.That(checks).IsEqualTo(0);
            await Assert.That(message).Contains("company revision");
        }

        [Test]
        public async Task An_exception_is_recorded_for_a_blocked_item_and_the_check_reruns()
        {
            var (items, recorded, result) = OnSta(() =>
            {
                var p = new Pane();
                p.Page.CheckCommand.Execute(null);
                var i = p.Page.ExceptionItems();
                p.Page.ExceptCommand.Execute(null);
                var texts = p.Vm.Dialog!.Items.OfType<TextSetting>().ToList();
                texts[0].Value = "Status follows with C03";
                texts[1].Value = "NAME F · Lead M";
                texts[2].Value = "C03";
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (i, p.Tools.Recorded.Single(), p.Page.LastCheck!.Result);
            });
            await Assert.That(items).IsEquivalentTo(new[] { "M-1001 · rule SHT-019" });
            await Assert.That(recorded.Sheet).IsEqualTo("M-1001");
            await Assert.That(recorded.Item).IsEqualTo("rule SHT-019");
            await Assert.That(recorded.Until).IsEqualTo("C03");
            await Assert.That(result).IsEqualTo("Ready with exceptions");
        }

        [Test]
        public async Task Issue_runs_a_dry_run_and_writes_only_after_yes()
        {
            var runs = OnSta(() =>
            {
                var p = new Pane();
                p.Page.IssueCommand.Execute(null);
                var before = p.Tools.Issues.ToList();
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (before, p.Tools.Issues.ToList());
            });
            await Assert.That(runs.before).IsEquivalentTo(new[] { true });
            await Assert.That(runs.Item2).IsEquivalentTo(new[] { true, false });
        }
    }
}
