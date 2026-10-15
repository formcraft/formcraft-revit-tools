using System;
using System.Collections.Generic;
using System.Text;
using TouchKit.Core.Gestures;
using static TouchKit.Input.NativeMethods;

namespace TouchKit.Input
{
    /// <summary>
    /// Revit's top-level windows that can show a view: the main window and any view a person dragged out into a window of
    /// its own (Revit 2022+). Formcraft's own overlay windows and dialogs are never candidates. UI thread only.
    /// </summary>
    internal static class RevitWindows
    {
        private static readonly HashSet<IntPtr> Own = new();

        /// <summary>Formcraft's overlay windows (badge, frame, ring) register here so they are never taken for a view window.</summary>
        public static void AddOwn(IntPtr hwnd) { lock (Own) Own.Add(hwnd); }
        public static void RemoveOwn(IntPtr hwnd) { lock (Own) Own.Remove(hwnd); }

        /// <summary>Visible top-level windows on this (Revit's UI) thread, leaving out dialogs and Formcraft's own windows.</summary>
        public static List<FrameWindow> Candidates()
        {
            var list = new List<FrameWindow>();
            var name = new StringBuilder(64);
            EnumThreadWindows(GetCurrentThreadId(), (hwnd, _) =>
            {
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                lock (Own) { if (Own.Contains(hwnd)) return true; }
                name.Clear();
                GetClassNameW(hwnd, name, name.Capacity);
                if (name.ToString() == "#32770") return true; // dialogs
                if (GetWindowRect(hwnd, out RECT r)) list.Add(new FrameWindow(hwnd.ToInt64(), r.Left, r.Top, r.Right, r.Bottom));
                return true;
            }, IntPtr.Zero);
            return list;
        }
    }
}
