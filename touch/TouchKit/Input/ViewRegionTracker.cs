using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using TouchKit.Core.Gestures;

namespace TouchKit.Input
{
    /// <summary>How we treat a view for touch purposes.</summary>
    public enum ViewKind
    {
        Model2D,   // plans, sections, elevations, drafting, legends, details
        Model3D,   // 3D views (orbit allowed)
        Sheet,     // drawing sheets
        Schedule,  // schedules and other tabular views (touch should scroll, not pan the model)
        Other,
    }

    /// <summary>
    /// Screen rectangle of one open Revit view, in physical screen pixels, and the top-level window that shows it
    /// (<see cref="Frame"/>: Revit's main window, or the window of a view dragged out of it).
    /// </summary>
    public sealed record ViewRegion(
        int Left, int Top, int Right, int Bottom,
        long ViewId, string ViewName, ViewType ViewType, ViewKind Kind, bool IsActive, bool OnScreen = true, long Frame = 0)
    {
        public bool Contains(int x, int y) => x >= Left && x < Right && y >= Top && y < Bottom;
        public override string ToString() =>
            $"{(IsActive ? "*" : " ")} {Kind,-8} {ViewType,-14} '{ViewName}'  [{Left},{Top} - {Right},{Bottom}]";
    }

    /// <summary>
    /// Keeps a cached list of where each open view sits on screen.
    /// The Revit API may only be read inside API context, so we refresh from the Idling event and the
    /// input hook reads the cached snapshot (a plain array swap, so it never blocks).
    /// </summary>
    public sealed class ViewRegionTracker
    {
        private const int RefreshIntervalMs = 250;

        private readonly Stopwatch _sinceRefresh = Stopwatch.StartNew();
        private volatile ViewRegion[] _regions = Array.Empty<ViewRegion>();
        // When each view was last the active one: in a stack of tabs, the most recent is the one showing.
        private readonly Dictionary<long, long> _lastActive = new();
        private long _activations;

        public IReadOnlyList<ViewRegion> Regions => _regions;

        /// <summary>Revit's main window, as a number (set on each refresh).</summary>
        public long MainWindow { get; private set; }
        public string? LastError { get; private set; }

        /// <summary>Call from Revit's Idling event. Cheap when not due.</summary>
        public void RefreshIfDue(UIApplication uiApp)
        {
            if (_sinceRefresh.ElapsedMilliseconds < RefreshIntervalMs) return;
            _sinceRefresh.Restart();
            Refresh(uiApp);
        }

        public void Refresh(UIApplication uiApp)
        {
            try
            {
                UIDocument? uiDoc = uiApp.ActiveUIDocument;
                if (uiDoc is null)
                {
                    _regions = Array.Empty<ViewRegion>();
                    return;
                }

                Document doc = uiDoc.Document;
                ElementId activeId = uiDoc.ActiveView?.Id ?? ElementId.InvalidElementId;
                var list = new List<ViewRegion>();
                long main = uiApp.MainWindowHandle.ToInt64();
                MainWindow = main;
                List<FrameWindow> frames = RevitWindows.Candidates();

                foreach (UIView uiView in uiDoc.GetOpenUIViews())
                {
                    Rectangle r = uiView.GetWindowRectangle();
                    if (doc.GetElement(uiView.ViewId) is not View view) continue;

                    list.Add(new ViewRegion(
                        r.Left, r.Top, r.Right, r.Bottom,
                        uiView.ViewId.Value,
                        view.Name,
                        view.ViewType,
                        Classify(view),
                        uiView.ViewId == activeId,
                        Frame: ViewFrames.Pick(r.Left, r.Top, r.Right, r.Bottom, frames, main)));
                }

                // Active view first so hit-testing prefers it when tiled views overlap at edges.
                list.Sort((a, b) => b.IsActive.CompareTo(a.IsActive));

                list = MarkOnScreen(list);
                _regions = list.ToArray();
                LastError = null;
            }
            catch (Exception ex)
            {
                // Never let a tracking failure disturb Revit; just remember it for the diagnostics log.
                LastError = ex.Message;
            }
        }

        /// <summary>
        /// Revit stacks tabbed views in (nearly) the same rectangle, and only the front one shows: the others are background
        /// tabs, never touched or drawn on. A view is on screen unless it mostly overlaps one that is in front of it: the
        /// active view, else the one activated most recently (first in the list if neither ever was).
        /// </summary>
        private List<ViewRegion> MarkOnScreen(List<ViewRegion> list)
        {
            ViewRegion? active = list.Find(r => r.IsActive);
            if (active is not null && (!_lastActive.TryGetValue(active.ViewId, out long last) || last != _activations))
                _lastActive[active.ViewId] = ++_activations;

            var stack = list.ConvertAll(r => new StackedView(r.Left, r.Top, r.Right, r.Bottom, r.IsActive,
                _lastActive.TryGetValue(r.ViewId, out long t) ? t : 0, r.Frame));
            bool[] onScreen = ViewStack.OnScreen(stack);
            return list.Select((r, i) => r with { OnScreen = onScreen[i] }).ToList();
        }

        /// <summary>Which open view (if any) contains this screen point, in the top-level window the input went to.</summary>
        public ViewRegion? HitTest(int x, int y, long window)
        {
            ViewRegion[] snapshot = _regions;
            foreach (ViewRegion region in snapshot)
            {
                if (region.OnScreen && region.Frame == window && region.Contains(x, y)) return region;
            }
            return null;
        }

        /// <summary>The window is Revit's main window or holds a view dragged out of it.</summary>
        public bool IsViewWindow(long window)
        {
            if (window == MainWindow) return true;
            foreach (ViewRegion region in _regions) if (region.Frame == window) return true;
            return false;
        }

        private static ViewKind Classify(View view)
        {
            switch (view.ViewType)
            {
                case ViewType.ThreeD:
                case ViewType.Walkthrough:
                    return ViewKind.Model3D;

                case ViewType.DrawingSheet:
                    return ViewKind.Sheet;

                case ViewType.Schedule:
                case ViewType.PanelSchedule:
                case ViewType.ColumnSchedule:
                    return ViewKind.Schedule;

                case ViewType.FloorPlan:
                case ViewType.CeilingPlan:
                case ViewType.EngineeringPlan:
                case ViewType.AreaPlan:
                case ViewType.Elevation:
                case ViewType.Section:
                case ViewType.Detail:
                case ViewType.DraftingView:
                case ViewType.Legend:
                    return ViewKind.Model2D;

                default:
                    return ViewKind.Other;
            }
        }
    }
}
