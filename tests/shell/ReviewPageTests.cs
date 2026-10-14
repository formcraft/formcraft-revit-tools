using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U20: Team › Review, the review register (board manage/PaneReview, MAN 10.5).</summary>
    public class ReviewPageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockReviewTools Tools { get; } = new MockReviewTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(bool project = true)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                if (project) Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Settings.Set("disciplines", "A,S");
                Settings.Set("settings.review.filter", "All");
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), review: Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Review"));
                Vm.Review.RefreshCommand.Execute(null);
            }

            public ReviewPage Page => Vm.Review;
            public TableSetting Register => Page.Groups.Single(g => g.Title == "Review register").Items.OfType<TableSetting>().Single();
            public void Select(string id) => Register.Selected = Register.Rows.Single(r => ((ReviewItemInfo)r.Tag!).Id == id);
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task The_register_lists_items_with_overdue_shown()
        {
            var statuses = OnSta(() => new Pane().Register.Rows.Select(r => r.Cells[4]).ToList());
            await Assert.That(statuses).IsEquivalentTo(new[] { "In progress", "Open", "Overdue" });
        }

        [Test]
        public async Task Without_a_project_folder_it_says_where_the_register_lives()
        {
            var note = OnSta(() => new Pane(project: false).Page.Groups.Single().Items.OfType<NoteSetting>().Single().Text);
            await Assert.That(note).Contains("01_WIP");
        }

        [Test]
        public async Task Raising_needs_an_owner_then_files_the_item()
        {
            var (error, count, title) = OnSta(() =>
            {
                var p = new Pane();
                var before = p.Tools.Items.Count;
                p.Page.RaiseCommand.Execute(null);
                var d = p.Vm.Dialog!;
                var texts = d.Items.OfType<TextSetting>().ToList();
                texts[0].Value = "Beam B12 too deep";
                texts[1].Value = "Corridor clear height 2.25 m";
                d.ConfirmCommand!.Execute(null);
                var e = d.Error;
                texts[2].Value = "[NAME F]";
                d.ConfirmCommand!.Execute(null);
                return (e, p.Tools.Items.Count - before, p.Page.Selected?.Title);
            });
            await Assert.That(error).Contains("owner");
            await Assert.That(count).IsEqualTo(1);
            await Assert.That(title).IsEqualTo("Beam B12 too deep");
        }

        [Test]
        public async Task Done_waits_for_every_discipline_then_the_raiser_closes_it()
        {
            var (early, resolved, closed) = OnSta(() =>
            {
                var p = new Pane();
                p.Select("F26001-ISS-0014");
                p.Page.SolveCommand.Execute(null);
                p.Vm.Dialog!.Items.OfType<TextSetting>().Single().Value = "Beam reduced";
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                var e = p.Vm.Dialog?.Error ?? "";
                p.Vm.IsDialogOpen = false;
                p.Page.AnswerCommand.Execute(null);
                var a = p.Vm.Dialog!;
                a.Items.OfType<ChoiceSetting>().Single().Selected = "A";
                a.Items.OfType<TextSetting>().Single().Value = "Ceiling kept at 2.40 m";
                a.ConfirmCommand!.Execute(null);
                p.Page.SolveCommand.Execute(null);
                p.Vm.Dialog!.Items.OfType<TextSetting>().Single().Value = "Beam reduced";
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                var s = p.Page.Selected!.Status;
                p.Page.AcceptCommand.Execute(null);
                return (e, s, p.Tools.Items.Single(i => i.Id == "F26001-ISS-0014").Status);
            });
            await Assert.That(early).Contains("Waiting for A");
            await Assert.That(resolved).IsEqualTo("Resolved");
            await Assert.That(closed).IsEqualTo("Closed");
        }
    }
}
