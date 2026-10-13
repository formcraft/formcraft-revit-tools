using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Formcraft.Shell.Services;
using Xunit;

namespace Formcraft.Shell.Tests
{
    /// <summary>The UI kit in code: both colour sets, every style on the board, contrast and fonts.</summary>
    public class ThemeTests
    {
        // Every style the UI kit board and UI step U01 name.
        public static readonly string[] KitStyles =
        {
            "FmcButton.Primary", "FmcButton.Secondary", "FmcButton.Ai", "FmcButton.Icon",
            "FmcToggle", "FmcSegmented",
            "FmcChip.Good", "FmcChip.Warn", "FmcChip.Bad", "FmcChip.Info", "FmcChip.Grey",
            "FmcCheckRow", "FmcTextBox", "FmcReadOnly", "FmcPasswordBox", "FmcTable", "FmcDocBanner", "FmcDialog",
            "FmcNav.Group", "FmcNav.Section", "FmcText.GroupTitle", "FmcText.Body", "FmcText.Hint", "FmcGroup",
            "Fmc.FocusVisual",
        };

        // Text on background: WCAG AA, 4.5:1.
        public static readonly (string Text, string Background)[] TextPairs =
        {
            ("Fmc.Ink", "Fmc.Surface"), ("Fmc.Ink", "Fmc.Field"), ("Fmc.Ink", "Fmc.Header"), ("Fmc.Ink", "Fmc.Footer"),
            ("Fmc.Ink", "Fmc.Hover"), ("Fmc.Ink", "Fmc.Selected"), ("Fmc.Ink", "Fmc.Track"),
            ("Fmc.Muted", "Fmc.Surface"), ("Fmc.Muted", "Fmc.Header"), ("Fmc.Muted", "Fmc.Footer"), ("Fmc.Muted", "Fmc.Field"),
            ("Fmc.Tab", "Fmc.Surface"), ("Fmc.SectionInk", "Fmc.Surface"),
            ("Fmc.OnPrimary", "Fmc.Primary"), ("Fmc.Navy", "Fmc.Orange"), ("Fmc.Critical", "Fmc.Surface"),
        };

        [Fact]
        public void Light_and_dark_have_the_same_keys_and_types()
        {
            Sta.Run(() =>
            {
                var light = ThemeService.LoadColours(PaneTheme.Light);
                var dark = ThemeService.LoadColours(PaneTheme.Dark);
                var lightKeys = light.Keys.Cast<object>().Select(k => k.ToString()!).OrderBy(k => k).ToList();
                var darkKeys = dark.Keys.Cast<object>().Select(k => k.ToString()!).OrderBy(k => k).ToList();

                Assert.Equal(lightKeys, darkKeys);
                foreach (var key in lightKeys)
                    Assert.Equal(light[key].GetType(), dark[key].GetType());
                Assert.Equal("Light", light["Fmc.ThemeName"]);
                Assert.Equal("Dark", dark["Fmc.ThemeName"]);
            });
        }

        [Fact]
        public void Every_brush_has_a_colour_token()
        {
            Sta.Run(() =>
            {
                var light = ThemeService.LoadColours(PaneTheme.Light);
                foreach (var key in light.Keys.Cast<object>().Select(k => k.ToString()!))
                {
                    if (!key.EndsWith("Brush")) continue;
                    var token = key.Substring(0, key.Length - "Brush".Length);
                    Assert.True(light.Contains(token), $"{key} has no colour {token}");
                    Assert.Equal((Color)light[token], ((SolidColorBrush)light[key]).Color);
                }
            });
        }

        [Fact]
        public void Every_kit_style_exists()
        {
            Sta.Run(() =>
            {
                var styles = ThemeService.LoadStyles();
                var missing = KitStyles.Where(k => !(styles.Contains(k) && styles[k] is Style)).ToList();
                Assert.Empty(missing);
            });
        }

        [Theory]
        [InlineData(PaneTheme.Light)]
        [InlineData(PaneTheme.Dark)]
        public void Text_is_readable_in_both_themes(PaneTheme theme)
        {
            Sta.Run(() =>
            {
                var colours = ThemeService.LoadColours(theme);
                var pairs = TextPairs.ToList();
                foreach (var chip in new[] { "Good", "Warn", "Bad", "Info", "Grey" })
                    pairs.Add(($"Fmc.Chip.{chip}Fg", $"Fmc.Chip.{chip}Bg"));

                var failures = new List<string>();
                foreach (var (text, background) in pairs)
                {
                    var ratio = Contrast.Ratio(ColourOf(colours, text), ColourOf(colours, background));
                    if (ratio < 4.5) failures.Add($"{text} on {background}: {ratio:0.00}");
                }
                Assert.Empty(failures);
            });
        }

        [Theory]
        [InlineData(PaneTheme.Light)]
        [InlineData(PaneTheme.Dark)]
        public void Focus_ring_shows_against_the_pane(PaneTheme theme)
        {
            Sta.Run(() =>
            {
                var colours = ThemeService.LoadColours(theme);
                foreach (var background in new[] { "Fmc.Surface", "Fmc.Header", "Fmc.Field" })
                    Assert.True(Contrast.Ratio(ColourOf(colours, "Fmc.Accent"), ColourOf(colours, background)) >= 3.0, background);
            });
        }

        [Theory]
        [InlineData("Fmc.Font", "IBM Plex Sans", 400)]
        [InlineData("Fmc.Font", "IBM Plex Sans", 500)]
        [InlineData("Fmc.Font", "IBM Plex Sans", 600)]
        [InlineData("Fmc.Font", "IBM Plex Sans", 700)]
        [InlineData("Fmc.Mono", "IBM Plex Mono", 400)]
        public void Plex_is_embedded_and_loads(string key, string family, int weight)
        {
            Sta.Run(() =>
            {
                var styles = ThemeService.LoadStyles();
                var font = (FontFamily)styles[key];
                var typeface = new Typeface(font, FontStyles.Normal, FontWeight.FromOpenTypeWeight(weight), FontStretches.Normal);

                Assert.True(typeface.TryGetGlyphTypeface(out var glyphs), $"{family} {weight} did not load");
                Assert.Contains("Formcraft.Shell", glyphs.FontUri.ToString());
                Assert.Contains(family, glyphs.Win32FamilyNames.Values.Concat(glyphs.FamilyNames.Values).First());
                Assert.Equal(weight, glyphs.Weight.ToOpenTypeWeight());
            });
        }

        internal static Color ColourOf(ResourceDictionary colours, string key) =>
            colours[key] is SolidColorBrush brush ? brush.Color : (Color)colours[key];
    }

    /// <summary>WCAG 2 contrast ratio.</summary>
    internal static class Contrast
    {
        public static double Ratio(Color a, Color b)
        {
            var la = Luminance(a);
            var lb = Luminance(b);
            return (Math.Max(la, lb) + 0.05) / (Math.Min(la, lb) + 0.05);
        }

        private static double Luminance(Color c) =>
            0.2126 * Channel(c.R) + 0.7152 * Channel(c.G) + 0.0722 * Channel(c.B);

        private static double Channel(byte v)
        {
            var s = v / 255.0;
            return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }
    }
}
