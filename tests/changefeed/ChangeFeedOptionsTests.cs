using System;
using System.Collections.Generic;
using System.IO;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;
using Xunit;

namespace ChangeFeedCore.Tests
{
    public class ChangeFeedOptionsTests
    {
        private static string Tmp() => Path.Combine(Path.GetTempPath(), "fmc-feed-opt-" + Guid.NewGuid().ToString("N"));

        [Fact]
        public void Defaults_are_logging_on_and_twelve_months()
        {
            var o = ChangeFeedOptions.Defaults();
            Assert.True(o.Logging);
            Assert.Equal(12, o.RetentionMonths);
            Assert.Equal("change_feed_logging", ChangeFeedOptions.LoggingKey);
            Assert.Equal("change_feed_retention_months", ChangeFeedOptions.RetentionKey);
        }

        [Fact]
        public void Kit_and_config_files_override_in_order_and_a_broken_file_is_ignored()
        {
            string root = Tmp();
            string kit = Path.Combine(root, "kit");
            string app = Path.Combine(root, "Roaming");
            Directory.CreateDirectory(Path.Combine(kit, "03_Master_Data"));
            Directory.CreateDirectory(Path.Combine(app, "Formcraft"));
            File.WriteAllText(Path.Combine(kit, "FMC_Config.json"), "{\"change_feed_logging\":true,\"change_feed_retention_months\":24}");
            File.WriteAllText(Path.Combine(kit, "03_Master_Data", "FMC_Change_Feed.json"), "{\"logging\":true,\"retention_months\":18}");
            File.WriteAllText(Path.Combine(app, "Formcraft", "config.json"), "{\"change_feed\":{\"logging\":false,\"retention_months\":6}}");
            File.WriteAllText(Path.Combine(root, "broken.json"), "{not json");
            var env = new Dictionary<string, string> { { "APPDATA", app }, { "FMC_CHANGE_FEED_CONFIG", Path.Combine(root, "broken.json") } };
            var o = ChangeFeedOptions.Load(kit, env);
            Assert.False(o.Logging);
            Assert.Equal(6, o.RetentionMonths);
        }

        [Fact]
        public void Environment_variables_win_and_are_for_tests()
        {
            string root = Tmp();
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "feed.json"), "{\"change_feed_logging\":false,\"change_feed_retention_months\":3}");
            var env = new Dictionary<string, string>
            {
                { "APPDATA", Path.Combine(root, "none") },
                { "FMC_CHANGE_FEED_CONFIG", Path.Combine(root, "feed.json") },
                { "FMC_CHANGE_FEED_LOGGING", "on" },
                { "FMC_CHANGE_FEED_RETENTION_MONTHS", "9" },
            };
            var o = ChangeFeedOptions.Load(null, env);
            Assert.True(o.Logging);
            Assert.Equal(9, o.RetentionMonths);
        }

        [Fact]
        public void Protected_models_are_A0001_and_HEBERT_HOSTELS_by_title_or_path_not_ISO_names()
        {
            Assert.True(ChangeFeedOptions.IsProtectedDocument(@"C:\Work\A-0001.rvt", out string r1));
            Assert.Contains("A-0001", r1);
            Assert.True(ChangeFeedOptions.IsProtectedDocument("A-0001_USER", out _));
            Assert.True(ChangeFeedOptions.IsProtectedDocument("HEBERT HOSTELS_USER.rvt", out string r2));
            Assert.Contains("HEBERT HOSTELS", r2);
            Assert.True(ChangeFeedOptions.IsProtectedDocument(@"D:\Projects\HEBERT HOSTELS\Wing.rvt", out _));
            Assert.False(ChangeFeedOptions.IsProtectedDocument("F26901-FMC-ZZ-ZZ-M3-A-0001_USER.rvt", out string r3));
            Assert.Equal("", r3);
            Assert.False(ChangeFeedOptions.IsProtectedDocument(@"C:\Work\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", out _));
            Assert.False(ChangeFeedOptions.IsProtectedDocument(@"D:\Projects\HEBERT\Structure.rvt", out _));
        }

        [Fact]
        public void Prune_keeps_twelve_months_and_never_deletes_outside_the_log_dir()
        {
            string root = Tmp();
            string dir = Path.Combine(root, "model-changes");
            string outside = Path.Combine(root, "other");
            Directory.CreateDirectory(dir);
            Directory.CreateDirectory(outside);
            var now = new DateTime(2026, 11, 28, 8, 0, 0, DateTimeKind.Utc);
            Assert.Equal(new DateTime(2025, 12, 1, 0, 0, 0, DateTimeKind.Utc), ChangeFeedLog.OldestKeptMonth(now, 12));
            File.WriteAllText(Path.Combine(dir, "doc-2025-10.jsonl"), "{}\n");
            File.WriteAllText(Path.Combine(dir, "doc-2025-10-part2.jsonl"), "{}\n");
            File.WriteAllText(Path.Combine(dir, "doc-2025-11.jsonl"), "{}\n");
            File.WriteAllText(Path.Combine(dir, "doc-2025-12.jsonl"), "{}\n");
            File.WriteAllText(Path.Combine(dir, "doc-2026-11.jsonl"), "{}\n");
            File.WriteAllText(Path.Combine(dir, "readme.jsonl"), "not a monthly file\n");
            File.WriteAllText(Path.Combine(dir, "_seq.json"), "{\"seq\":1}");
            string outsider = Path.Combine(outside, "doc-2025-10.jsonl");
            File.WriteAllText(outsider, "keep me\n");

            // Query must not prune
            ChangeFeedLog.Query(dir, "doc", 0, 10);
            ChangeFeedLog.ReadWindow(dir, "doc", null, null, 10);
            Assert.True(File.Exists(Path.Combine(dir, "doc-2025-10.jsonl")));

            int n = ChangeFeedLog.PruneOlder(dir, now, 12);
            Assert.Equal(3, n); // 2025-10, part2, and 2025-11 (12 months kept start at 2025-12)
            Assert.False(File.Exists(Path.Combine(dir, "doc-2025-10.jsonl")));
            Assert.False(File.Exists(Path.Combine(dir, "doc-2025-10-part2.jsonl")));
            Assert.False(File.Exists(Path.Combine(dir, "doc-2025-11.jsonl")));
            Assert.True(File.Exists(Path.Combine(dir, "doc-2025-12.jsonl")));
            Assert.True(File.Exists(Path.Combine(dir, "doc-2026-11.jsonl")));
            Assert.True(File.Exists(Path.Combine(dir, "readme.jsonl")));
            Assert.True(File.Exists(Path.Combine(dir, "_seq.json")));
            Assert.True(File.Exists(outsider));
            Assert.Equal("keep me\n", File.ReadAllText(outsider));
        }

        [Fact]
        public void Prune_refuses_a_foreign_folder_and_zero_retention_keeps_everything()
        {
            string dir = Tmp();
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "doc-2020-01.jsonl"), "{}\n");
            var now = new DateTime(2026, 11, 28, 8, 0, 0, DateTimeKind.Utc);
            Assert.Equal(0, ChangeFeedLog.PruneOlder(dir, now, 0));
            Assert.True(File.Exists(Path.Combine(dir, "doc-2020-01.jsonl")));
            Assert.Equal(0, ChangeFeedLog.PruneOlder(@"D:\Fomcraft\Projects", now, 12));
        }
    }
}
