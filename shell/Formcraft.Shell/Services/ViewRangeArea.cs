using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Formcraft.Shell.Services
{
    /// <summary>One plane of a plan's view range: a level (a level's name, or Level above, Level below, Unlimited) and an offset in mm.</summary>
    public sealed class ViewRangePlane
    {
        public ViewRangePlane(string level, double offsetMm)
        {
            Level = level;
            OffsetMm = offsetMm;
        }

        public string Level { get; }
        public double OffsetMm { get; }
    }

    /// <summary>A plan's view range as Revit's View Range dialog shows it: top, cut plane, bottom and view depth.</summary>
    public sealed class ViewRangeValues
    {
        public ViewRangeValues(ViewRangePlane top, ViewRangePlane cut, ViewRangePlane bottom, ViewRangePlane depth)
        {
            Top = top;
            Cut = cut;
            Bottom = bottom;
            Depth = depth;
        }

        public ViewRangePlane Top { get; }
        public ViewRangePlane Cut { get; }
        public ViewRangePlane Bottom { get; }
        public ViewRangePlane Depth { get; }
    }

    public sealed class ViewRangeLevel
    {
        public ViewRangeLevel(string name, double elevationMm)
        {
            Name = name;
            ElevationMm = elevationMm;
        }

        public string Name { get; }
        public double ElevationMm { get; }
    }

    /// <summary>
    /// Flow › View range (an area of a plan with its own view range): what Revit read after the person drew the area,
    /// for the dialog over the pane. Apply makes what <see cref="Result"/> says, in one transaction (one Undo).
    /// </summary>
    public sealed class ViewRangeAreaRequest
    {
        /// <summary>The plan the area was drawn on.</summary>
        public string ViewName { get; set; } = "";
        /// <summary>Floor plan, Ceiling plan or Structural plan.</summary>
        public string ViewKind { get; set; } = "Floor plan";
        /// <summary>A reflected ceiling plan looks up: Revit shows no bottom plane for it, so the dialog doesn't either.</summary>
        public bool CeilingPlan { get; set; }
        /// <summary>The plan's own level: the cut plane is always measured from it.</summary>
        public string AssociatedLevel { get; set; } = "";
        public IReadOnlyList<ViewRangeLevel> Levels { get; set; } = new ViewRangeLevel[0];
        /// <summary>The view range the dialog starts from (the view's own; the kit has no view-range presets yet).</summary>
        public ViewRangeValues Current { get; set; } = new ViewRangeValues(
            new ViewRangePlane(ViewRange.LevelAbove, 0), new ViewRangePlane("", 1200), new ViewRangePlane("", 0), new ViewRangePlane("", 0));
        /// <summary>The area in words: "6 400 × 4 200 mm, 4 corners".</summary>
        public string Area { get; set; } = "";
        /// <summary>What Apply makes, in words: a plan region, a view of its own, or a new range for this view.</summary>
        public string Result { get; set; } = "";
        /// <summary>True when Revit makes a real plan region (its API can); false for the fallback, a view of its own.</summary>
        public bool Native { get; set; }
    }

    /// <summary>The rules the dialog checks before anything is sent to Revit (Revit's own order of the planes).</summary>
    public static class ViewRange
    {
        public const string LevelAbove = "Level above";
        public const string LevelBelow = "Level below";
        public const string Unlimited = "Unlimited";
        /// <summary>The fallback view's name: FMC_VR_&lt;view&gt;_&lt;n&gt;.</summary>
        public const string ViewPrefix = "FMC_VR_";

        public static IReadOnlyList<string> TopOptions(ViewRangeAreaRequest r) => Options(r, LevelAbove, Unlimited);
        public static IReadOnlyList<string> BottomOptions(ViewRangeAreaRequest r) => Options(r, LevelBelow);
        public static IReadOnlyList<string> DepthOptions(ViewRangeAreaRequest r) => Options(r, LevelBelow, Unlimited);

        private static IReadOnlyList<string> Options(ViewRangeAreaRequest r, params string[] special) =>
            special.Concat(r.Levels.OrderByDescending(l => l.ElevationMm).Select(l => l.Name)).Distinct().ToList();

        /// <summary>A number of mm as typed: "2300", "-300", "−300", "1 200", "+300".</summary>
        public static bool TryParseMm(string? text, out double mm)
        {
            var t = (text ?? "").Replace("−", "-").Replace(" ", "").Replace(" ", "").Replace("mm", "").Trim();
            return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out mm) && !double.IsNaN(mm) && !double.IsInfinity(mm);
        }

        /// <summary>Where a plane sits, in mm above project zero (infinite for Unlimited), or null when its level isn't there.</summary>
        public static double? Elevation(ViewRangeAreaRequest r, ViewRangePlane p, bool up)
        {
            if (p.Level == Unlimited) return up ? double.PositiveInfinity : double.NegativeInfinity;
            var own = r.Levels.FirstOrDefault(l => l.Name == r.AssociatedLevel);
            ViewRangeLevel? level;
            if (p.Level == LevelAbove)
                level = own == null ? null : r.Levels.Where(l => l.ElevationMm > own.ElevationMm).OrderBy(l => l.ElevationMm).FirstOrDefault();
            else if (p.Level == LevelBelow)
                level = own == null ? null : r.Levels.Where(l => l.ElevationMm < own.ElevationMm).OrderByDescending(l => l.ElevationMm).FirstOrDefault();
            else
                level = r.Levels.FirstOrDefault(l => l.Name == p.Level);
            return level == null ? (double?)null : level.ElevationMm + p.OffsetMm;
        }

        /// <summary>Null when Revit will take the range; otherwise what to change, in words.</summary>
        public static string? Check(ViewRangeAreaRequest r, ViewRangeValues v)
        {
            double? top = Elevation(r, v.Top, up: true), cut = Elevation(r, v.Cut, up: true);
            if (top == null) return "Top: there is no " + (v.Top.Level == LevelAbove ? "level above " + r.AssociatedLevel : "level " + v.Top.Level) + ". Pick Unlimited or a level.";
            if (cut == null) return "Cut plane: the plan's level " + r.AssociatedLevel + " wasn't found.";
            if (cut > top) return "The cut plane is above the top. Lower the cut plane or raise the top.";
            if (r.CeilingPlan) return null; // Revit checks a ceiling plan's view depth itself
            double? bottom = Elevation(r, v.Bottom, up: false), depth = Elevation(r, v.Depth, up: false);
            if (bottom == null) return "Bottom: there is no " + (v.Bottom.Level == LevelBelow ? "level below " + r.AssociatedLevel : "level " + v.Bottom.Level) + ". Pick a level.";
            if (depth == null) return "View depth: there is no " + (v.Depth.Level == LevelBelow ? "level below " + r.AssociatedLevel : "level " + v.Depth.Level) + ". Pick Unlimited or a level.";
            if (bottom > cut) return "The bottom is above the cut plane. Lower the bottom or raise the cut plane.";
            if (depth > bottom) return "The view depth is above the bottom. Set the view depth at or below the bottom.";
            return null;
        }

        /// <summary>The next free fallback view name: FMC_VR_Level 1_1, FMC_VR_Level 1_2…</summary>
        public static string NextViewName(string view, IEnumerable<string> existing)
        {
            var taken = new HashSet<string>(existing, StringComparer.OrdinalIgnoreCase);
            for (int n = 1; ; n++)
            {
                var name = ViewPrefix + view + "_" + n;
                if (!taken.Contains(name)) return name;
            }
        }

        /// <summary>"6 400 × 4 200 mm" from a width and a depth in mm.</summary>
        public static string Size(double widthMm, double depthMm) => Mm(widthMm) + " × " + Mm(depthMm) + " mm";

        /// <summary>Whole mm with a space between thousands: 6 400.</summary>
        public static string Mm(double mm) =>
            Math.Round(mm).ToString("#,0", CultureInfo.InvariantCulture).Replace(",", " ");
    }
}
