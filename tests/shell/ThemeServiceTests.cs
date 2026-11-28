using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Formcraft.Shell.Controls;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Tests
{
    /// <summary>The pane follows Revit's Light/Dark setting unless the person overrides it.</summary>
    public class ThemeServiceTests
    {
        [Test]
        public async Task Follow_Revit_tracks_every_change_from_Revit()
        {
            var themes = new ThemeService(PaneTheme.Light);
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            themes.SetHostTheme(PaneTheme.Dark);
            var afterDark = themes.Effective;
            themes.SetHostTheme(PaneTheme.Light);

            await Assert.That(afterDark).IsEqualTo(PaneTheme.Dark);
            await Assert.That(themes.Effective).IsEqualTo(PaneTheme.Light);
            await Assert.That(changes).IsEqualTo(2);
        }

        [Test]
        [Arguments(ThemeChoice.Light, PaneTheme.Light)]
        [Arguments(ThemeChoice.Dark, PaneTheme.Dark)]
        public async Task A_chosen_theme_ignores_Revit(ThemeChoice choice, PaneTheme expected)
        {
            var themes = new ThemeService(PaneTheme.Light, choice);
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            themes.SetHostTheme(PaneTheme.Dark);
            themes.SetHostTheme(PaneTheme.Light);

            await Assert.That(themes.Effective).IsEqualTo(expected);
            await Assert.That(changes).IsEqualTo(0);
        }

        [Test]
        public async Task Going_back_to_Follow_Revit_picks_up_Revit_s_theme()
        {
            var themes = new ThemeService(PaneTheme.Dark, ThemeChoice.Light);
            var before = themes.Effective;

            themes.Choice = ThemeChoice.FollowRevit;

            await Assert.That(before).IsEqualTo(PaneTheme.Light);
            await Assert.That(themes.Effective).IsEqualTo(PaneTheme.Dark);
        }

        [Test]
        public async Task Same_theme_again_raises_no_change()
        {
            var themes = new ThemeService(PaneTheme.Dark);
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            themes.SetHostTheme(PaneTheme.Dark);
            themes.Choice = ThemeChoice.Dark;

            await Assert.That(changes).IsEqualTo(0);
        }

        [Test]
        public async Task Open_controls_repaint_when_Revit_switches_theme()
        {
            var (before, after, expectedLight, expectedDark) = Sta.Run(() =>
            {
                var themes = new ThemeService(PaneTheme.Light);
                var root = new StackPanel();
                themes.Attach(root);

                var primary = new Button { Content = "Run" };
                var banner = new FmcDocBanner { Header = "Model", Content = "Live project: AI reads and reports", State = DocState.Live };
                var input = new TextBox();
                root.Children.Add(primary);
                root.Children.Add(banner);
                root.Children.Add(input);
                primary.Style = (Style)root.FindResource("FmcButton.Primary");
                input.Style = (Style)root.FindResource("FmcTextBox");

                string Read() => $"{Colour(primary.Background)} {Colour(banner.Background)} {Colour(input.Background)} {Colour(input.Foreground)}";
                string Expect(ResourceDictionary c) =>
                    $"{Colour(c["Fmc.PrimaryBrush"])} {Colour(c["Fmc.Chip.BadBg"])} {Colour(c["Fmc.FieldBrush"])} {Colour(c["Fmc.InkBrush"])}";

                var b = Read();
                themes.SetHostTheme(PaneTheme.Dark);
                return (b, Read(), Expect(ThemeService.LoadColours(PaneTheme.Light)), Expect(ThemeService.LoadColours(PaneTheme.Dark)));
            });

            await Assert.That(before).IsEqualTo(expectedLight);
            await Assert.That(after).IsEqualTo(expectedDark);
        }

        [Test]
        public async Task Attach_adds_the_kit_when_a_view_has_none()
        {
            var (themeName, hasStyle) = Sta.Run(() =>
            {
                var root = new Border();
                new ThemeService(PaneTheme.Dark).Attach(root);
                return ((string)root.FindResource("Fmc.ThemeName"), root.FindResource("FmcButton.Primary") is Style);
            });

            await Assert.That(themeName).IsEqualTo("Dark");
            await Assert.That(hasStyle).IsTrue();
        }

        [Test]
        public async Task Attach_replaces_the_colours_a_view_merged_in_XAML()
        {
            var (count, themeName) = Sta.Run(() =>
            {
                var root = new Border();
                root.Resources.MergedDictionaries.Add(ThemeService.LoadColours(PaneTheme.Light));
                root.Resources.MergedDictionaries.Add(ThemeService.LoadStyles());

                new ThemeService(PaneTheme.Dark).Attach(root);
                return (root.Resources.MergedDictionaries.Count, (string)root.FindResource("Fmc.ThemeName"));
            });

            await Assert.That(count).IsEqualTo(2);
            await Assert.That(themeName).IsEqualTo("Dark");
        }

        [Test]
        public async Task A_view_whose_thread_has_ended_never_blocks_a_theme_switch()
        {
            // F02: the old code used a blocking Dispatcher.Invoke for a view on another thread; with that thread
            // gone the call never returned, and in Revit it would hang ThemeChanged.
            var themes = new ThemeService(PaneTheme.Light);
            Sta.Run(() => { themes.Attach(new Border()); return 0; });
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            var switched = Task.Run(() => themes.SetHostTheme(PaneTheme.Dark)).Wait(System.TimeSpan.FromSeconds(5));

            await Assert.That(switched).IsTrue();
            await Assert.That(changes).IsEqualTo(1);
        }

        [Test]
        public async Task A_view_whose_dispatcher_shut_down_is_skipped_and_dropped()
        {
            var themes = new ThemeService(PaneTheme.Light);
            var attached = Sta.Run(() =>
            {
                themes.Attach(new Border());
                var n = themes.AttachedCount;
                System.Windows.Threading.Dispatcher.CurrentDispatcher.InvokeShutdown();
                return n;
            });
            System.Exception? failure = null;
            try { themes.SetHostTheme(PaneTheme.Dark); }
            catch (System.Exception ex) { failure = ex; }

            await Assert.That(attached).IsEqualTo(1);
            await Assert.That(failure).IsNull();
            await Assert.That(themes.AttachedCount).IsEqualTo(0);
        }

        [Test]
        public async Task Detach_stops_a_view_being_repainted()
        {
            var (before, after, name) = Sta.Run(() =>
            {
                var themes = new ThemeService(PaneTheme.Light);
                var root = new Border();
                themes.Attach(root);
                var b = themes.AttachedCount;
                themes.Detach(root);
                themes.Detach(root);
                themes.SetHostTheme(PaneTheme.Dark);
                return (b, themes.AttachedCount, (string)root.FindResource("Fmc.ThemeName"));
            });

            await Assert.That(before).IsEqualTo(1);
            await Assert.That(after).IsEqualTo(0);
            await Assert.That(name).IsEqualTo("Light");
        }

        private static string Colour(object brush) => ((SolidColorBrush)brush).Color.ToString();
    }
}
