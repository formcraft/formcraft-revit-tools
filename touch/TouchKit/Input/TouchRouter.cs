using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Windows.Threading;
using TouchKit.Core.Gestures;
using TouchKit.Core.Settings;
using TouchKit.Navigation;
using TouchKit.Takeover;
using static TouchKit.Input.NativeMethods;

namespace TouchKit.Input
{
    /// <summary>
    /// Decides which fingers TouchKit owns and feeds them through the gesture engine to navigation.
    ///
    /// Ownership is decided once per finger, when it touches down: if it lands on a view that touch has
    /// taken over, that finger belongs to TouchKit until it lifts, wherever it moves. That way a drag that
    /// wanders off the view edge can't suddenly be handed back to Revit half-way through.
    ///
    /// Runs entirely on Revit's UI thread (called from the message hook and a dispatcher timer).
    /// </summary>
    internal sealed class TouchRouter
    {
        private readonly GestureEngine _engine = new();
        private readonly NavigationController _navigation;
        private readonly TakeoverService _takeover;
        private readonly Func<TouchSettings> _settings;
        private readonly HashSet<uint> _owned = new();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly DispatcherTimer _ticker;

        public TouchRouter(NavigationController navigation, TakeoverService takeover, Func<TouchSettings> settings)
        {
            _navigation = navigation;
            _takeover = takeover;
            _settings = settings;
            ApplySettings();

            // Drives long press and the stuck-gesture safety net even when no touch messages arrive.
            _ticker = new DispatcherTimer(TimeSpan.FromMilliseconds(25), DispatcherPriority.Input, (_, _) => Tick(), Dispatcher.CurrentDispatcher);
            _ticker.Start();
        }

        /// <summary>True while TouchKit owns at least one finger or a gesture is in progress.</summary>
        public bool IsBusy => _owned.Count > 0 || _engine.IsActive;

        /// <summary>Draws the hold ring (Flow's on-view feedback). Set by the app once the overlays exist.</summary>
        public UI.ViewOverlayManager? Overlays { get; set; }

        public string? LastError { get; private set; }
        public long GesturesHandled { get; private set; }

        public void ApplySettings() => _engine.Options = _settings().ToGestureOptions();

        /// <summary>
        /// Called by the hook for every touch WM_POINTER* message.
        /// Returns true if TouchKit owns this finger, in which case the hook blocks the message from Revit.
        /// </summary>
        public bool TryClaim(uint message, uint pointerId, uint pointerFlags, int x, int y, ViewRegion? view)
        {
            try
            {
                double now = _clock.Elapsed.TotalMilliseconds;
                var pos = new Pt(x, y);

                if (message == WM_POINTERDOWN)
                {
                    if (view is null || !_takeover.IsOn(view)) return false;

                    _owned.Add(pointerId);
                    if (!_engine.IsActive) _navigation.Target = view;
                    Run(_engine.Process(new PointerSample(pointerId, PointerPhase.Down, pos, now)));
                    return true;
                }

                if (!_owned.Contains(pointerId)) return false;

                if (message == WM_POINTERUPDATE)
                {
                    if ((pointerFlags & POINTER_MESSAGE_FLAG_INCONTACT) != 0)
                        Run(_engine.Process(new PointerSample(pointerId, PointerPhase.Move, pos, now)));
                }
                else if (message == WM_POINTERUP)
                {
                    PointerPhase phase = (pointerFlags & POINTER_MESSAGE_FLAG_CANCELED) != 0 ? PointerPhase.Cancel : PointerPhase.Up;
                    Run(_engine.Process(new PointerSample(pointerId, phase, pos, now)));
                    _owned.Remove(pointerId);
                }
                // Enter/leave/wheel etc. for an owned finger: just block them.
                return true;
            }
            catch (Exception ex)
            {
                Fail(ex);
                return message != WM_POINTERDOWN && _owned.Contains(pointerId);
            }
        }

        /// <summary>Should a mouse message that Windows faked from touch be blocked?</summary>
        public bool ShouldBlockPromotedMouse(ViewRegion? view) => IsBusy || (view is not null && _takeover.IsOn(view));

        /// <summary>Stop everything immediately (view switched off, master off, shutdown).</summary>
        public void Abort()
        {
            try
            {
                foreach (GestureEvent e in _engine.Reset(_clock.Elapsed.TotalMilliseconds)) _navigation.Handle(e);
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
            }
            finally
            {
                _navigation.Stop();
                _owned.Clear();
            }
        }

        public void Dispose()
        {
            _ticker.Stop();
            Abort();
        }

        private void Tick()
        {
            if (!_engine.IsActive)
            {
                if (_ringShown) UpdateRing(selected: false);
                return;
            }
            try
            {
                Run(_engine.Tick(_clock.Elapsed.TotalMilliseconds));
                if (!_engine.IsActive) _owned.Clear(); // safety net ended the gesture
            }
            catch (Exception ex)
            {
                Fail(ex);
            }
        }

        private void Run(IReadOnlyList<GestureEvent> events)
        {
            bool selected = false;
            foreach (GestureEvent e in events)
            {
                if (e is LongPress) selected = true;
                _navigation.Handle(e);
                GesturesHandled++;
            }
            UpdateRing(selected);
        }

        /// <summary>
        /// The ring fills under a resting finger when long press selects. It waits a moment first so quick taps don't
        /// flash it; moving the finger (a pan) or lifting it early removes it; the select itself ends in a tick.
        /// </summary>
        private void UpdateRing(bool selected)
        {
            if (Overlays is null) return;
            TouchSettings s = _settings();
            bool wanted = s.ShowHoldRing && s.SelectWith == SelectWith.LongPress;
            if (selected) { Overlays.EndHold(selected: wanted); _ringShown = false; return; }
            if (wanted && _engine.Holding is { } hold)
            {
                double held = _clock.Elapsed.TotalMilliseconds - hold.SinceMs;
                const double delay = 120;
                if (held < delay) return;
                Overlays.ShowHold((int)hold.Position.X, (int)hold.Position.Y, (held - delay) / Math.Max(1, s.LongPressMs - delay));
                _ringShown = true;
            }
            else if (_ringShown)
            {
                Overlays.EndHold(selected: false);
                _ringShown = false;
            }
        }

        private bool _ringShown;

        private void Fail(Exception ex)
        {
            LastError = ex.Message;
            _navigation.Stop();
            _engine.Reset(_clock.Elapsed.TotalMilliseconds);
        }
    }
}
