using System;
using System.IO;
using System.Linq;
using TouchKit.Core.Settings;
using Xunit;

namespace TouchKit.Core.Tests
{
    public class SettingsTests
    {
        [Fact]
        public void Schema_finds_every_setting_with_a_group_and_label()
        {
            var all = SettingsSchema.Describe(typeof(TouchSettings));
            Assert.True(all.Count >= 20);
            Assert.All(all, s => Assert.False(string.IsNullOrWhiteSpace(s.Meta.Group)));
            Assert.All(all, s => Assert.False(string.IsNullOrWhiteSpace(s.Meta.Label)));
        }

        [Fact]
        public void Basic_settings_are_listed_before_advanced_ones()
        {
            var all = SettingsSchema.Describe(typeof(TouchSettings));
            int firstAdvanced = all.ToList().FindIndex(s => s.Meta.Advanced);
            Assert.True(firstAdvanced > 0);
            Assert.All(all.Skip(firstAdvanced), s => Assert.True(s.Meta.Advanced));
        }

        [Fact]
        public void Numbers_are_clamped_to_their_range()
        {
            var settings = new TouchSettings();
            var badge = SettingsSchema.Describe(typeof(TouchSettings)).Single(s => s.Property.Name == nameof(TouchSettings.BadgeSize));
            badge.SetClamped(settings, 500);
            Assert.Equal(96, settings.BadgeSize);
        }

        [Fact]
        public void Settings_round_trip_through_json_and_missing_file_gives_defaults()
        {
            string dir = Path.Combine(Path.GetTempPath(), "touchkit-tests-" + Guid.NewGuid().ToString("N"));
            string file = Path.Combine(dir, "settings.json");
            var store = new JsonFileStore<TouchSettings>(file);

            Assert.Equal(new TouchSettings().LongPressMs, store.Load().LongPressMs);

            var changed = new TouchSettings { LongPressMs = 900, DoubleTap = DoubleTapAction.None, BadgeCorner = BadgeCorner.BottomLeft };
            Assert.True(store.Save(changed));

            TouchSettings loaded = store.Load();
            Assert.Equal(900, loaded.LongPressMs);
            Assert.Equal(DoubleTapAction.None, loaded.DoubleTap);
            Assert.Equal(BadgeCorner.BottomLeft, loaded.BadgeCorner);

            Directory.Delete(dir, recursive: true);
        }

        [Fact]
        public void Broken_file_falls_back_to_defaults()
        {
            string file = Path.Combine(Path.GetTempPath(), "touchkit-broken-" + Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(file, "{ this is not json");
            var store = new JsonFileStore<TouchSettings>(file);

            Assert.Equal(new TouchSettings().BadgeSize, store.Load().BadgeSize);
            Assert.NotNull(store.LastError);
        }

        [Fact]
        public void View_states_are_kept_per_project()
        {
            var states = new ViewTouchStates();
            states.Set("A", 100, true);
            states.Set("B", 100, false);
            Assert.True(states.Get("A", 100));
            Assert.False(states.Get("B", 100));
            Assert.Null(states.Get("A", 999));
        }
    }
}
