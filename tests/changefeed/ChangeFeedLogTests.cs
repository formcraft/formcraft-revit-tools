using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;
using Xunit;

namespace ChangeFeedCore.Tests
{
    public class ChangeFeedLogTests
    {
        private static string Tmp() => Path.Combine(Path.GetTempPath(), "fmc-changes-" + Guid.NewGuid().ToString("N"));

        [Fact]
        public void The_default_folder_is_under_the_hub_ledger_not_inside_a_model()
        {
            string dir = ChangeFeedLog.DefaultDir(new Dictionary<string, string> { { "APPDATA", @"C:\Users\x\AppData\Roaming" } });
            Assert.EndsWith(@"Formcraft\ledger\model-changes", dir.Replace('/', '\\'));
            Assert.Equal("", ChangeFeedLog.RefuseDir(dir));
            Assert.Contains("Fomcraft", ChangeFeedLog.RefuseDir(@"D:\Fomcraft\Projects\A"));
            Assert.Contains("model file", ChangeFeedLog.RefuseDir(@"C:\Work\A-0002.rvt"));
        }

        [Fact]
        public void Append_and_query_round_trip_a_line_with_before_and_after_and_a_zone_label()
        {
            string dir = Tmp();
            Directory.CreateDirectory(dir);
            var eat = TimeZoneInfo.FindSystemTimeZoneById("E. Africa Standard Time");
            var e = new FeedEntry
            {
                AtUtc = new DateTime(2026, 11, 28, 8, 10, 0, DateTimeKind.Utc),
                Document = @"C:\Work\A-0002_USER.rvt", Kind = "change", Label = "Walls", User = "emlyn", By = "person",
                Added = 0, Modified = 1, Deleted = 0, ModifiedIds = new List<long> { 5 },
            };
            e.Elements.Add(new ElementChange
            {
                Id = 5, Action = "modified", Category = "Walls", Name = "Basic Wall",
                Params = new List<ParamChange> { new ParamChange { Name = "Mark", Before = "A1", After = "A2" } },
            });
            string path = ChangeFeedLog.Append(dir, e, eat);
            Assert.False(string.IsNullOrEmpty(path));
            Assert.DoesNotContain(".rvt", Path.GetFileName(path));
            Assert.StartsWith(dir, path);
            var page = ChangeFeedLog.Query(dir, "A-0002_USER", 0, 10);
            Assert.Single(page.Entries);
            Assert.Equal("A1", page.Entries[0].Elements[0].Params[0].Before);
            Assert.Equal("A2", page.Entries[0].Elements[0].Params[0].After);
            string text = File.ReadAllText(path);
            Assert.Contains("EAT (UTC+3)", text);
            Assert.Contains("\"tz\":\"EAT\"", text);
        }

        [Fact]
        public void Size_rotation_opens_a_new_part_and_seq_keeps_climbing()
        {
            string dir = Tmp();
            Directory.CreateDirectory(dir);
            var at = new DateTime(2026, 11, 28, 8, 0, 0, DateTimeKind.Utc);
            string first = ChangeFeedLog.PathToAppend(dir, "A", at, rotateBytes: 80);
            File.WriteAllText(first, new string('x', 100));
            string second = ChangeFeedLog.PathToAppend(dir, "A", at, rotateBytes: 80);
            Assert.Contains("-part2", Path.GetFileName(second));
            string dir2 = Tmp();
            var a = new FeedEntry { AtUtc = at, Document = "A", Kind = "opened" };
            var b = new FeedEntry { AtUtc = at.AddMinutes(1), Document = "A", Kind = "change", Label = "x" };
            ChangeFeedLog.Append(dir2, a);
            ChangeFeedLog.Append(dir2, b);
            Assert.True(b.Seq > a.Seq);
            Assert.Equal(2, ChangeFeedLog.Query(dir2, "A", 0, 10).Entries.Count);
        }

        [Fact]
        public void Times_are_labeled_with_their_zone()
        {
            var eat = TimeZoneInfo.FindSystemTimeZoneById("E. Africa Standard Time");
            string s = ChangeFeedLog.LabelTime(new DateTime(2026, 11, 28, 8, 10, 0, DateTimeKind.Utc), eat);
            Assert.Equal("2026-11-28 11:10:00 EAT (UTC+3)", s);
            Assert.Equal("EAT", ChangeFeedLog.ZoneAbbr(eat, new DateTime(2026, 11, 28, 11, 10, 0)));
        }
    }

    public class ChangeFeedParamsTests
    {
        [Fact]
        public void Diff_reports_old_and_new_and_ignores_unchanged()
        {
            var before = new List<ParamValue> { new ParamValue { Name = "Mark", Value = "A1" }, new ParamValue { Name = "Comments", Value = "" } };
            var after = new List<ParamValue> { new ParamValue { Name = "Mark", Value = "A2" }, new ParamValue { Name = "Comments", Value = "" }, new ParamValue { Name = "Keynote", Value = "K" } };
            var d = ChangeFeedParams.Diff(before, after);
            Assert.Equal(2, d.Count);
            Assert.Contains(d, p => p.Name == "Mark" && p.Before == "A1" && p.After == "A2");
            Assert.Contains(d, p => p.Name == "Keynote" && p.Before == null && p.After == "K");
        }

        [Fact]
        public void Caps_give_a_reason_when_they_drop_parameters_or_elements()
        {
            var many = Enumerable.Range(1, 50).Select(i => new ParamChange { Name = "P" + i, Before = "a", After = "bbbbbbbbbb" }).ToList();
            var capped = ChangeFeedParams.Cap(many, 3, 8000, out bool t, out string reason);
            Assert.True(t);
            Assert.Equal(3, capped.Count);
            Assert.Contains("More than 3", reason);
            var tiny = ChangeFeedParams.Cap(many, 50, 80, out bool t2, out string reason2);
            Assert.True(t2);
            Assert.True(tiny.Count < many.Count);
            Assert.Contains("bytes", reason2);
            var els = Enumerable.Range(1, 10).Select(i => new ElementChange { Id = i, Action = "modified", Name = "N" + i, Params = many }).ToList();
            var eCap = ChangeFeedParams.CapElements(els, 2, 100000, out bool te, out string re);
            Assert.True(te);
            Assert.Equal(2, eCap.Count);
            Assert.Contains("More than 2", re);
        }

        [Fact]
        public void Key_names_include_the_fixed_list_and_FMC_parameters()
        {
            Assert.True(ChangeFeedParams.IsKeyName("Mark"));
            Assert.True(ChangeFeedParams.IsKeyName("FMC_Role"));
            Assert.False(ChangeFeedParams.IsKeyName("some random param"));
        }
    }
}
