using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using TouchKit.Core.Settings;
using TouchKit.Input;
using TouchKit.Takeover;
using static TouchKit.Input.NativeMethods;

namespace TouchKit.UI
{
    /// <summary>
    /// Draws a touch badge (tap to toggle) and an optional coloured frame on every open view.
    /// These are small borderless windows owned by Revit's main window, positioned over each view.
    /// They never take focus, and the frame lets every click and touch pass straight through.
    /// </summary>
    internal sealed class ViewOverlayManager : IDisposable
    {
        // Formcraft Flow's Studio Green (Fmc.Flow in the pane's theme).
        internal static readonly Color Accent = Color.FromRgb(0x7F, 0xC7, 0xBE);

        private readonly IntPtr _revitWindow;
        private readonly ViewRegionTracker _views;
        private readonly TakeoverService _takeover;
        private readonly Func<TouchSettings> _settings;
        private readonly Action<ViewRegion> _onBadgeTapped;
        private readonly Dictionary<long, Overlay> _overlays = new();
        private readonly DispatcherTimer _timer;

        public ViewOverlayManager(IntPtr revitWindow, ViewRegionTracker views, TakeoverService takeover,
            Func<TouchSettings> settings, Action<ViewRegion> onBadgeTapped)
        {
            _revitWindow = revitWindow;
            _views = views;
            _takeover = takeover;
            _settings = settings;
            _onBadgeTapped = onBadgeTapped;

            _timer = new DispatcherTimer(TimeSpan.FromMilliseconds(120), DispatcherPriority.Background, (_, _) => Update(), Dispatcher.CurrentDispatcher);
            _timer.Start();
        }

        public void Dispose()
        {
            _timer.Stop();
            foreach (Overlay o in _overlays.Values) o.Close();
            _overlays.Clear();
        }

        private void Update()
        {
            try
            {
                TouchSettings s = _settings();
                IReadOnlyList<ViewRegion> regions = _views.Regions;

                // Hide everything while Revit is minimised or a modal dialog is open (it disables the main window),
                // so the overlays never sit on top of a dialog.
                bool suppress = IsIconic(_revitWindow) || !IsWindowEnabled(_revitWindow);

                // Remove overlays for views that are no longer open.
                regions = regions.Where(r => r.OnScreen).ToList();
                foreach (long gone in _overlays.Keys.Where(id => regions.All(r => r.ViewId != id)).ToList())
                {
                    _overlays[gone].Close();
                    _overlays.Remove(gone);
                }

                double scale = Math.Max(1, GetDpiForWindow(_revitWindow)) / 96.0;

                foreach (ViewRegion region in regions)
                {
                    if (!_overlays.TryGetValue(region.ViewId, out Overlay? overlay))
                    {
                        overlay = new Overlay(_revitWindow, region, _onBadgeTapped);
                        _overlays[region.ViewId] = overlay;
                    }

                    bool on = _takeover.IsOnIgnoringMaster(region);
                    overlay.Update(region, on, _takeover.MasterOn, s, scale, suppress);
                }
            }
            catch
            {
                // Overlays are cosmetic; never let them disturb Revit.
            }
        }

        // ---- hold ring (board flow/Flow_Gestures: holding, selected, moved becomes pan) ----------------

        private HoldRingWindow? _ring;
        private DispatcherTimer? _ringFade;

        /// <summary>Shows the ring under a resting finger, filled to <paramref name="progress"/> (0..1). Physical px.</summary>
        internal void ShowHold(int x, int y, double progress)
        {
            try
            {
                _ringFade?.Stop();
                _ring ??= new HoldRingWindow(_revitWindow);
                double scale = Math.Max(1, GetDpiForWindow(_revitWindow)) / 96.0;
                _ring.Apply(true, x, y, (int)Math.Round(64 * scale), progress, done: false);
            }
            catch
            {
                // cosmetic only
            }
        }

        /// <summary>Ends the ring: a tick for a moment when the long press selected, otherwise gone at once.</summary>
        internal void EndHold(bool selected)
        {
            try
            {
                if (_ring is null || !_ring.IsVisible) return;
                if (!selected) { _ring.Apply(false, 0, 0, 0, 0, false); return; }
                _ring.Apply(true, _ring.X, _ring.Y, _ring.Size, 1, done: true);
                _ringFade ??= new DispatcherTimer(TimeSpan.FromMilliseconds(350), DispatcherPriority.Normal,
                    (_, _) => { _ringFade!.Stop(); _ring?.Apply(false, 0, 0, 0, 0, false); }, Dispatcher.CurrentDispatcher);
                _ringFade.Start();
            }
            catch
            {
                // cosmetic only
            }
        }

        // ------------------------------------------------------------------------------------------

        /// <summary>The badge and frame for one view.</summary>
        private sealed class Overlay
        {
            private readonly FrameWindow _frame;
            private readonly BadgeWindow _badge;
            private ViewRegion _region;

            public Overlay(IntPtr owner, ViewRegion region, Action<ViewRegion> onTapped)
            {
                _region = region;
                _frame = new FrameWindow(owner);
                _badge = new BadgeWindow(owner, () => onTapped(_region));
            }

            public void Update(ViewRegion region, bool on, bool masterOn, TouchSettings s, double scale, bool suppress)
            {
                _region = region;
                int width = region.Right - region.Left;
                int height = region.Bottom - region.Top;
                bool tooSmall = width < 80 || height < 80;

                // Frame: only on views TouchKit currently owns.
                bool showFrame = !suppress && !tooSmall && s.ShowFrame && on && masterOn;
                _frame.Apply(showFrame, region.Left, region.Top, width, height, s.FrameThickness);

                // Badge: on every view, so you can switch touch on.
                int size = (int)Math.Round(s.BadgeSize * scale);
                int margin = (int)Math.Round(10 * scale);
                (int bx, int by) = s.BadgeCorner switch
                {
                    BadgeCorner.TopLeft => (region.Left + margin, region.Top + margin),
                    BadgeCorner.BottomLeft => (region.Left + margin, region.Bottom - margin - size),
                    BadgeCorner.BottomRight => (region.Right - margin - size, region.Bottom - margin - size),
                    _ => (region.Right - margin - size, region.Top + margin),
                };
                bool showBadge = !suppress && !tooSmall && s.ShowBadge && masterOn;
                _badge.Apply(showBadge, bx, by, size, on, region.ViewName);
            }

            public void Close()
            {
                _frame.Close();
                _badge.Close();
            }
        }

        /// <summary>Base for overlay windows: borderless, transparent, never activates, hidden from Alt+Tab.</summary>
        private abstract class OverlayWindow : Window
        {
            private readonly IntPtr _hwnd;
            private (int x, int y, int w, int h) _placed = (-1, -1, -1, -1);

            protected OverlayWindow(IntPtr owner, bool clickThrough)
            {
                WindowStyle = WindowStyle.None;
                AllowsTransparency = true;
                Background = Brushes.Transparent;
                ShowInTaskbar = false;
                ShowActivated = false;
                ResizeMode = ResizeMode.NoResize;
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = -10000;
                Top = -10000;
                Width = 10;
                Height = 10;

                var helper = new WindowInteropHelper(this) { Owner = owner };
                _hwnd = helper.EnsureHandle();
                long flags = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                if (clickThrough) flags |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
                AddExStyle(_hwnd, flags);
            }

            protected void Place(bool visible, int x, int y, int w, int h)
            {
                if (!visible)
                {
                    if (IsVisible) Hide();
                    return;
                }

                if (!IsVisible)
                {
                    Show();
                    _placed = (-1, -1, -1, -1);
                }

                // Physical pixels straight to Win32, so DPI scaling can't shift the overlay.
                if (_placed != (x, y, w, h))
                {
                    SetWindowPos(_hwnd, IntPtr.Zero, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER);
                    _placed = (x, y, w, h);
                }
            }
        }

        private sealed class FrameWindow : OverlayWindow
        {
            private readonly Border _border = new()
            {
                BorderBrush = new SolidColorBrush(Color.FromArgb(0xD0, Accent.R, Accent.G, Accent.B)),
            };

            public FrameWindow(IntPtr owner) : base(owner, clickThrough: true)
            {
                IsHitTestVisible = false;
                Content = _border;
            }

            public void Apply(bool visible, int x, int y, int w, int h, int thickness)
            {
                _border.BorderThickness = new Thickness(thickness);
                Place(visible, x, y, w, h);
            }
        }

        /// <summary>A ring centred on the finger that fills while it rests, and ends in a tick when the press selects.</summary>
        private sealed class HoldRingWindow : OverlayWindow
        {
            private readonly Canvas _canvas = new();
            private readonly Ellipse _track = new() { StrokeThickness = 3 };
            private readonly Path _arc = new() { StrokeThickness = 4, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round };
            private readonly Path _tick = new() { StrokeThickness = 4, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round };

            public HoldRingWindow(IntPtr owner) : base(owner, clickThrough: true)
            {
                IsHitTestVisible = false;
                var accent = new SolidColorBrush(Accent);
                _track.Stroke = new SolidColorBrush(Color.FromArgb(0x60, 0xFF, 0xFF, 0xFF));
                _track.Fill = new SolidColorBrush(Color.FromArgb(0x30, 0x10, 0x20, 0x30));
                _arc.Stroke = accent;
                _tick.Stroke = accent;
                _canvas.Children.Add(_track);
                _canvas.Children.Add(_arc);
                _canvas.Children.Add(_tick);
                Content = _canvas;
            }

            public int X { get; private set; }
            public int Y { get; private set; }
            public int Size { get; private set; }

            public void Apply(bool visible, int x, int y, int sizePx, double progress, bool done)
            {
                X = x; Y = y; Size = sizePx;
                Place(visible, x - sizePx / 2, y - sizePx / 2, sizePx, sizePx);
                if (!visible) return;

                double d = ActualWidth > 0 ? ActualWidth : 64;
                double r = d / 2 - 4;
                var c = new Point(d / 2, d / 2);
                _track.Width = _track.Height = r * 2;
                Canvas.SetLeft(_track, c.X - r);
                Canvas.SetTop(_track, c.Y - r);

                double p = Math.Max(0, Math.Min(0.9999, progress));
                double angle = p * 2 * Math.PI;
                var start = new Point(c.X, c.Y - r);
                var end = new Point(c.X + r * Math.Sin(angle), c.Y - r * Math.Cos(angle));
                var figure = new PathFigure { StartPoint = start, IsClosed = false };
                figure.Segments.Add(new ArcSegment(end, new Size(r, r), 0, angle > Math.PI, SweepDirection.Clockwise, true));
                _arc.Data = p <= 0 ? null : new PathGeometry(new[] { figure });

                _tick.Data = done
                    ? Geometry.Parse(FormattableString.Invariant($"M {c.X - r * 0.4},{c.Y} L {c.X - r * 0.1},{c.Y + r * 0.32} L {c.X + r * 0.45},{c.Y - r * 0.3}"))
                    : null;
            }
        }

        private sealed class BadgeWindow : OverlayWindow
        {
            private readonly Ellipse _disc = new();
            private readonly Ellipse _ring = new() { StrokeThickness = 2.5, Width = 0, Height = 0 };
            private readonly Ellipse _dot = new();
            private readonly Grid _grid = new();
            private bool? _shownOn;

            public BadgeWindow(IntPtr owner, Action onTapped) : base(owner, clickThrough: false)
            {
                _grid.Children.Add(_disc);
                _grid.Children.Add(_ring);
                _grid.Children.Add(_dot);
                _ring.HorizontalAlignment = _dot.HorizontalAlignment = HorizontalAlignment.Center;
                _ring.VerticalAlignment = _dot.VerticalAlignment = VerticalAlignment.Center;
                Content = _grid;
                Cursor = Cursors.Hand;

                // Mouse clicks and finger taps both arrive here (WPF turns taps into mouse events).
                MouseLeftButtonUp += (_, e) => { e.Handled = true; onTapped(); };
            }

            public void Apply(bool visible, int x, int y, int sizePx, bool on, string viewName)
            {
                if (_shownOn != on)
                {
                    var accent = new SolidColorBrush(Accent);
                    _disc.Fill = on ? accent : new SolidColorBrush(Color.FromArgb(0xB0, 0x30, 0x30, 0x30));
                    _disc.Stroke = on ? Brushes.White : new SolidColorBrush(Color.FromArgb(0xC0, 0xFF, 0xFF, 0xFF));
                    _disc.StrokeThickness = 1.5;
                    _ring.Stroke = Brushes.White;
                    _dot.Fill = Brushes.White;
                    _ring.Opacity = _dot.Opacity = on ? 1.0 : 0.75;
                    _shownOn = on;
                }

                ToolTip = on
                    ? $"Touch is ON for '{viewName}'. Tap to give touch back to Revit."
                    : $"Touch is OFF for '{viewName}'. Tap to let Formcraft Flow handle touch here.";

                Place(visible, x, y, sizePx, sizePx);

                // Size the drawing to the window's size in WPF units.
                double d = ActualWidth > 0 ? ActualWidth : 40;
                _ring.Width = _ring.Height = d * 0.56;
                _dot.Width = _dot.Height = d * 0.24;
            }
        }
    }
}
