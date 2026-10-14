namespace TouchKit.Core.Gestures
{
    /// <summary>Output of the gesture engine. The navigation layer turns these into Revit actions.</summary>
    public abstract record GestureEvent(double TimeMs);

    // ---- single finger, no movement ---------------------------------------------------------
    public sealed record Tap(double TimeMs, Pt Position) : GestureEvent(TimeMs);
    public sealed record DoubleTap(double TimeMs, Pt Position) : GestureEvent(TimeMs);
    public sealed record LongPress(double TimeMs, Pt Position) : GestureEvent(TimeMs);

    // ---- single finger drag -----------------------------------------------------------------
    /// <summary>The finger moved past the drag threshold. <paramref name="Start"/> is where it first touched.</summary>
    public sealed record DragStarted(double TimeMs, Pt Start) : GestureEvent(TimeMs);
    /// <summary><paramref name="Delta"/> is movement since the previous drag event.</summary>
    public sealed record DragMoved(double TimeMs, Pt Position, Pt Delta) : GestureEvent(TimeMs);
    public sealed record DragEnded(double TimeMs, Pt Position, bool Canceled) : GestureEvent(TimeMs);

    // ---- two fingers ------------------------------------------------------------------------
    public enum TwoFingerMode
    {
        /// <summary>Not yet clear whether the user is panning or pinching.</summary>
        Undecided,
        Pan,
        Zoom,
        /// <summary>Pan and zoom together (option SimultaneousPanZoom).</summary>
        Free,
    }

    public sealed record TwoFingerStarted(double TimeMs, Pt Centroid) : GestureEvent(TimeMs);
    /// <summary>The engine decided what this two-finger gesture is.</summary>
    public sealed record TwoFingerModeDecided(double TimeMs, TwoFingerMode Mode, Pt Centroid) : GestureEvent(TimeMs);
    /// <summary>Centroid moved by <paramref name="Delta"/> since the previous pan event.</summary>
    public sealed record TwoFingerPanned(double TimeMs, Pt Centroid, Pt Delta) : GestureEvent(TimeMs);
    /// <summary><paramref name="Step"/> is the scale change since the previous zoom event (&gt;1 = fingers apart = zoom in).</summary>
    public sealed record TwoFingerZoomed(double TimeMs, Pt Centroid, double Step, double TotalScale) : GestureEvent(TimeMs);
    public sealed record TwoFingerEnded(double TimeMs, Pt Centroid, bool Canceled) : GestureEvent(TimeMs);
    /// <summary>Two fingers touched and lifted without moving (after <see cref="TwoFingerEnded"/>).</summary>
    public sealed record TwoFingerTap(double TimeMs, Pt Centroid) : GestureEvent(TimeMs);
}
