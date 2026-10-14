using System;
using System.Collections.Generic;
using System.Diagnostics;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

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

    /// <summary>Screen rectangle of one open Revit view, in physical screen pixels.</summary>
    public sealed record ViewRegion(
        int Left, int Top, int Right, int Bottom,
        long ViewId, string ViewName, ViewType ViewType, ViewKind Kind, bool IsActive, bool OnScreen = true)
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

        public IReadOnlyList<ViewRegion> Regions => _regions;
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
                        uiView.ViewId == activeId));
                }

                // Active view first so hit-testing prefers it when tiled views overlap at edges.
                list.Sort((a, b) => b.IsActive.CompareTo(a.IsActive));

                // Revit stacks tabbed views in the active view's rectangle: those are background tabs, never touched
                // or drawn on. A view somewhere else (tiled windows) is on screen.
                ViewRegion? active = list.Find(r => r.IsActive);
                if (active is not null)
                    list = list.ConvertAll(r => r.IsActive ? r : r with
                    {
                        OnScreen = r.Left != active.Left || r.Top != active.Top || r.Right != active.Right || r.Bottom != active.Bottom,
                    });
                _regions = list.ToArray();
                LastError = null;
            }
            catch (Exception ex)
            {
                // Never let a tracking failure disturb Revit; just remember it for the diagnostics log.
                LastError = ex.Message;
            }
        }

        /// <summary>Which open view (if any) contains this screen point.</summary>
        public ViewRegion? HitTest(int x, int y)
        {
            ViewRegion[] snapshot = _regions;
            foreach (ViewRegion region in snapshot)
            {
                if (region.OnScreen && region.Contains(x, y)) return region;
            }
            return null;
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
