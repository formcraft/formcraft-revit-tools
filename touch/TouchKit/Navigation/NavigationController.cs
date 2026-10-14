using System;
using TouchKit.Core.Gestures;
using TouchKit.Core.Settings;
using TouchKit.Input;

namespace TouchKit.Navigation
{
    /// <summary>
    /// Turns recognised gestures into Revit navigation, using Revit's own mouse controls:
    ///   pan   = middle-button drag
    ///   orbit = Shift + middle-button drag (3D views)
    ///   zoom  = mouse wheel at the point between the fingers
    ///   select (long press, or tap) = left click; two-finger tap = right click (Flow's gesture plan)
    /// </summary>
    internal sealed class NavigationController
    {
        private enum Motion { None, Pan, Orbit, TwoFingerPan, TwoFingerZoom, TwoFingerFree }

        private readonly SyntheticInput _input;
        private readonly RevitActionQueue _actions;
        private readonly Func<TouchSettings> _settings;

        private Motion _motion = Motion.None;
        private double _cursorX, _cursorY;   // where we've put the (synthetic) cursor
        private double _zoomAccumulator;     // log-scale pinch not yet turned into wheel notches

        public NavigationController(SyntheticInput input, RevitActionQueue actions, Func<TouchSettings> settings)
        {
            _input = input;
            _actions = actions;
            _settings = settings;
        }

        /// <summary>The view the current gesture started in. Set by the router before the first event.</summary>
        public ViewRegion? Target { get; set; }

        public string LastAction { get; private set; } = "";

        public void Handle(GestureEvent e)
        {
            try
            {
                Dispatch(e);
            }
            catch
            {
                // Never leave a button or key held down because of an error.
                Stop();
                throw;
            }
        }

        /// <summary>End any motion in progress and release everything.</summary>
        public void Stop()
        {
            _input.ReleaseAll();
            _motion = Motion.None;
            _zoomAccumulator = 0;
        }

        private void Dispatch(GestureEvent e)
        {
            TouchSettings s = _settings();
            bool is3D = Target?.Kind == ViewKind.Model3D;

            switch (e)
            {
                // ---- one finger ---------------------------------------------------------------
                case Tap tap when s.SelectWith == SelectWith.Tap || s.Tap == TapAction.Click:
                    _input.LeftClick(tap.Position.X, tap.Position.Y);
                    LastAction = s.SelectWith == SelectWith.Tap ? "tap → select" : "tap → click";
                    break;

                case DoubleTap dbl:
                    switch (s.DoubleTap)
                    {
                        case DoubleTapAction.ZoomToFit when Target is not null:
                            _actions.ZoomToFit(Target.ViewId);
                            LastAction = "double tap → zoom to fit";
                            break;
                        case DoubleTapAction.DoubleClick:
                            // The first tap already clicked; a second click inside the system
                            // double-click time makes Windows report a double-click.
                            _input.LeftClick(dbl.Position.X, dbl.Position.Y);
                            LastAction = "double tap → double-click";
                            break;
                    }
                    break;

                case LongPress lp when s.SelectWith == SelectWith.LongPress:
                    _input.LeftClick(lp.Position.X, lp.Position.Y);
                    LastAction = "long press → select";
                    break;

                case TwoFingerTap tt when s.TwoFingerTap == TwoFingerTapAction.RightClick:
                    _input.RightClick(tt.Centroid.X, tt.Centroid.Y);
                    LastAction = "two-finger tap → right-click";
                    break;

                case DragStarted ds:
                    _motion = OneFingerMotion(s, is3D);
                    if (_motion == Motion.None) break;
                    Place(ds.Start);
                    if (_motion == Motion.Orbit) _input.ShiftDown();
                    _input.MiddleDown(_cursorX, _cursorY);
                    LastAction = _motion == Motion.Orbit ? "drag → orbit" : "drag → pan";
                    break;

                case DragMoved dm when _motion is Motion.Pan or Motion.Orbit:
                    double speed = _motion == Motion.Orbit ? s.OrbitSpeed : 1.0;
                    _cursorX += dm.Delta.X * speed;
                    _cursorY += dm.Delta.Y * speed;
                    _input.MoveTo(_cursorX, _cursorY);
                    break;

                case DragEnded:
                    Stop();
                    break;

                // ---- two fingers --------------------------------------------------------------
                case TwoFingerModeDecided decided:
                    Place(decided.Centroid);
                    _zoomAccumulator = 0;
                    switch (decided.Mode)
                    {
                        case TwoFingerMode.Pan:
                            _motion = Motion.TwoFingerPan;
                            _input.MiddleDown(_cursorX, _cursorY);
                            LastAction = "two fingers → pan";
                            break;
                        case TwoFingerMode.Zoom:
                            _motion = Motion.TwoFingerZoom;
                            _input.MoveTo(_cursorX, _cursorY);
                            LastAction = "pinch → zoom";
                            break;
                        case TwoFingerMode.Free:
                            _motion = Motion.TwoFingerFree;
                            _input.MiddleDown(_cursorX, _cursorY);
                            LastAction = "two fingers → pan + zoom";
                            break;
                    }
                    break;

                case TwoFingerPanned tp when _motion is Motion.TwoFingerPan or Motion.TwoFingerFree:
                    _cursorX += tp.Delta.X;
                    _cursorY += tp.Delta.Y;
                    _input.MoveTo(_cursorX, _cursorY);
                    break;

                case TwoFingerZoomed tz when _motion is Motion.TwoFingerZoom or Motion.TwoFingerFree:
                    Zoom(s, tz);
                    break;

                case TwoFingerEnded:
                    Stop();
                    break;
            }
        }

        private void Zoom(TouchSettings s, TwoFingerZoomed tz)
        {
            double direction = s.InvertZoom ? -1 : 1;
            _zoomAccumulator += Math.Log(tz.Step) * s.ZoomSensitivity * direction;

            double notchSize = Math.Log(Math.Max(1.01, s.PinchPerNotch));
            int notches = (int)(_zoomAccumulator / notchSize); // truncates toward zero
            if (notches == 0) return;
            _zoomAccumulator -= notches * notchSize;

            // In zoom-only mode keep the cursor under the fingers so Revit zooms about that point.
            if (_motion == Motion.TwoFingerZoom)
            {
                _cursorX = tz.Centroid.X;
                _cursorY = tz.Centroid.Y;
            }
            _input.Wheel(_cursorX, _cursorY, notches);
        }

        private static Motion OneFingerMotion(TouchSettings s, bool is3D)
        {
            if (is3D)
            {
                return s.OneFinger3D switch
                {
                    OneFinger3DAction.Orbit => Motion.Orbit,
                    OneFinger3DAction.Pan => Motion.Pan,
                    _ => Motion.None,
                };
            }
            return s.OneFinger2D == OneFinger2DAction.Pan ? Motion.Pan : Motion.None;
        }

        private void Place(Pt p)
        {
            _cursorX = p.X;
            _cursorY = p.Y;
        }
    }
}
