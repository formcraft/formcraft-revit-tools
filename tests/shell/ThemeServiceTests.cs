using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Formcraft.Shell.Controls;
using Formcraft.Shell.Services;
using Xunit;

namespace Formcraft.Shell.Tests
{
    /// <summary>The pane follows Revit's Light/Dark setting unless the person overrides it.</summary>
    public class ThemeServiceTests
    {
        [Fact]
        public void Follow_Revit_tracks_every_change_from_Revit()
        {
            var themes = new ThemeService(PaneTheme.Light);
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            themes.SetHostTheme(PaneTheme.Dark);
            Assert.Equal(PaneTheme.Dark, themes.Effective);
            themes.SetHostTheme(PaneTheme.Light);
            Assert.Equal(PaneTheme.Light, themes.Effective);
            Assert.Equal(2, changes);
        }

        [Theory]
        [InlineData(ThemeChoice.Light, PaneTheme.Light)]
        [InlineData(ThemeChoice.Dark, PaneTheme.Dark)]
        public void A_chosen_theme_ignores_Revit(ThemeChoice choice, PaneTheme expected)
        {
            var themes = new ThemeService(PaneTheme.Light, choice);
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            themes.SetHostTheme(PaneTheme.Dark);
            themes.SetHostTheme(PaneTheme.Light);

            Assert.Equal(expected, themes.Effective);
            Assert.Equal(0, changes);
        }

        [Fact]
        public void Going_back_to_Follow_Revit_picks_up_Revit_s_theme()
        {
            var themes = new ThemeService(PaneTheme.Dark, ThemeChoice.Light);
            Assert.Equal(PaneTheme.Light, themes.Effective);

            themes.Choice = ThemeChoice.FollowRevit;
            Assert.Equal(PaneTheme.Dark, themes.Effective);
        }

        [Fact]
        public void Same_theme_again_raises_no_change()
        {
            var themes = new ThemeService(PaneTheme.Dark);
            var changes = 0;
            themes.Changed += (_, _) => changes++;

            themes.SetHostTheme(PaneTheme.Dark);
            themes.Choice = ThemeChoice.Dark;
            Assert.Equal(0, changes);
        }

        [Fact]
        public void Open_controls_repaint_when_Revit_switches_theme()
        {
            Sta.Run(() =>
            {
                var themes = new ThemeService(PaneTheme.Light);
                var root = new StackPanel();
                themes.Attach(root);

                var primary = new Button { Content = "Run" };
                var banner = new FmcDocBanner { Header = "Model", Content = "Live project: Claude reads and reports", State = DocState.Live };
                var input = new TextBox();
                root.Children.Add(primary);
                root.Children.Add(banner);
                root.Children.Add(input);
                primary.Style = (Style)root.FindResource("FmcButton.Primary");
                input.Style = (Style)root.FindResource("FmcTextBox");

                var light = ThemeService.LoadColours(PaneTheme.Light);
                var dark = ThemeService.LoadColours(PaneTheme.Dark);
                AssertBrush(light, "Fmc.PrimaryBrush", primary.Background);
                AssertBrush(light, "Fmc.Chip.BadBg", banner.Background);
                AssertBrush(light, "Fmc.FieldBrush", input.Background);

                themes.SetHostTheme(PaneTheme.Dark);

                AssertBrush(dark, "Fmc.PrimaryBrush", primary.Background);
                AssertBrush(dark, "Fmc.Chip.BadBg", banner.Background);
                AssertBrush(dark, "Fmc.FieldBrush", input.Background);
                AssertBrush(dark, "Fmc.InkBrush", input.Foreground);
            });
        }

        [Fact]
        public void Attach_adds_the_kit_when_a_view_has_none()
        {
            Sta.Run(() =>
            {
                var root = new Border();
                new ThemeService(PaneTheme.Dark).Attach(root);

                Assert.Equal("Dark", root.FindResource("Fmc.ThemeName"));
                Assert.IsType<Style>(root.FindResource("FmcButton.Primary"));
            });
        }

        [Fact]
        public void Attach_replaces_the_colours_a_view_merged_in_XAML()
        {
            Sta.Run(() =>
            {
                var root = new Border();
                root.Resources.MergedDictionaries.Add(ThemeService.LoadColours(PaneTheme.Light));
                root.Resources.MergedDictionaries.Add(ThemeService.LoadStyles());

                new ThemeService(PaneTheme.Dark).Attach(root);

                Assert.Equal(2, root.Resources.MergedDictionaries.Count);
                Assert.Equal("Dark", root.FindResource("Fmc.ThemeName"));
            });
        }

        private static void AssertBrush(ResourceDictionary colours, string key, Brush actual) =>
            Assert.Equal(((SolidColorBrush)colours[key]).Color, ((SolidColorBrush)actual).Color);
    }
}
