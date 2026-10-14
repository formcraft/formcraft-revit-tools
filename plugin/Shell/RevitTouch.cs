#if REVIT2025_OR_GREATER
using System;
using System.Collections.Generic;
using System.Linq;
using Formcraft.Shell.Services;
using TouchKit.Core.Settings;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Formcraft Flow's touch in the pane (U22): Settings › Flow › Touch, the Touch quick tool and the Flow ribbon's
    /// Touch on button all drive the touch engine (touch/TouchKit, started in OnStartup). Words on the pane map to the
    /// engine's settings here; every change applies at once and is saved in %APPDATA%\Formcraft\TouchKit.
    /// </summary>
    public sealed class RevitTouch : ITouchService
    {
        private readonly TouchKit.App _app;

        public RevitTouch(TouchKit.App app)
        {
            _app = app;
            _app.Changed += () => Changed?.Invoke(this, EventArgs.Empty);
        }

        public bool Available => _app.TouchAvailable;
        public string Problem => "Touch didn't start on this PC. Open the touch probe and save a report for support.";
        public bool MasterOn => _app.MasterOn;
        public event EventHandler Changed;

        public void SetMaster(bool on) => _app.SetMaster(on);

        public IReadOnlyList<TouchView> Views =>
            _app.OpenViews.Select(v => new TouchView(v.Id, v.Name, v.Type, v.OnScreen, v.IsActive, v.On)).ToList();

        public void SetView(long id, bool on) => _app.SetView(id, on);
        public void SetAllViews(bool on) => _app.SetAllViews(on);
        public void OpenProbe() => _app.ShowProbe();

        public string Get(string key)
        {
            TouchSettings s = _app.Settings;
            switch (key)
            {
                case TouchKeys.SelectWith: return s.SelectWith == SelectWith.Tap ? "Tap" : "Long press";
                case TouchKeys.Tap: return s.Tap == TapAction.Click ? "Click" : "Nothing";
                case TouchKeys.TwoFingerTap: return s.TwoFingerTap == TwoFingerTapAction.RightClick ? "Right-click menu" : "Nothing";
                case TouchKeys.DoubleTap: return s.DoubleTap == DoubleTapAction.ZoomToFit ? "Zoom to fit" : s.DoubleTap == DoubleTapAction.DoubleClick ? "Double-click" : "Nothing";
                case TouchKeys.Drag3D: return s.OneFinger3D == OneFinger3DAction.Orbit ? "Orbit" : s.OneFinger3D == OneFinger3DAction.Pan ? "Pan" : "Nothing";
                case TouchKeys.Drag2D: return s.OneFinger2D == OneFinger2DAction.Pan ? "Pan" : "Nothing";
                case TouchKeys.Zoom: return TouchKeys.SpeedWord(s.ZoomSensitivity);
                case TouchKeys.Orbit: return TouchKeys.SpeedWord(s.OrbitSpeed);
                case TouchKeys.InvertZoom: return Bool(s.InvertZoom);
                case TouchKeys.Frame: return Bool(s.ShowFrame);
                case TouchKeys.Ring: return Bool(s.ShowHoldRing);
                case TouchKeys.Badge: return Bool(s.ShowBadge);
                case TouchKeys.NewViews: return s.NewViewDefault == NewViewTouchDefault.On ? "On" : s.NewViewDefault == NewViewTouchDefault.ByViewType ? "By view type" : "Off";
                case TouchKeys.ViewTypes:
                    var on = new List<string>();
                    if (s.DefaultOn2D) on.Add("Plans and sections");
                    if (s.DefaultOn3D) on.Add("3D");
                    if (s.DefaultOnSheets) on.Add("Sheets");
                    if (s.DefaultOnSchedules) on.Add("Schedules");
                    return string.Join("|", on);
                default: return null;
            }
        }

        public void Set(string key, string value)
        {
            _app.ChangeSettings(s =>
            {
                switch (key)
                {
                    case TouchKeys.SelectWith: s.SelectWith = value == "Tap" ? SelectWith.Tap : SelectWith.LongPress; break;
                    case TouchKeys.Tap: s.Tap = value == "Click" ? TapAction.Click : TapAction.None; break;
                    case TouchKeys.TwoFingerTap: s.TwoFingerTap = value == "Nothing" ? TwoFingerTapAction.None : TwoFingerTapAction.RightClick; break;
                    case TouchKeys.DoubleTap: s.DoubleTap = value == "Double-click" ? DoubleTapAction.DoubleClick : value == "Nothing" ? DoubleTapAction.None : DoubleTapAction.ZoomToFit; break;
                    case TouchKeys.Drag3D: s.OneFinger3D = value == "Pan" ? OneFinger3DAction.Pan : value == "Nothing" ? OneFinger3DAction.None : OneFinger3DAction.Orbit; break;
                    case TouchKeys.Drag2D: s.OneFinger2D = value == "Nothing" ? OneFinger2DAction.None : OneFinger2DAction.Pan; break;
                    case TouchKeys.Zoom: s.ZoomSensitivity = TouchKeys.SpeedValue(value); break;
                    case TouchKeys.Orbit: s.OrbitSpeed = TouchKeys.SpeedValue(value); break;
                    case TouchKeys.InvertZoom: s.InvertZoom = value == "true"; break;
                    case TouchKeys.Frame: s.ShowFrame = value == "true"; break;
                    case TouchKeys.Ring: s.ShowHoldRing = value == "true"; break;
                    case TouchKeys.Badge: s.ShowBadge = value == "true"; break;
                    case TouchKeys.NewViews:
                        s.NewViewDefault = value == "On" ? NewViewTouchDefault.On : value == "By view type" ? NewViewTouchDefault.ByViewType : NewViewTouchDefault.Off;
                        break;
                    case TouchKeys.ViewTypes:
                        var on = new HashSet<string>(value.Split('|'));
                        s.DefaultOn2D = on.Contains("Plans and sections");
                        s.DefaultOn3D = on.Contains("3D");
                        s.DefaultOnSheets = on.Contains("Sheets");
                        s.DefaultOnSchedules = on.Contains("Schedules");
                        break;
                }
            });
        }

        /// <summary>Gestures, sensitivity, views and on-view feedback to the factory values; recognition timings stay.</summary>
        public void ResetToDefaults()
        {
            var f = new TouchSettings();
            _app.ChangeSettings(s =>
            {
                s.SelectWith = f.SelectWith; s.Tap = f.Tap; s.TwoFingerTap = f.TwoFingerTap; s.DoubleTap = f.DoubleTap;
                s.OneFinger2D = f.OneFinger2D; s.OneFinger3D = f.OneFinger3D; s.TwoFinger = f.TwoFinger;
                s.ZoomSensitivity = f.ZoomSensitivity; s.OrbitSpeed = f.OrbitSpeed; s.InvertZoom = f.InvertZoom;
                s.ShowFrame = f.ShowFrame; s.FrameThickness = f.FrameThickness; s.ShowHoldRing = f.ShowHoldRing;
                s.ShowBadge = f.ShowBadge; s.BadgeCorner = f.BadgeCorner; s.BadgeSize = f.BadgeSize;
                s.NewViewDefault = f.NewViewDefault; s.DefaultOn2D = f.DefaultOn2D; s.DefaultOn3D = f.DefaultOn3D;
                s.DefaultOnSheets = f.DefaultOnSheets; s.DefaultOnSchedules = f.DefaultOnSchedules;
            });
        }

        private static string Bool(bool b) => b ? "true" : "false";
    }
}
#endif
