using System;
using System.Collections.Generic;

namespace TouchKit.Core.Gestures
{
    /// <summary>A top-level window on Revit's UI thread: its handle and screen rectangle.</summary>
    public readonly record struct FrameWindow(long Handle, int Left, int Top, int Right, int Bottom)
    {
        public long Area => (long)Math.Max(0, Right - Left) * Math.Max(0, Bottom - Top);

        /// <summary>The rectangle holds the other one, allowing a few pixels for borders and rounding.</summary>
        public bool Holds(int left, int top, int right, int bottom, int slack = ViewFrames.Slack) =>
            left >= Left - slack && top >= Top - slack && right <= Right + slack && bottom <= Bottom + slack;
    }

    /// <summary>
    /// Which top-level window shows a view. Revit 2022+ lets a person drag a view tab out of the main window into a window
    /// of its own; touch must follow the view there. The frame is the smallest candidate window that holds the view's
    /// rectangle (a floating view window is smaller than the main window), else the main window.
    /// </summary>
    public static class ViewFrames
    {
        public const int Slack = 4;

        public static long Pick(int left, int top, int right, int bottom, IReadOnlyList<FrameWindow> candidates, long main)
        {
            long best = main;
            long bestArea = long.MaxValue;
            foreach (FrameWindow w in candidates)
            {
                if (w.Handle == main || w.Area <= 0 || !w.Holds(left, top, right, bottom)) continue;
                if (w.Area < bestArea) { best = w.Handle; bestArea = w.Area; }
            }
            return best;
        }
    }
}
