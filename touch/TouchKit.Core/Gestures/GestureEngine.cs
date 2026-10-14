using System;
using System.Collections.Generic;
using System.Linq;

namespace TouchKit.Core.Gestures
{
    /// <summary>
    /// Turns a stream of finger contacts into gestures. Pure logic: no Windows, no Revit, no clock of its own.
    /// Feed it samples with <see cref="Process"/> and call <see cref="Tick"/> regularly (for long press and the
    /// stale-contact safety net). Both return the gestures recognised as a result.
    ///
    /// States:
    ///   Idle        no fingers
    ///   OneDown     one finger down, not moved yet (could become tap, long press or drag)
    ///   Dragging    one finger dragging
    ///   LongPressed long press fired; ignore until the finger lifts
    ///   TwoFinger   two fingers: pan / zoom
    ///   WaitAllUp   something ended a gesture early (3rd finger, one of two lifted); ignore until all lift
    /// </summary>
    public sealed class GestureEngine
    {
        private enum State { Idle, OneDown, Dragging, LongPressed, TwoFinger, WaitAllUp }

        private sealed class Contact
        {
            public Pt Start;
            public Pt Current;
            public double StartTime;
            public double LastTime;
            public double MaxTravel;
        }

        private readonly Dictionary<uint, Contact> _contacts = new();
        private State _state = State.Idle;

        // one-finger drag
        private Pt _lastDragPos;

        // two-finger
        private TwoFingerMode _mode;
        private Pt _startCentroid;
        private Pt _lastCentroid;
        private double _startDistance;
        private double _lastDistance;
        private double _twoStartTime;
        private bool _twoMoved;

        // double tap
        private double? _lastTapTime;
        private Pt _lastTapPos;

        public GestureEngine(GestureOptions? options = null)
        {
            Options = options ?? new GestureOptions();
        }

        public GestureOptions Options { get; set; }

        /// <summary>True while any gesture is in progress (fingers down).</summary>
        public bool IsActive => _state != State.Idle;

        public int ContactCount => _contacts.Count;

        /// <summary>Where one finger rests that could still become a long press, and since when; null otherwise.</summary>
        public (Pt Position, double SinceMs)? Holding =>
            _state == State.OneDown && _contacts.Count == 1 ? (_contacts.Values.First().Start, _contacts.Values.First().StartTime) : null;

        public IReadOnlyList<GestureEvent> Process(PointerSample s)
        {
            var output = new List<GestureEvent>(2);
            switch (s.Phase)
            {
                case PointerPhase.Down: OnDown(s, output); break;
                case PointerPhase.Move: OnMove(s, output); break;
                case PointerPhase.Up: OnUp(s, canceled: false, output); break;
                case PointerPhase.Cancel: OnUp(s, canceled: true, output); break;
            }
            return output;
        }

        public IReadOnlyList<GestureEvent> Tick(double nowMs)
        {
            var output = new List<GestureEvent>(1);

            if (_state == State.OneDown && _contacts.Count == 1)
            {
                Contact c = _contacts.Values.First();
                if (nowMs - c.StartTime >= Options.LongPressMs && c.MaxTravel <= Options.TapSlopPx)
                {
                    output.Add(new LongPress(nowMs, c.Start));
                    _state = State.LongPressed;
                    _lastTapTime = null;
                }
            }

            if (_state != State.Idle && _contacts.Count > 0)
            {
                double newest = _contacts.Values.Max(c => c.LastTime);
                if (nowMs - newest > Options.StaleContactMs)
                {
                    EndCurrentGesture(nowMs, canceled: true, output);
                    _contacts.Clear();
                    _state = State.Idle;
                }
            }

            return output;
        }

        /// <summary>Abort whatever is happening (e.g. the view lost takeover mid-gesture).</summary>
        public IReadOnlyList<GestureEvent> Reset(double nowMs)
        {
            var output = new List<GestureEvent>(1);
            EndCurrentGesture(nowMs, canceled: true, output);
            _contacts.Clear();
            _state = State.Idle;
            return output;
        }

        // ---------------------------------------------------------------------------------------------

        private void OnDown(PointerSample s, List<GestureEvent> output)
        {
            _contacts[s.Id] = new Contact { Start = s.Position, Current = s.Position, StartTime = s.TimeMs, LastTime = s.TimeMs };

            switch (_contacts.Count)
            {
                case 1:
                    _state = State.OneDown;
                    break;

                case 2 when _state is State.OneDown or State.Dragging:
                    if (_state == State.Dragging) output.Add(new DragEnded(s.TimeMs, _lastDragPos, Canceled: false));
                    BeginTwoFinger(s.TimeMs, output);
                    break;

                default:
                    // 2 fingers after a long press, or a 3rd+ finger: end what's running and wait for a clean start.
                    EndCurrentGesture(s.TimeMs, canceled: false, output);
                    _state = State.WaitAllUp;
                    break;
            }
        }

        private void OnMove(PointerSample s, List<GestureEvent> output)
        {
            if (!_contacts.TryGetValue(s.Id, out Contact? c)) return;
            c.Current = s.Position;
            c.LastTime = s.TimeMs;
            c.MaxTravel = Math.Max(c.MaxTravel, Pt.Distance(c.Start, c.Current));

            switch (_state)
            {
                case State.OneDown:
                    if (c.MaxTravel > Options.DragStartPx)
                    {
                        _state = State.Dragging;
                        _lastTapTime = null;
                        output.Add(new DragStarted(s.TimeMs, c.Start));
                        output.Add(new DragMoved(s.TimeMs, c.Current, c.Current - c.Start));
                        _lastDragPos = c.Current;
                    }
                    break;

                case State.Dragging:
                    Pt delta = c.Current - _lastDragPos;
                    if (delta.X != 0 || delta.Y != 0)
                    {
                        output.Add(new DragMoved(s.TimeMs, c.Current, delta));
                        _lastDragPos = c.Current;
                    }
                    break;

                case State.TwoFinger:
                    UpdateTwoFinger(s.TimeMs, output);
                    break;
            }
        }

        private void OnUp(PointerSample s, bool canceled, List<GestureEvent> output)
        {
            if (!_contacts.TryGetValue(s.Id, out Contact? c)) return;
            c.Current = s.Position;
            c.MaxTravel = Math.Max(c.MaxTravel, Pt.Distance(c.Start, c.Current));
            _contacts.Remove(s.Id);

            switch (_state)
            {
                case State.OneDown:
                    if (!canceled && c.MaxTravel <= Options.TapSlopPx && s.TimeMs - c.StartTime < Options.LongPressMs)
                    {
                        EmitTap(s.TimeMs, c.Start, output);
                    }
                    _state = State.Idle;
                    break;

                case State.Dragging:
                    output.Add(new DragEnded(s.TimeMs, c.Current, canceled));
                    _state = State.Idle;
                    break;

                case State.LongPressed:
                    _state = State.Idle;
                    break;

                case State.TwoFinger:
                    output.Add(new TwoFingerEnded(s.TimeMs, _lastCentroid, canceled));
                    bool still = !canceled && !_twoMoved && c.MaxTravel <= Options.TapSlopPx &&
                                 _contacts.Values.All(o => o.MaxTravel <= Options.TapSlopPx) &&
                                 s.TimeMs - _twoStartTime < Options.LongPressMs;
                    if (still) output.Add(new TwoFingerTap(s.TimeMs, _startCentroid));
                    _state = _contacts.Count > 0 ? State.WaitAllUp : State.Idle;
                    break;

                case State.WaitAllUp:
                    if (_contacts.Count == 0) _state = State.Idle;
                    break;
            }

            if (_contacts.Count == 0 && _state == State.WaitAllUp) _state = State.Idle;
        }

        private void EmitTap(double time, Pt pos, List<GestureEvent> output)
        {
            if (_lastTapTime is double last &&
                time - last <= Options.DoubleTapMs &&
                Pt.Distance(pos, _lastTapPos) <= Options.DoubleTapSlopPx)
            {
                output.Add(new DoubleTap(time, pos));
                _lastTapTime = null;
            }
            else
            {
                output.Add(new Tap(time, pos));
                _lastTapTime = time;
                _lastTapPos = pos;
            }
        }

        private void BeginTwoFinger(double time, List<GestureEvent> output)
        {
            (Pt a, Pt b) = TwoPoints();
            _startCentroid = _lastCentroid = Pt.Midpoint(a, b);
            _startDistance = _lastDistance = Math.Max(1, Pt.Distance(a, b));
            _mode = Options.SimultaneousPanZoom ? TwoFingerMode.Free : TwoFingerMode.Undecided;
            _state = State.TwoFinger;
            _twoStartTime = time;
            _twoMoved = false;
            _lastTapTime = null;

            output.Add(new TwoFingerStarted(time, _startCentroid));
            if (_mode == TwoFingerMode.Free) output.Add(new TwoFingerModeDecided(time, _mode, _startCentroid));
        }

        private void UpdateTwoFinger(double time, List<GestureEvent> output)
        {
            if (_contacts.Count != 2) return;
            (Pt a, Pt b) = TwoPoints();
            Pt centroid = Pt.Midpoint(a, b);
            double distance = Math.Max(1, Pt.Distance(a, b));
            if (Math.Abs(distance / _startDistance - 1) >= Options.TwoFingerZoomLockRatio || Pt.Distance(centroid, _startCentroid) >= Options.TwoFingerPanLockPx)
                _twoMoved = true;

            if (_mode == TwoFingerMode.Undecided)
            {
                double scaleChange = Math.Abs(distance / _startDistance - 1);
                double travel = Pt.Distance(centroid, _startCentroid);

                if (scaleChange >= Options.TwoFingerZoomLockRatio) _mode = TwoFingerMode.Zoom;
                else if (travel >= Options.TwoFingerPanLockPx) _mode = TwoFingerMode.Pan;
                else return; // keep waiting; baselines stay at the start so nothing is lost

                output.Add(new TwoFingerModeDecided(time, _mode, _startCentroid));
            }

            if (_mode is TwoFingerMode.Pan or TwoFingerMode.Free)
            {
                Pt delta = centroid - _lastCentroid;
                if (delta.X != 0 || delta.Y != 0) output.Add(new TwoFingerPanned(time, centroid, delta));
            }

            if (_mode is TwoFingerMode.Zoom or TwoFingerMode.Free)
            {
                double step = distance / _lastDistance;
                if (Math.Abs(step - 1) > 1e-4) output.Add(new TwoFingerZoomed(time, centroid, step, distance / _startDistance));
            }

            _lastCentroid = centroid;
            _lastDistance = distance;
        }

        private void EndCurrentGesture(double time, bool canceled, List<GestureEvent> output)
        {
            switch (_state)
            {
                case State.Dragging:
                    output.Add(new DragEnded(time, _lastDragPos, canceled));
                    break;
                case State.TwoFinger:
                    output.Add(new TwoFingerEnded(time, _lastCentroid, canceled));
                    break;
            }
        }

        private (Pt, Pt) TwoPoints()
        {
            // Order by id so the pair is stable between frames.
            Contact[] two = _contacts.OrderBy(p => p.Key).Select(p => p.Value).Take(2).ToArray();
            return (two[0].Current, two[1].Current);
        }
    }
}
