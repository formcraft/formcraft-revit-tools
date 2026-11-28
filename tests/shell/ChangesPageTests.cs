using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>F133: Check › Changes, the lasting change log and before/after (board manage/PaneChanges).</summary>
    public class ChangesPageTests
    {
        private static (ShellViewModel Vm, MockChangeFeedTools Tools) Pane()
        {
            var tools = new MockChangeFeedTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            s.Set("changes.period", "All recorded");
            s.Set("changes.scope", ChangesPage.EveryDocument);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), changeFeed: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Changes"));
            vm.Changes.RefreshCommand.Execute(null);
            return (vm, tools);
        }

        [Test]
        public async Task The_section_sits_under_Check_after_Automation()
        {
            var check = Sta.Run(() => string.Join(",", Pane().Vm.Groups.Single(g => g.Name == "Check").Sections.Select(x => x.Name)));
            await Assert.That(check).IsEqualTo("QA,Rules,Reports,Scripts,Automation,Changes");
        }

        [Test]
        public async Task The_timeline_shows_times_with_their_time_zone_and_a_before_after_diff()
        {
            var (when, who, param, about) = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                var table = vm.Changes.Groups.Single(g => g.Title == "Timeline").Items.OfType<TableSetting>().Single();
                var first = table.Rows[0];
                // pick the Walls row (seq 1) which has Mark A1 → A2
                table.Selected = table.Rows.Last();
                var detail = vm.Changes.Groups.Single(g => g.Title.StartsWith("Before and after"));
                var paramsTable = detail.Items.OfType<TableSetting>().Single();
                var mark = paramsTable.Rows.Single(r => r.Cells[0] == "Mark");
                var aboutText = vm.Changes.Groups.Single(g => g.Title == "About this log").Items.OfType<NoteSetting>().First().Text;
                return (first.Cells[0], first.Cells[2], mark.Cells[1] + " → " + mark.Cells[2], aboutText);
            });
            await Assert.That(when).Contains("EAT").And.Contains("UTC+3");
            await Assert.That(param).IsEqualTo("A1 → A2");
            await Assert.That(about).Contains("never syncs");
        }

        [Test]
        public async Task Filters_by_category_and_user()
        {
            var (cats, users, wallsOnly) = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                var filters = vm.Changes.Groups.Single(g => g.Title == "Filters").Items.OfType<ChoiceSetting>().ToList();
                var category = filters.Single(c => c.Label == "Category");
                var who = filters.Single(c => c.Label == "Who");
                category.Selected = "Walls";
                vm.Changes.RefreshCommand.Execute(null);
                var table = vm.Changes.Groups.Single(g => g.Title == "Timeline").Items.OfType<TableSetting>().Single();
                return (string.Join(",", category.Options), string.Join(",", who.Options), string.Join("|", table.Rows.Select(r => r.Cells[3])));
            });
            await Assert.That(cats).Contains("Walls").And.Contains("Door Tags");
            await Assert.That(users).Contains("emlyn");
            await Assert.That(wallsOnly).IsEqualTo("Walls");
        }

        [Test]

        [Test]
        public async Task The_page_never_counts_or_ranks_people()
        {
            var (names, text, counts) = Sta.Run(() =>
            {
                var (vm, _) = Pane();
                var page = vm.Changes;
                var prop = string.Join(",", page.GetType().GetProperties().Select(p => p.Name));
                var bits = new System.Text.StringBuilder();
                foreach (var g in page.Groups)
                {
                    bits.Append(g.Title).Append('\n');
                    foreach (var item in g.Items)
                    {
                        bits.Append(item.GetType().Name).Append(' ');
                        if (item is NoteSetting n) bits.Append(n.Text);
                        if (item is ReadOnlySetting r) bits.Append(r.Label).Append(' ').Append(r.Value);
                        if (item is ChoiceSetting c) bits.Append(c.Label);
                        if (item is TableSetting tbl) bits.Append(string.Join(",", tbl.Columns ?? System.Array.Empty<string>()));
                        bits.Append('\n');
                    }
                }
                return (prop, bits.ToString(), page.Groups.Single(g => g.Title == "Timeline").Items.OfType<NoteSetting>().First().Text);
            });
            await Assert.That(names).DoesNotContain("ByUser").And.DoesNotContain("UserCount").And.DoesNotContain("Leaderboard").And.DoesNotContain("Ranking").And.DoesNotContain("Score").And.DoesNotContain("PerUser");
            await Assert.That(text.ToLowerInvariant()).DoesNotContain("leaderboard").And.DoesNotContain("per-user").And.DoesNotContain("per user").And.DoesNotContain("by_user").And.DoesNotContain("sort by volume");
            // A team total ("N changes") is allowed; a per-person count is not.
            await Assert.That(counts).Contains("change");
        }

        public async Task Today_is_the_local_calendar_day_converted_to_UTC()
        {
            var utc = new DateTime(2026, 11, 28, 8, 0, 0, DateTimeKind.Utc);
            var (since, until) = ChangesPage.Window("Today", utc);
            await Assert.That(since).IsNotNull();
            await Assert.That(until).IsEqualTo(utc);
            // The start is local midnight, which is at or before the UTC instant.
            await Assert.That(since!.Value).IsLessThanOrEqualTo(utc);
            await Assert.That((utc - since.Value) < TimeSpan.FromHours(36)).IsTrue();
        }
    }
}
