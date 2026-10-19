using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>R2: Team › Review's tickets: the list, the thread with transcripts, typed and voice replies, offline Whisper.</summary>
    public class ReviewTicketsTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockReviewTools Tools { get; } = new MockReviewTools();
            public MockVoiceRecorder Recorder { get; } = new MockVoiceRecorder();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Settings.Set("settings.review.filter", "All");
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(), review: Tools, recorder: Recorder);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Review"));
                Vm.Review.RefreshCommand.Execute(null);
            }

            public ReviewPage Page => Vm.Review;
            public TableSetting Tickets => Page.Groups.Single(g => g.Title == "Tickets").Items.OfType<TableSetting>().Single();
            public void Select(string id) => Tickets.Selected = Tickets.Rows.Single(r => ((ReviewItemInfo)r.Tag!).Id == id);
            public SettingsGroup Ticket => Page.Groups.Single(g => g.Title.StartsWith("Ticket: "));
            public TableSetting Thread => Ticket.Items.OfType<TableSetting>().Single(t => t.Label == "Thread");
            public string[] Buttons => Ticket.Items.OfType<ButtonsSetting>().Single().Buttons.Select(b => b.Label).ToArray();
        }

        [Test]
        public async Task Tickets_list_who_fixes_them_where_they_came_from_their_media_and_latest_note()
        {
            var (rows, register) = Sta.Run(() =>
            {
                var p = new Pane();
                var reg = p.Page.Groups.Single(g => g.Title == "Review register").Items.OfType<TableSetting>().Single().Rows.Count;
                return (p.Tickets.Rows.Select(r => string.Join(" | ", r.Cells.Skip(1))).ToList(), reg);
            });
            await Assert.That(rows).IsEquivalentTo(new[]
            {
                "AI modeller | mark | voice · picture | Raise the ceiling to 2700 over the bed. It is too low for t… | Open",
                "M lead | clash | — | Clash 12 of Test 3: supply duct through beam B12 | In progress",
            });
            await Assert.That(register).IsEqualTo(3);
        }

        [Test]
        public async Task The_thread_shows_each_note_with_its_transcript_and_how_it_was_made()
        {
            var (thread, buttons) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Select("F26001-ISS-0016");
                return (p.Thread.Rows.Select(r => r.Cells[2] + " | " + r.Cells[3]).ToList(), p.Buttons);
            });
            await Assert.That(thread).IsEquivalentTo(new[] { "Raise the ceiling to 2700 over the bed. It is too low for the pendant. | voice · whisper small (offline)" });
            await Assert.That(buttons).Contains("Record a voice reply");
            await Assert.That(buttons).DoesNotContain("Take it");
        }

        [Test]
        public async Task A_typed_reply_joins_the_thread()
        {
            var (empty, thread) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Select("F26001-ISS-0015");
                p.Page.ReplyCommand.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                var e = p.Vm.Dialog.Error;
                p.Vm.Dialog.Items.OfType<TextSetting>().Single().Value = "Duct dropped 150 under the beam";
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (e, p.Thread.Rows.Select(r => r.Cells[2] + " | " + r.Cells[3]).ToList());
            });
            await Assert.That(empty).Contains("Write the reply");
            await Assert.That(thread).IsEquivalentTo(new[] { "Clash 12 of Test 3: supply duct through beam B12 | typed", "Duct dropped 150 under the beam | typed" });
        }

        [Test]
        public async Task Record_then_stop_sends_a_16kHz_mono_wav_and_transcribes_it_offline()
        {
            // the header every recording is written with (the recorder and its stand-in share Wav.WriteTemp)
            var header = File.ReadAllBytes(Wav.WriteTemp(new byte[3200])).Take(44).ToArray();
            var (during, call, last, tempGone) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Select("F26001-ISS-0015");
                p.Page.RecordCommand.Execute(null);
                var d = p.Buttons;
                p.Page.StopCommand.Execute(null);
                var t = p.Tools.Transcribed.Single();
                var row = p.Thread.Rows.Last();
                return (d, t, row.Cells[2] + " | " + row.Cells[3], !File.Exists(p.Recorder.Written.Single()));
            });
            await Assert.That(during).IsEquivalentTo(new[] { "Stop and send", "Discard" });
            await Assert.That(BitConverter.ToInt32(header, 24)).IsEqualTo(16000);
            await Assert.That(BitConverter.ToInt16(header, 22)).IsEqualTo((short)1);
            await Assert.That(BitConverter.ToInt16(header, 34)).IsEqualTo((short)16);
            await Assert.That(call).IsEqualTo(("F26001-ISS-0015", 2, "small", "auto"));
            await Assert.That(last).IsEqualTo("Use the 1026 single door here, same as the other one. | voice · whisper small (offline)");
            await Assert.That(tempGone).IsTrue();
        }

        [Test]
        public async Task Without_a_microphone_it_says_so_and_records_nothing()
        {
            var (status, recording) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Recorder.NoMicrophone = "No microphone found: plug one in, or check Windows' sound settings.";
                p.Select("F26001-ISS-0016");
                p.Page.RecordCommand.Execute(null);
                return (p.Vm.Status, p.Page.IsRecording);
            });
            await Assert.That(status).Contains("No microphone");
            await Assert.That(recording).IsFalse();
        }

        [Test]
        public async Task A_missing_model_keeps_the_voice_note_and_says_why_until_whisper_is_set_up_after_a_dry_run()
        {
            var (warn, how, details, done) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.review.whisper_model", "medium");
                p.Select("F26001-ISS-0015");
                p.Page.RecordCommand.Execute(null);
                p.Page.StopCommand.Execute(null);
                var w = p.Vm.Status;
                var h = p.Thread.Rows.Last().Cells[3];
                p.Page.WhisperCommand.Execute(null);
                var d = p.Vm.Dialog!.Items.OfType<ReadOnlySetting>().Single().Value;
                var before = p.Tools.WhisperMedium;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                p.Page.TranscribeCommand.Execute(null);
                return (w, h, (d, before), p.Thread.Rows.Last().Cells[3]);
            });
            await Assert.That(warn).Contains("not transcribed");
            await Assert.That(how).IsEqualTo("voice");
            await Assert.That(details.d).Contains("medium model");
            await Assert.That(details.before).IsFalse();
            await Assert.That(done).IsEqualTo("voice · whisper medium (offline)");
        }

        [Test]
        public async Task Anyone_can_take_an_open_ticket_that_is_not_for_the_AI()
        {
            var (owner, status) = Sta.Run(() =>
            {
                var p = new Pane();
                var t = p.Tools.Items.Single(i => i.Id == "F26001-ISS-0015");
                t.To = "anyone"; t.Status = "Open";
                p.Page.RefreshCommand.Execute(null);
                p.Select("F26001-ISS-0015");
                p.Page.TakeCommand.Execute(null);
                return (t.Owner, t.Status);
            });
            await Assert.That(owner).IsNotEqualTo("M lead");
            await Assert.That(status).IsEqualTo("In progress");
        }
    }
}
