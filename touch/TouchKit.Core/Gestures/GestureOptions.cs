namespace TouchKit.Core.Gestures
{
    /// <summary>Thresholds for gesture recognition. Distances are physical screen pixels, times are ms.</summary>
    public sealed class GestureOptions
    {
        /// <summary>A finger that moves less than this still counts as a tap / long press.</summary>
        public double TapSlopPx { get; set; } = 12;

        /// <summary>Movement needed before a one-finger drag starts.</summary>
        public double DragStartPx { get; set; } = 14;

        /// <summary>Hold this long without moving to trigger a long press. Shorter releases are taps.</summary>
        public double LongPressMs { get; set; } = 600;

        /// <summary>Second tap must come within this time of the first...</summary>
        public double DoubleTapMs { get; set; } = 350;

        /// <summary>...and within this distance of it.</summary>
        public double DoubleTapSlopPx { get; set; } = 40;

        /// <summary>Two-finger centroid travel that locks the gesture to Pan.</summary>
        public double TwoFingerPanLockPx { get; set; } = 18;

        /// <summary>Relative change in finger spacing that locks the gesture to Zoom (0.08 = 8%).</summary>
        public double TwoFingerZoomLockRatio { get; set; } = 0.08;

        /// <summary>Pan and zoom at the same time instead of locking to one.</summary>
        public bool SimultaneousPanZoom { get; set; }

        /// <summary>If no update arrives for this long while a gesture is active, end it (safety net for lost "up" messages).</summary>
        public double StaleContactMs { get; set; } = 2000;
    }
}
