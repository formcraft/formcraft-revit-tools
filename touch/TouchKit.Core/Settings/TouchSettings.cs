using System.ComponentModel;
using TouchKit.Core.Gestures;

namespace TouchKit.Core.Settings
{
    public enum NewViewTouchDefault
    {
        [Description("Off (turn on per view)")] Off,
        [Description("On")] On,
        [Description("By view type (see below)")] ByViewType,
    }

    public enum BadgeCorner
    {
        [Description("Top right")] TopRight,
        [Description("Top left")] TopLeft,
        [Description("Bottom right")] BottomRight,
        [Description("Bottom left")] BottomLeft,
    }

    public enum OneFinger2DAction
    {
        [Description("Pan")] Pan,
        [Description("Nothing (taps only)")] None,
    }

    public enum OneFinger3DAction
    {
        [Description("Orbit")] Orbit,
        [Description("Pan")] Pan,
        [Description("Nothing (taps only)")] None,
    }

    public enum TwoFingerBehaviour
    {
        [Description("Pan OR zoom (locks to the first one detected)")] Locked,
        [Description("Pan AND zoom together (experimental)")] Together,
    }

    public enum SelectWith
    {
        [Description("Long press")] LongPress,
        [Description("Tap")] Tap,
    }

    public enum TwoFingerTapAction
    {
        [Description("Right-click menu")] RightClick,
        [Description("Nothing")] None,
    }

    public enum TapAction
    {
        [Description("Click (select)")] Click,
        [Description("Nothing")] None,
    }

    public enum DoubleTapAction
    {
        [Description("Zoom to fit")] ZoomToFit,
        [Description("Double-click")] DoubleClick,
        [Description("Nothing")] None,
    }

    /// <summary>
    /// Touch navigation settings. These are personal and hardware-specific, so they are stored per user
    /// (not per project). The defaults below are factory defaults: after first use, the last values are kept.
    /// </summary>
    public sealed class TouchSettings
    {
        // ---- Views ------------------------------------------------------------------------------
        [Setting("Views", "New views start with touch", Order = 1,
            Description = "Whether Flow takes over touch in a view you haven't set yet. Views you've switched on or off keep their own state.")]
        public NewViewTouchDefault NewViewDefault { get; set; } = NewViewTouchDefault.Off;

        [Setting("Views", "By type: 3D views", Order = 2)]
        public bool DefaultOn3D { get; set; } = true;

        [Setting("Views", "By type: plans, sections, elevations, drafting", Order = 3)]
        public bool DefaultOn2D { get; set; } = true;

        [Setting("Views", "By type: sheets", Order = 4)]
        public bool DefaultOnSheets { get; set; } = true;

        [Setting("Views", "By type: schedules", Order = 5)]
        public bool DefaultOnSchedules { get; set; }

        [Setting("Views", "Remember each view's on/off state", Order = 6,
            Description = "Stored per project on this computer. Nothing is written into the Revit model.")]
        public bool RememberPerView { get; set; } = true;

        // ---- Appearance -------------------------------------------------------------------------
        [Setting("Appearance", "'Touch on' badge in the view corner", Order = 1,
            Description = "Tap the badge to switch touch for that view. Off by default: views are switched in Settings › Flow › Touch.")]
        public bool ShowBadge { get; set; }

        [Setting("Appearance", "Badge corner", Order = 2)]
        public BadgeCorner BadgeCorner { get; set; } = BadgeCorner.TopLeft; // top right clashes with the 3D ViewCube

        [Setting("Appearance", "Badge size", Unit = "px", Min = 28, Max = 96, Order = 3)]
        public int BadgeSize { get; set; } = 44;

        [Setting("Appearance", "Thin Studio Green frame on views Flow handles", Order = 4)]
        public bool ShowFrame { get; set; } = true;

        [Setting("Appearance", "Frame thickness", Unit = "px", Min = 1, Max = 8, Order = 5)]
        public int FrameThickness { get; set; } = 2;

        [Setting("Appearance", "Ring that fills while holding to select", Order = 6,
            Description = "Moving a finger while holding turns the press into a pan, so nothing is selected by accident.")]
        public bool ShowHoldRing { get; set; } = true;

        // ---- Gestures ---------------------------------------------------------------------------
        [Setting("Gestures", "One-finger drag in 2D views", Order = 1)]
        public OneFinger2DAction OneFinger2D { get; set; } = OneFinger2DAction.Pan;

        [Setting("Gestures", "One-finger drag in 3D views", Order = 2)]
        public OneFinger3DAction OneFinger3D { get; set; } = OneFinger3DAction.Orbit;

        [Setting("Gestures", "Two-finger gesture", Order = 3)]
        public TwoFingerBehaviour TwoFinger { get; set; } = TwoFingerBehaviour.Locked;

        [Setting("Gestures", "Select elements with", Order = 0,
            Description = "Long press selects by default, so orbit and zoom never select by accident.")]
        public SelectWith SelectWith { get; set; } = SelectWith.LongPress;

        [Setting("Gestures", "Single tap", Order = 4, Description = "When elements are selected with a long press.")]
        public TapAction Tap { get; set; } = TapAction.None;

        [Setting("Gestures", "Two-finger tap", Order = 5)]
        public TwoFingerTapAction TwoFingerTap { get; set; } = TwoFingerTapAction.RightClick;

        [Setting("Gestures", "Double tap", Order = 6)]
        public DoubleTapAction DoubleTap { get; set; } = DoubleTapAction.ZoomToFit;

        [Setting("Gestures", "Zoom sensitivity", Unit = "x", Min = 0.25, Max = 4, Order = 7)]
        public double ZoomSensitivity { get; set; } = 1.0;

        [Setting("Gestures", "Invert pinch zoom", Order = 8)]
        public bool InvertZoom { get; set; }

        [Setting("Gestures", "Orbit speed", Unit = "x", Min = 0.25, Max = 4, Order = 9)]
        public double OrbitSpeed { get; set; } = 1.0;

        // ---- Advanced (recognition) -------------------------------------------------------------
        [Setting("Recognition", "Tap tolerance", Unit = "px", Min = 2, Max = 60, Advanced = true, Order = 1,
            Description = "A finger moving less than this still counts as a tap or long press.")]
        public double TapSlopPx { get; set; } = 12;

        [Setting("Recognition", "Drag starts after", Unit = "px", Min = 2, Max = 80, Advanced = true, Order = 2)]
        public double DragStartPx { get; set; } = 14;

        [Setting("Recognition", "Long press time", Unit = "ms", Min = 250, Max = 2000, Advanced = true, Order = 3)]
        public double LongPressMs { get; set; } = 600;

        [Setting("Recognition", "Double tap window", Unit = "ms", Min = 150, Max = 800, Advanced = true, Order = 4)]
        public double DoubleTapMs { get; set; } = 350;

        [Setting("Recognition", "Double tap distance", Unit = "px", Min = 5, Max = 150, Advanced = true, Order = 5)]
        public double DoubleTapSlopPx { get; set; } = 40;

        [Setting("Recognition", "Two-finger pan lock", Unit = "px", Min = 4, Max = 100, Advanced = true, Order = 6,
            Description = "Centroid travel that decides a two-finger gesture is a pan.")]
        public double TwoFingerPanLockPx { get; set; } = 18;

        [Setting("Recognition", "Two-finger zoom lock", Unit = "%", Min = 2, Max = 40, Advanced = true, Order = 7,
            Description = "Change in finger spacing that decides a two-finger gesture is a zoom.")]
        public double TwoFingerZoomLockPercent { get; set; } = 8;

        [Setting("Recognition", "Pinch per wheel notch", Unit = "x", Min = 1.02, Max = 2, Advanced = true, Order = 8,
            Description = "How much the fingers must spread or pinch to send one mouse-wheel step to Revit.")]
        public double PinchPerNotch { get; set; } = 1.12;

        [Setting("Recognition", "End stuck gestures after", Unit = "ms", Min = 500, Max = 10000, Advanced = true, Order = 9,
            Description = "Safety net: if Windows stops reporting a finger, release everything after this long.")]
        public double StaleContactMs { get; set; } = 2000;

        /// <summary>Recognition thresholds in the form the gesture engine wants.</summary>
        public GestureOptions ToGestureOptions() => new()
        {
            TapSlopPx = TapSlopPx,
            DragStartPx = DragStartPx,
            LongPressMs = LongPressMs,
            DoubleTapMs = DoubleTapMs,
            DoubleTapSlopPx = DoubleTapSlopPx,
            TwoFingerPanLockPx = TwoFingerPanLockPx,
            TwoFingerZoomLockRatio = TwoFingerZoomLockPercent / 100.0,
            SimultaneousPanZoom = TwoFinger == TwoFingerBehaviour.Together,
            StaleContactMs = StaleContactMs,
        };
    }
}
