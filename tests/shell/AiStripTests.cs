using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>The AI activity strip (owner, 15 Oct): what it shows for each AI call, and its settings.</summary>
    public class AiStripTests
    {
        private sealed class Clock
        {
            public DateTime Now = new DateTime(2026, 10, 15, 12, 0, 0, DateTimeKind.Utc);
            public void Pass(TimeSpan t) => Now += t;
        }

        [Test]
        public async Task A_change_call_shows_changing_and_beats_a_read()
        {
            var c = new Clock();
            var t = new AiActivityTracker(() => c.Now);
            var read = t.Begin("read");
            var readOnly = t.Current;
            var change = t.Begin("change");
            var both = t.Current;
            change.End(true);
            var afterChange = t.Current;
            read.End(true);

            await Assert.That(readOnly).IsEqualTo(AiActivityKind.Reading);
            await Assert.That(both).IsEqualTo(AiActivityKind.Changing);
            await Assert.That(afterChange).IsEqualTo(AiActivityKind.Reading);
        }

        [Test]
        public async Task The_last_state_lingers_then_clears()
        {
            var c = new Clock();
            var t = new AiActivityTracker(() => c.Now);
            t.Begin("change").End(true);
            var right = t.Current;
            c.Pass(AiActivityTracker.Linger + TimeSpan.FromMilliseconds(1));

            await Assert.That(right).IsEqualTo(AiActivityKind.Changing);
            await Assert.That(t.Current).IsEqualTo(AiActivityKind.Idle);
        }

        [Test]
        public async Task A_dry_run_waits_for_yes_until_the_next_call_or_ten_minutes()
        {
            var c = new Clock();
            var t = new AiActivityTracker(() => c.Now);
            var dry = t.Begin("dryrun");
            var running = t.Current;
            dry.End(true);
            c.Pass(TimeSpan.FromMinutes(5));
            var waiting = t.Current;
            var next = t.Begin("change");
            var changing = t.Current;
            next.End(true);

            t.Begin("dryrun").End(true);
            c.Pass(AiActivityTracker.WaitFor);
            var expired = t.Current;

            t.Begin("dryrun").End(false);
            var failed = t.Current;

            await Assert.That(running).IsEqualTo(AiActivityKind.Reading);
            await Assert.That(waiting).IsEqualTo(AiActivityKind.Waiting);
            await Assert.That(changing).IsEqualTo(AiActivityKind.Changing);
            await Assert.That(expired).IsEqualTo(AiActivityKind.Idle);
            await Assert.That(failed).IsEqualTo(AiActivityKind.Reading);
        }

        [Test]
        public async Task Reset_and_an_untagged_call()
        {
            var t = new AiActivityTracker();
            t.Begin("change");
            t.Reset();
            var reset = t.Current;
            var untagged = t.Begin(null);

            await Assert.That(reset).IsEqualTo(AiActivityKind.Idle);
            await Assert.That(t.Current).IsEqualTo(AiActivityKind.Reading);
            untagged.End(true);
        }

        [Test]
        public async Task A_persons_click_in_the_pane_never_shows_and_keeps_waiting()
        {
            var t = new AiActivityTracker();
            t.Begin("dryrun").End(true);
            var click = t.Begin("person");
            var during = t.Current;
            click.End(true);

            await Assert.That(during).IsEqualTo(AiActivityKind.Waiting);
            await Assert.That(t.Current).IsEqualTo(AiActivityKind.Waiting);
        }

        [Test]
        public async Task Ending_twice_counts_once()
        {
            var t = new AiActivityTracker();
            var a = t.Begin("change");
            var b = t.Begin("change");
            a.End(true);
            a.End(true);
            a.Dispose();

            await Assert.That(t.Current).IsEqualTo(AiActivityKind.Changing);
            b.End(true);
        }

        [Test]
        [Arguments(AiActivityKind.Changing, "Fmc.Orange")]
        [Arguments(AiActivityKind.Waiting, "Fmc.Warning")]
        [Arguments(AiActivityKind.Reading, "Fmc.Model")]
        public async Task Defaults_are_orange_amber_blue(AiActivityKind kind, string token)
        {
            var none = new Dictionary<string, string>();
            await Assert.That(AiStripSettings.TokenFor(kind, k => none.TryGetValue(k, out var v) ? v : null)).IsEqualTo(token);
            await Assert.That(AiStripSettings.TokenFor(AiActivityKind.Idle, _ => null)).IsNull();
        }

        [Test]
        public async Task The_switches_and_colours_come_from_settings()
        {
            var s = new Dictionary<string, string>
            {
                [AiStripSettings.OnKey("reading")] = "false",
                [AiStripSettings.ColourKey("changing")] = "Red",
                [AiStripSettings.ColourKey("waiting")] = "Not a colour",
            };
            string? Get(string k) => s.TryGetValue(k, out var v) ? v : null;
            var changing = AiStripSettings.TokenFor(AiActivityKind.Changing, Get);
            var reading = AiStripSettings.TokenFor(AiActivityKind.Reading, Get);
            var waiting = AiStripSettings.TokenFor(AiActivityKind.Waiting, Get);
            s[AiStripSettings.Key] = "false";
            var off = AiStripSettings.TokenFor(AiActivityKind.Changing, Get);

            await Assert.That(changing).IsEqualTo("Fmc.Critical");
            await Assert.That(reading).IsNull();
            await Assert.That(waiting).IsEqualTo("Fmc.Warning");
            await Assert.That(off).IsNull();
        }

        [Test]
        public async Task Settings_General_has_the_strip_and_writes_the_keys_the_add_in_reads()
        {
            var (labels, saved) = Sta.Run(() =>
            {
                var settings = new InMemoryUserSettings();
                var vm = new ShellViewModel(new SectionsTests.TestLicence(), new MockConnectionService(), new MockDocumentContext(), settings, theme: new ThemeService());
                var group = vm.Settings.Tabs.Single(t => t.Name == "General").Groups.Single(g => g.Title == "General · AI activity strip");
                var l = string.Join(" | ", group.Items.Select(i => i.Label));
                group.Items.OfType<ToggleSetting>().First().IsOn = false;
                group.Items.OfType<ChoiceSetting>().First().Selected = "Teal";
                return (l, settings.Get("settings." + AiStripSettings.Key) + "," + settings.Get("settings." + AiStripSettings.ColourKey("changing")));
            });

            await Assert.That(labels).IsEqualTo("Colour the ribbon while AI works | AI is changing the model | Colour · changing | AI is waiting for your yes | Colour · waiting | AI is reading or checking | Colour · reading | ");
            await Assert.That(saved).IsEqualTo("false,Teal");
        }
    }
}
