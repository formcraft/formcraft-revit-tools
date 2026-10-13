using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using Formcraft.Shell.Services;

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

        [Test]
        public async Task Light_and_dark_have_the_same_keys_and_types()
        {
            var (lightKeys, darkKeys, typeMismatches, names) = Sta.Run(() =>
            {
                var light = ThemeService.LoadColours(PaneTheme.Light);
                var dark = ThemeService.LoadColours(PaneTheme.Dark);
                var l = light.Keys.Cast<object>().Select(k => k.ToString()!).OrderBy(k => k).ToList();
                var d = dark.Keys.Cast<object>().Select(k => k.ToString()!).OrderBy(k => k).ToList();
                var mismatches = l.Intersect(d).Where(k => light[k].GetType() != dark[k].GetType()).ToList();
                return (l, d, mismatches, ((string)light["Fmc.ThemeName"], (string)dark["Fmc.ThemeName"]));
            });

            await Assert.That(string.Join(",", darkKeys)).IsEqualTo(string.Join(",", lightKeys));
            await Assert.That(string.Join("; ", typeMismatches)).IsEqualTo("");
            await Assert.That(names.Item1).IsEqualTo("Light");
            await Assert.That(names.Item2).IsEqualTo("Dark");
        }

        [Test]
        public async Task Every_brush_has_a_colour_token()
        {
            var problems = Sta.Run(() =>
            {
                var light = ThemeService.LoadColours(PaneTheme.Light);
                var found = new List<string>();
                foreach (var key in light.Keys.Cast<object>().Select(k => k.ToString()!))
                {
                    if (!key.EndsWith("Brush")) continue;
                    var token = key.Substring(0, key.Length - "Brush".Length);
                    if (!light.Contains(token)) found.Add($"{key} has no colour {token}");
                    else if ((Color)light[token] != ((SolidColorBrush)light[key]).Color) found.Add($"{key} differs from {token}");
                }
                return found;
            });

            await Assert.That(string.Join("; ", problems)).IsEqualTo("");
        }

        [Test]
        public async Task Every_kit_style_exists()
        {
            var missing = Sta.Run(() =>
            {
                var styles = ThemeService.LoadStyles();
                return KitStyles.Where(k => !(styles.Contains(k) && styles[k] is Style)).ToList();
            });

            await Assert.That(string.Join("; ", missing)).IsEqualTo("");
        }

        [Test]
        [Arguments(PaneTheme.Light)]
        [Arguments(PaneTheme.Dark)]
        public async Task Text_is_readable_in_both_themes(PaneTheme theme)
        {
            var failures = Sta.Run(() =>
            {
                var colours = ThemeService.LoadColours(theme);
                var pairs = TextPairs.ToList();
                foreach (var chip in new[] { "Good", "Warn", "Bad", "Info", "Grey" })
                    pairs.Add(($"Fmc.Chip.{chip}Fg", $"Fmc.Chip.{chip}Bg"));

                var found = new List<string>();
                foreach (var (text, background) in pairs)
                {
                    var ratio = Contrast.Ratio(ColourOf(colours, text), ColourOf(colours, background));
                    if (ratio < 4.5) found.Add($"{text} on {background}: {ratio:0.00}");
                }
                return found;
            });

            await Assert.That(string.Join("; ", failures)).IsEqualTo("");
        }

        [Test]
        [Arguments(PaneTheme.Light)]
        [Arguments(PaneTheme.Dark)]
        public async Task Focus_ring_shows_against_the_pane(PaneTheme theme)
        {
            var failures = Sta.Run(() =>
            {
                var colours = ThemeService.LoadColours(theme);
                return new[] { "Fmc.Surface", "Fmc.Header", "Fmc.Field" }
                    .Select(b => (b, ratio: Contrast.Ratio(ColourOf(colours, "Fmc.Accent"), ColourOf(colours, b))))
                    .Where(x => x.ratio < 3.0)
                    .Select(x => $"Fmc.Accent on {x.b}: {x.ratio:0.00}")
                    .ToList();
            });

            await Assert.That(string.Join("; ", failures)).IsEqualTo("");
        }

        [Test]
        [Arguments("Fmc.Font", "IBM Plex Sans", 400)]
        [Arguments("Fmc.Font", "IBM Plex Sans", 500)]
        [Arguments("Fmc.Font", "IBM Plex Sans", 600)]
        [Arguments("Fmc.Font", "IBM Plex Sans", 700)]
        [Arguments("Fmc.Mono", "IBM Plex Mono", 400)]
        public async Task Plex_is_embedded_and_loads(string key, string family, int weight)
        {
            var (loaded, uri, familyName, actualWeight) = Sta.Run(() =>
            {
                var styles = ThemeService.LoadStyles();
                var font = (FontFamily)styles[key];
                var typeface = new Typeface(font, FontStyles.Normal, FontWeight.FromOpenTypeWeight(weight), FontStretches.Normal);
                if (!typeface.TryGetGlyphTypeface(out var glyphs)) return (false, "", "", 0);
                return (true, glyphs.FontUri.ToString(), glyphs.Win32FamilyNames.Values.First(), glyphs.Weight.ToOpenTypeWeight());
            });

            await Assert.That(loaded).IsTrue();
            await Assert.That(uri).Contains("Formcraft.Shell");
            await Assert.That(familyName).Contains(family);
            await Assert.That(actualWeight).IsEqualTo(weight);
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
