using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>O2: Engineer › Options: the option cards side by side, Make active, Choose this one and Save the comparison.</summary>
    public class OptionsPageTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockOptionsTools Tools { get; } = new MockOptionsTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public List<string> Opened { get; } = new List<string>();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), options: Tools);
                Licence.SetSignedIn();
                Vm.Options.OpenPath = Opened.Add;
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Options"));
                Vm.Options.RefreshCommand.Execute(null);
            }

            public OptionsPage Page => Vm.Options;
            public OptionCard Card(string variant) => Page.Cards.Single(c => c.Variant == variant);
        }

        [Test]
        public async Task The_mock_makes_one_card_per_option_in_the_servers_order()
        {
            var (cards, active, node) = Sta.Run(() =>
            {
                var p = new Pane();
                return (p.Page.Cards.Select(c => c.Variant + " " + c.Name).ToList(), p.Page.Cards.Where(c => c.IsActive).Select(c => c.Variant).ToList(), p.Page.Node!.Shown);
            });
            await Assert.That(node).IsEqualTo("ICU-01 · ICU bed bay (2 variants)");
            await Assert.That(cards).IsEquivalentTo(new[] { "base ICU bed bay", "wide 4.5 m bays", "deep 5.5 m deep" });
            await Assert.That(string.Join(",", cards)).IsEqualTo("base ICU bed bay,wide 4.5 m bays,deep 5.5 m deep");
            await Assert.That(active).IsEquivalentTo(new[] { "base" });
        }

        [Test]
        public async Task Cards_keep_the_servers_order_even_when_another_order_would_rank_them()
        {
            // the largest area first in the server's list: the pane shows it first, never re-sorted by a measure
            var order = Sta.Run(() =>
            {
                var p = new Pane();
                p.Tools.Options.Reverse();
                p.Page.RefreshCommand.Execute(null);
                return string.Join(",", p.Page.Cards.Select(c => c.Variant));
            });
            await Assert.That(order).IsEqualTo("deep,wide,base");
        }

        [Test]
        public async Task Each_card_shows_its_numbers_the_daylight_note_and_what_fails()
        {
            var (rows, deepFails, wideFails, wides) = Sta.Run(() =>
            {
                var p = new Pane();
                var wide = p.Card("wide");
                return (wide.Rows.Select(r => r.Label + ": " + r.Value).ToList(), p.Card("deep").Fails.ToList(), wide.Fails.Count, wide.Families.Count);
            });
            await Assert.That(rows).IsEquivalentTo(new[]
            {
                "Rooms: 1", "Area: 22.5 m² · brief 21 m²", "Walls: 51.3 m²", "Ceilings: 22.5 m²", "Doors: 1", "Windows: 1",
                "Daylight proxy: n/a: a window's height isn't in the recipe: no proxy",
            });
            await Assert.That(deepFails).IsEquivalentTo(new[] { "ICU-01: the pendant's reach (1800) doesn't cover the foot of the bed at 5500 deep" });
            await Assert.That(wideFails).IsEqualTo(0);
            await Assert.That(wides).IsEqualTo(5);
        }

        [Test]
        public async Task The_measures_in_differs_are_highlighted_and_the_rest_are_not()
        {
            var (marked, families, differs) = Sta.Run(() =>
            {
                var p = new Pane();
                var card = p.Card("base");
                return (card.Rows.Where(r => r.Differs).Select(r => r.Label).ToList(), card.Families.Count(f => f.Differs),
                        p.Page.Groups.SelectMany(g => g.Items).OfType<ReadOnlySetting>().Single(r => r.Label == "Differs in").Value);
            });
            await Assert.That(marked).IsEquivalentTo(new[] { "Area", "Walls", "Ceilings" });
            await Assert.That(families).IsEqualTo(0);
            await Assert.That(differs).IsEqualTo("area, walls, ceilings");
        }

        [Test]
        public async Task Make_active_runs_a_dry_run_first_and_shows_what_would_rebuild()
        {
            var (title, would, calls, active) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Card("wide").MakeActiveCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                var w = p.Vm.Dialog.Items.OfType<ReadOnlySetting>().Single().Value;
                var before = string.Join(",", p.Tools.Calls.Where(c => c.Op == "activate").Select(c => c.Variant + (c.Dry ? " dry" : " real")));
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, w, before + "|" + string.Join(",", p.Tools.Calls.Where(c => c.Op == "activate").Select(c => c.Variant + (c.Dry ? " dry" : " real"))),
                        p.Page.Cards.Single(c => c.IsActive).Variant);
            });
            await Assert.That(title).IsEqualTo("Make 4.5 m bays active · dry run");
            await Assert.That(would).Contains("L1/ICU/ICU-01 (fmc_room)");
            await Assert.That(calls).IsEqualTo("wide dry|wide dry,wide real");
            await Assert.That(active).IsEqualTo("wide");
        }

        [Test]
        public async Task Choose_asks_first_and_records_the_signed_in_person()
        {
            var (message, by, buttons) = Sta.Run(() =>
            {
                var p = new Pane();
                var name = p.Licence.Current.Account!.Name;
                p.Card("wide").ChooseCommand.Execute(null);
                var m = p.Vm.Dialog!.Message;
                var none = p.Tools.ChosenBy;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (m.Replace(name, "<me>"), (none ?? "nobody") + " then " + p.Tools.ChosenBy!.Replace(name, "<me>"), p.Page.Cards.Select(c => c.CanChoose).ToList());
            });
            await Assert.That(message).Contains("Recorded as chosen by <me>");
            await Assert.That(message).Contains("accepting the primary there is a person's step");
            await Assert.That(by).IsEqualTo("nobody then <me>");
            // the node as it is has nothing to choose
            await Assert.That(buttons).IsEquivalentTo(new[] { false, true, true });
        }

        [Test]
        public async Task Choose_needs_a_person()
        {
            var (dialog, calls, lines) = Sta.Run(() =>
            {
                var p = new Pane();
                DialogViewModel? asked = null;
                var page = new OptionsPage(p.Tools, p.Vm.Project, p.Settings, () => "", _ => { }, d => asked = d);
                page.RefreshCommand.Execute(null);
                page.Cards.Single(c => c.Variant == "deep").ChooseCommand.Execute(null);
                return (asked, p.Tools.Calls.Count(c => c.Op == "choose"), page.Messages.Lines.Select(l => l.Text).ToList());
            });
            await Assert.That(dialog).IsNull();
            await Assert.That(calls).IsEqualTo(0);
            await Assert.That(lines.Single()).StartsWith("Sign in first");
        }

        [Test]
        public async Task Save_the_comparison_opens_its_folder_and_then_the_plan_sketches()
        {
            var (before, opened) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Card("deep").OpenPlanCommand.Execute(null);
                var b = p.Opened.Count + " " + p.Page.Messages.Lines.Single().Text;
                p.Page.SaveCommand.Execute(null);
                p.Card("deep").OpenPlanCommand.Execute(null);
                return (b, p.Opened.ToList());
            });
            await Assert.That(before).IsEqualTo("0 Save the comparison first: the plan sketches are drawn into its folder.");
            await Assert.That(opened).IsEquivalentTo(new[]
            {
                @"Z:\Projects\F26001\01_WIP\_Options\ICU-01\2026-10-19-10-00-00",
                @"Z:\Projects\F26001\01_WIP\_Options\ICU-01\2026-10-19-10-00-00\Plan_deep.svg",
            });
        }

        [Test]
        public async Task The_cards_template_draws_a_card_per_option()
        {
            var (cards, buttons) = Sta.Run(() =>
            {
                var p = new Pane();
                var setting = p.Page.Groups.SelectMany(g => g.Items).OfType<OptionCardsSetting>().Single();
                var host = new System.Windows.Controls.ContentControl { Content = setting };
                host.Resources.MergedDictionaries.Add(new System.Windows.ResourceDictionary
                {
                    Source = new System.Uri("pack://application:,,,/Formcraft.Shell;component/Views/SettingTemplates.xaml", System.UriKind.Absolute),
                });
                host.Measure(new System.Windows.Size(440, 2000));
                host.Arrange(new System.Windows.Rect(0, 0, 440, 2000));
                host.UpdateLayout();
                var all = Descendants(host).ToList();
                return (all.OfType<System.Windows.Controls.Border>().Count(b => b.Width == 210),
                        all.OfType<System.Windows.Controls.Button>().Count(b => b.Visibility == System.Windows.Visibility.Visible &&(string)b.Content == "Choose this one"));
            });
            await Assert.That(cards).IsEqualTo(3);
            await Assert.That(buttons).IsEqualTo(2);
        }

        private static IEnumerable<System.Windows.DependencyObject> Descendants(System.Windows.DependencyObject d)
        {
            for (int i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(d); i++)
            {
                var c = System.Windows.Media.VisualTreeHelper.GetChild(d, i);
                yield return c;
                foreach (var x in Descendants(c)) yield return x;
            }
        }

        [Test]
        public async Task Without_a_project_folder_it_says_where_the_tree_lives()
        {
            var note = Sta.Run(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.project.folder", "");
                p.Page.Rebuild();
                return p.Page.Groups.Single().Items.OfType<NoteSetting>().Single().Text;
            });
            await Assert.That(note).Contains("01_WIP\\_Tree");
        }
    }
}
