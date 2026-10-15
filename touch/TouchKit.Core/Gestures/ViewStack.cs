using System;
using System.Collections.Generic;

namespace TouchKit.Core.Gestures
{
    /// <summary>
    /// One open view's screen rectangle, how recently it was the active view, and the top-level window (frame) that shows it:
    /// Revit's main window, or a view window dragged out of it. Views in different frames never hide each other.
    /// </summary>
    public readonly record struct StackedView(int Left, int Top, int Right, int Bottom, bool IsActive, long LastActive, long Frame = 0);

    /// <summary>
    /// Which open views are actually on screen. Revit stacks tabbed views in (nearly) the same rectangle and shows only the
    /// front one; the others are background tabs that must get no touch and no badge or frame. A view is on screen unless
    /// it mostly overlaps one in front of it: the active view, else the one activated most recently, else the earlier one
    /// in the list. Tiled views don't overlap, so they all stay on screen; a view in its own window (dragged out of the
    /// main window) is stacked only with the views in that window.
    /// </summary>
    public static class ViewStack
    {
        public static bool[] OnScreen(IReadOnlyList<StackedView> views)
        {
            var result = new bool[views.Count];
            for (int i = 0; i < views.Count; i++)
            {
                bool hidden = false;
                for (int j = 0; j < views.Count && !hidden; j++)
                    hidden = j != i && views[i].Frame == views[j].Frame && MostlyOverlaps(views[i], views[j]) && InFront(views[j], j, views[i], i);
                result[i] = !hidden;
            }
            return result;
        }

        private static bool InFront(StackedView a, int ia, StackedView b, int ib)
        {
            if (a.IsActive != b.IsActive) return a.IsActive;
            if (a.LastActive != b.LastActive) return a.LastActive > b.LastActive;
            return ia < ib;
        }

        /// <summary>The two rectangles share more than half of the smaller one.</summary>
        public static bool MostlyOverlaps(StackedView a, StackedView b)
        {
            long w = Math.Min(a.Right, b.Right) - Math.Max(a.Left, b.Left);
            long h = Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Top, b.Top);
            if (w <= 0 || h <= 0) return false;
            long smaller = Math.Min((long)(a.Right - a.Left) * (a.Bottom - a.Top), (long)(b.Right - b.Left) * (b.Bottom - b.Top));
            return smaller > 0 && w * h * 2 > smaller;
        }
    }
}
