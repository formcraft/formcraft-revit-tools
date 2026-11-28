using System;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Tests
{
    /// <summary>F09: Revit busy reaches the pane from the add-in (it was set only by the preview and tests).</summary>
    public class BusyStateTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 11, 28, 9, 0, 0, DateTimeKind.Utc);

        [Test]
        public async Task Off_is_not_connected_whatever_the_busy_flag_says()
        {
            var s = new BusyState();
            await Assert.That(s.Next(false, true, T0)).IsEqualTo(ConnectionState.NotConnected);
            await Assert.That(s.Next(false, false, T0)).IsEqualTo(ConnectionState.NotConnected);
        }

        [Test]
        public async Task Busy_shows_only_after_it_has_lasted_a_second_and_clears_at_once()
        {
            var s = new BusyState();
            var quick = s.Next(true, true, T0);
            var half = s.Next(true, true, T0.AddMilliseconds(500));
            var settled = s.Next(true, true, T0.AddMilliseconds(1000));
            var done = s.Next(true, false, T0.AddMilliseconds(1100));
            var again = s.Next(true, true, T0.AddMilliseconds(1200));

            await Assert.That(quick).IsEqualTo(ConnectionState.Connected);
            await Assert.That(half).IsEqualTo(ConnectionState.Connected);
            await Assert.That(settled).IsEqualTo(ConnectionState.RevitBusy);
            await Assert.That(done).IsEqualTo(ConnectionState.Connected);
            await Assert.That(again).IsEqualTo(ConnectionState.Connected);
        }

        [Test]
        public async Task Switching_off_while_busy_resets_the_wait()
        {
            var s = new BusyState();
            s.Next(true, true, T0);
            s.Next(false, true, T0.AddSeconds(2));
            var back = s.Next(true, true, T0.AddSeconds(2.5));

            await Assert.That(back).IsEqualTo(ConnectionState.Connected);
        }
    }
}
