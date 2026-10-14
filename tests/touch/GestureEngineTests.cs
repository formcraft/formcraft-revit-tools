using System.Collections.Generic;
using System.Linq;
using TouchKit.Core.Gestures;
using Xunit;

namespace TouchKit.Core.Tests
{
    public class GestureEngineTests
    {
        private readonly GestureEngine _engine = new();
        private readonly List<GestureEvent> _events = new();
        private double _t;

        // ---- tiny script helpers ----------------------------------------------------------------
        private void Down(uint id, double x, double y) => Send(id, PointerPhase.Down, x, y);
        private void Move(uint id, double x, double y) => Send(id, PointerPhase.Move, x, y);
        private void Up(uint id, double x, double y) => Send(id, PointerPhase.Up, x, y);
        private void Wait(double ms) { _t += ms; _events.AddRange(_engine.Tick(_t)); }
        private void Send(uint id, PointerPhase phase, double x, double y) =>
            _events.AddRange(_engine.Process(new PointerSample(id, phase, new Pt(x, y), _t)));
        private T[] Of<T>() => _events.OfType<T>().ToArray();

        // ---- taps -------------------------------------------------------------------------------
        [Fact]
        public void Quick_touch_without_movement_is_a_tap()
        {
            Down(1, 100, 100); Wait(80); Up(1, 101, 100);
            Assert.Single(Of<Tap>());
            Assert.Empty(Of<DragStarted>());
            Assert.False(_engine.IsActive);
        }

        [Fact]
        public void Small_jitter_is_still_a_tap()
        {
            Down(1, 100, 100); Move(1, 105, 104); Wait(60); Up(1, 104, 103);
            Assert.Single(Of<Tap>());
        }

        [Fact]
        public void Two_quick_taps_in_same_place_give_tap_then_double_tap()
        {
            Down(1, 100, 100); Wait(60); Up(1, 100, 100);
            Wait(150);
            Down(2, 110, 105); Wait(60); Up(2, 110, 105);
            Assert.Single(Of<Tap>());
            Assert.Single(Of<DoubleTap>());
        }

        [Fact]
        public void Taps_too_far_apart_in_time_are_two_single_taps()
        {
            Down(1, 100, 100); Wait(60); Up(1, 100, 100);
            Wait(600);
            Down(2, 100, 100); Wait(60); Up(2, 100, 100);
            Assert.Equal(2, Of<Tap>().Length);
            Assert.Empty(Of<DoubleTap>());
        }

        // ---- long press -------------------------------------------------------------------------
        [Fact]
        public void Holding_still_fires_long_press_once_and_no_tap()
        {
            Down(1, 200, 200);
            for (int i = 0; i < 10; i++) Wait(100);
            Up(1, 201, 200);
            Assert.Single(Of<LongPress>());
            Assert.Empty(Of<Tap>());
        }

        [Fact]
        public void Resting_finger_reports_where_and_since_when_until_it_moves()
        {
            Down(1, 200, 200); Wait(100);
            Assert.Equal((new Pt(200, 200), 0.0), _engine.Holding);
            Move(1, 260, 200);
            Assert.Null(_engine.Holding);
        }

        // ---- two-finger tap (Flow: right-click menu) ---------------------------------------------
        [Fact]
        public void Two_fingers_down_and_up_without_moving_is_a_two_finger_tap()
        {
            Down(1, 100, 100); Down(2, 160, 100); Wait(90); Up(1, 101, 100); Up(2, 160, 101);
            var tap = Assert.Single(Of<TwoFingerTap>());
            Assert.Equal(new Pt(130, 100), tap.Centroid);
            Assert.Empty(Of<Tap>());
            Assert.False(_engine.IsActive);
        }

        [Fact]
        public void A_pinch_is_never_a_two_finger_tap()
        {
            Down(1, 100, 100); Down(2, 160, 100); Move(2, 220, 100); Wait(90); Up(1, 100, 100); Up(2, 220, 100);
            Assert.Empty(Of<TwoFingerTap>());
            Assert.NotEmpty(Of<TwoFingerZoomed>());
        }

        [Fact]
        public void Two_fingers_held_long_are_not_a_tap()
        {
            Down(1, 100, 100); Down(2, 160, 100);
            for (int i = 0; i < 8; i++) Wait(100);
            Up(1, 100, 100); Up(2, 160, 100);
            Assert.Empty(Of<TwoFingerTap>());
        }

        // ---- one finger drag --------------------------------------------------------------------
        [Fact]
        public void Drag_starts_at_touch_point_and_deltas_add_up()
        {
            Down(1, 100, 100);
            Move(1, 110, 100);           // below drag threshold
            Move(1, 130, 100);           // starts drag
            Move(1, 160, 120);
            Up(1, 160, 120);

            var started = Assert.Single(Of<DragStarted>());
            Assert.Equal(new Pt(100, 100), started.Start);

            Pt total = Of<DragMoved>().Aggregate(new Pt(0, 0), (sum, m) => sum + m.Delta);
            Assert.Equal(new Pt(60, 20), total);

            var ended = Assert.Single(Of<DragEnded>());
            Assert.False(ended.Canceled);
            Assert.Empty(Of<Tap>());
        }

        // ---- two fingers ------------------------------------------------------------------------
        [Fact]
        public void Spreading_fingers_locks_to_zoom_in()
        {
            Down(1, 100, 100); Down(2, 200, 100);
            Move(2, 230, 100); // distance 100 -> 130 (+30%)
            Move(1, 70, 100);  // distance -> 160

            var decided = Assert.Single(Of<TwoFingerModeDecided>());
            Assert.Equal(TwoFingerMode.Zoom, decided.Mode);
            Assert.Empty(Of<TwoFingerPanned>());

            double total = Of<TwoFingerZoomed>().Aggregate(1.0, (s, z) => s * z.Step);
            Assert.Equal(1.6, total, 3);
        }

        [Fact]
        public void Moving_fingers_together_locks_to_pan()
        {
            Down(1, 100, 100); Down(2, 200, 100);
            // Real digitizers report one finger per message, so move them alternately in small steps.
            for (int i = 1; i <= 20; i++)
            {
                Move(1, 100 + 2 * i, 100 + 1.5 * i);
                Move(2, 200 + 2 * i, 100 + 1.5 * i);
            }

            var decided = Assert.Single(Of<TwoFingerModeDecided>());
            Assert.Equal(TwoFingerMode.Pan, decided.Mode);
            Assert.Empty(Of<TwoFingerZoomed>());

            Pt total = Of<TwoFingerPanned>().Aggregate(new Pt(0, 0), (sum, p) => sum + p.Delta);
            Assert.Equal(40, total.X, 6);
            Assert.Equal(30, total.Y, 6);
        }

        [Fact]
        public void Simultaneous_mode_emits_pan_and_zoom()
        {
            _engine.Options.SimultaneousPanZoom = true;
            Down(1, 100, 100); Down(2, 200, 100);
            Move(2, 260, 140);
            Assert.NotEmpty(Of<TwoFingerPanned>());
            Assert.NotEmpty(Of<TwoFingerZoomed>());
        }

        [Fact]
        public void Second_finger_during_drag_ends_drag_and_starts_two_finger()
        {
            Down(1, 100, 100); Move(1, 140, 100);
            Down(2, 300, 100);
            Assert.Single(Of<DragEnded>());
            Assert.Single(Of<TwoFingerStarted>());
        }

        [Fact]
        public void Lifting_one_of_two_fingers_ends_gesture_and_ignores_remaining_finger()
        {
            Down(1, 100, 100); Down(2, 200, 100);
            Move(1, 150, 150); Move(2, 250, 150);
            Up(2, 250, 150);
            Move(1, 400, 400); // must NOT start a one-finger drag (would jump the view)
            Up(1, 400, 400);

            Assert.Single(Of<TwoFingerEnded>());
            Assert.Empty(Of<DragStarted>());
            Assert.Empty(Of<Tap>());
            Assert.False(_engine.IsActive);
        }

        [Fact]
        public void Third_finger_ends_two_finger_gesture()
        {
            Down(1, 100, 100); Down(2, 200, 100);
            Down(3, 300, 100);
            Assert.Single(Of<TwoFingerEnded>());
            Up(1, 100, 100); Up(2, 200, 100); Up(3, 300, 100);
            Assert.False(_engine.IsActive);
        }

        // ---- safety -----------------------------------------------------------------------------
        [Fact]
        public void Lost_up_message_is_cleaned_up_by_stale_timeout()
        {
            Down(1, 100, 100); Move(1, 150, 100); // dragging
            Wait(500); Wait(1000); Wait(1000);    // no more updates, total 2.5 s
            var ended = Assert.Single(Of<DragEnded>());
            Assert.True(ended.Canceled);
            Assert.False(_engine.IsActive);
        }

        [Fact]
        public void Cancel_message_does_not_produce_a_tap()
        {
            Down(1, 100, 100);
            Send(1, PointerPhase.Cancel, 100, 100);
            Assert.Empty(Of<Tap>());
            Assert.False(_engine.IsActive);
        }

        [Fact]
        public void Reset_ends_active_drag_as_canceled()
        {
            Down(1, 100, 100); Move(1, 200, 100);
            _events.AddRange(_engine.Reset(_t));
            Assert.True(Assert.Single(Of<DragEnded>()).Canceled);
            Assert.False(_engine.IsActive);
        }
    }
}
