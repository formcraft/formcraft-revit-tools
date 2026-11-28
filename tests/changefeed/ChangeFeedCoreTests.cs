using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.ChangeFeed;
using Xunit;

namespace ChangeFeedCore.Tests
{
    public class JournalTests
    {
        private static FeedEntry Change(string doc, int added = 1) =>
            new FeedEntry { Document = doc, Kind = "change", Label = "Walls", User = "u", Added = added, AddedIds = Enumerable.Range(1, added).Select(i => (long)i).ToList() };

        [Fact]
        public void Entries_get_increasing_sequence_numbers()
        {
            var j = new FeedJournal(10);
            var a = j.Add(Change("A"));
            var b = j.Add(Change("B"));
            Assert.Equal(1, a.Seq);
            Assert.Equal(2, b.Seq);
            Assert.Equal(2, j.LastSeq);
        }

        [Fact]
        public void Query_filters_by_document_and_pages_with_after_seq()
        {
            var j = new FeedJournal(100);
            for (int i = 0; i < 5; i++) { j.Add(Change(@"C:\W\A-0002.rvt")); j.Add(Change(@"C:\W\B.rvt")); }
            FeedPage p1 = j.Query("A-0002", 0, 3);
            Assert.Equal(3, p1.Entries.Count);
            Assert.True(p1.More);
            Assert.All(p1.Entries, e => Assert.Contains("A-0002", e.Document));
            FeedPage p2 = j.Query("A-0002", p1.NextAfterSeq, 3);
            Assert.Equal(2, p2.Entries.Count);
            Assert.False(p2.More);
            Assert.True(p2.Entries[0].Seq > p1.Entries[2].Seq);
            Assert.Equal(10, j.Query("", 0, 1000).Entries.Count);
        }

        [Fact]
        public void The_cap_drops_oldest_and_a_reader_behind_it_is_told_about_the_gap()
        {
            var j = new FeedJournal(3);
            for (int i = 0; i < 5; i++) j.Add(Change("A"));
            Assert.Equal(3, j.Count);
            Assert.Equal(2, j.Dropped);
            FeedPage behind = j.Query("A", 0, 10);
            Assert.True(behind.Gap);
            Assert.Equal(3, behind.Entries.Count);
            Assert.Equal(3, behind.Entries[0].Seq);
            FeedPage current = j.Query("A", 3, 10);
            Assert.False(current.Gap);
            Assert.Equal(2, current.Entries.Count);
        }

        [Fact]
        public void Empty_page_keeps_the_callers_position()
        {
            var j = new FeedJournal(5);
            j.Add(Change("A"));
            FeedPage p = j.Query("B", 1, 10);
            Assert.Empty(p.Entries);
            Assert.Equal(1, p.NextAfterSeq);
        }

        [Fact]
        public void Ids_are_capped_but_counts_are_kept_and_truncation_is_said()
        {
            var j = new FeedJournal(5);
            var e = j.Add(Change("A", 80));
            Assert.Equal(FeedJournal.IdCap, e.AddedIds.Count);
            JObject o = e.ToJson();
            Assert.Equal(80, (int)o["added"]);
            Assert.True((bool)o["ids_truncated"]);
            Assert.EndsWith("Z", (string)o["at"]);
        }

        [Fact]
        public void Saves_and_syncs_carry_no_element_counts()
        {
            var o = new FeedEntry { Document = "A", Kind = "synced", Label = "Succeeded" }.ToJson();
            Assert.Null(o["added"]);
            Assert.Equal("synced", (string)o["kind"]);
        }

        [Theory]
        [InlineData("TransactionCommitted", "change")]
        [InlineData("TransactionUndone", "undo")]
        [InlineData("TransactionRedone", "redo")]
        [InlineData("Other", "change")]
        public void Revit_operations_map_to_kinds(string op, string kind) => Assert.Equal(kind, FeedJournal.KindOf(op));

        [Theory]
        [InlineData(@"C:\W\A-0002_USER.rvt", "A-0002_user", true)]
        [InlineData("A-0002", @"D:\x\a-0002.RVT", true)]
        [InlineData("A-0002", "A-0003", false)]
        [InlineData("", "A", false)]
        [InlineData("A", "", true)]
        public void Documents_match_by_path_or_file_name(string key, string wanted, bool same) => Assert.Equal(same, FeedJournal.SameDocument(key, wanted));
    }

    public class ReadOnlyContractTests
    {
        private static string Repo([CallerFilePath] string here = "") => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here), "..", ".."));

        public static IEnumerable<object[]> Sources() => new[]
        {
            new object[] { Path.Combine("commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeed.cs") },
            new object[] { Path.Combine("commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeedRead.cs") },
            new object[] { Path.Combine("commandset", "Services", "Fmc", "ChangeFeed", "ChangeFeedCore.cs") },
            new object[] { Path.Combine("commandset", "Commands", "Fmc", "FmcChangeFeedReadCommand.cs") },
            new object[] { Path.Combine("commandset", "Services", "Fmc", "ChangeFeed", "ChangeFeedLog.cs") },
            new object[] { Path.Combine("commandset", "Services", "Fmc", "ChangeFeed", "ChangeFeedParams.cs") },
            new object[] { Path.Combine("plugin", "Fmc", "ChangeFeedSession.cs") },
            new object[] { Path.Combine("plugin", "Shell", "RevitChangeFeedTools.cs") },
            new object[] { Path.Combine("shell", "Formcraft.Shell", "ViewModels", "ChangesPage.cs") },
        };

        [Theory]
        [MemberData(nameof(Sources))]
        public void Change_feed_sources_never_sync_save_reload_relinquish_or_commit(string relative)
        {
            string file = Path.Combine(Repo(), relative);
            Assert.True(File.Exists(file), file);
            List<string> found = ReadOnlyContract.Violations(File.ReadAllText(file));
            Assert.True(found.Count == 0, relative + ": " + string.Join(", ", found));
        }

        [Fact]
        public void The_handler_never_opens_a_file_and_says_it_saved_and_synced_nothing()
        {
            string h = File.ReadAllText(Path.Combine(Repo(), "commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeedRead.cs"));
            Assert.Contains("mayOpen: false", h);
            Assert.Contains("[\"saved\"] = false", h);
            Assert.Contains("[\"synced\"] = false", h);
            Assert.Contains("[\"transaction\"] = false", h);
        }

        [Theory]
        [InlineData("doc.SynchronizeWithCentral(opts, sync);")]
        [InlineData("doc.Save();")]
        [InlineData("doc.SaveAs(path, o);")]
        [InlineData("doc.ReloadLatest(new ReloadLatestOptions());")]
        [InlineData("WorksharingUtils.RelinquishOwnership(doc, r, t);")]
        [InlineData("using (var t = new Transaction(doc, \"x\")) { t.Start(); t.Commit(); }")]
        [InlineData("var g = new TransactionGroup(doc);")]
        [InlineData("WorksharingUtils.CheckoutElements(doc, ids);")]
        [InlineData("FmcTarget.Resolve(app, p, mayOpen: true)")]
        [InlineData("doc.Close(false);")]
        [InlineData("app.PostCommand(id);")]
        public void The_contract_catches_each_forbidden_call(string line) => Assert.NotEmpty(ReadOnlyContract.Violations(line));

        [Fact]
        public void Line_comments_that_say_what_the_feed_never_does_are_not_calls()
        {
            Assert.Empty(ReadOnlyContract.Violations("// never calls doc.Save() or SynchronizeWithCentral()\nint x = 1;"));
        }
    }
}
