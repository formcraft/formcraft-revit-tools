using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Flow › View range: the dialog over the pane (FmcDialog, the same rows as Settings) after the person drew an area on a
    /// plan. It starts from the view's own range: the kit has no view-range presets, and the plugin never makes them up
    /// (rule 7). Apply checks the order of the planes first; Cancel and Esc leave nothing.
    /// </summary>
    public static class FlowViewRangeDialog
    {
        public const string Title = "View range for this area";

        /// <param name="apply">Gets the values once they pass the check; returns null when Revit has them, or a problem to show.</param>
        public static DialogViewModel Create(ViewRangeAreaRequest r, Func<ViewRangeValues, string?> apply)
        {
            var store = new SettingStore(new InMemoryUserSettings(), "");
            var c = r.Current;
            ChoiceSetting Level(string key, string label, IReadOnlyList<string> options, string current)
            {
                var list = options.Contains(current) || current.Length == 0 ? options : options.Concat(new[] { current }).ToList();
                if (current.Length > 0) store.Set(key, current);
                return new ChoiceSetting(store, key, label, list, dropdown: true);
            }
            TextSetting Offset(string label, double mm) =>
                new TextSetting(label, ViewRange.Mm(mm).Replace(" ", ""), "0", mono: true);

            var top = Level("top", "Top", ViewRange.TopOptions(r), c.Top.Level);
            var topOffset = Offset("Top offset (mm)", c.Top.OffsetMm);
            var cutOffset = Offset("Cut plane offset (mm) from " + r.AssociatedLevel, c.Cut.OffsetMm);
            var bottom = Level("bottom", "Bottom", ViewRange.BottomOptions(r), c.Bottom.Level);
            var bottomOffset = Offset("Bottom offset (mm)", c.Bottom.OffsetMm);
            var depth = Level("depth", "View depth", ViewRange.DepthOptions(r), c.Depth.Level);
            var depthOffset = Offset("View depth offset (mm)", c.Depth.OffsetMm);

            var items = new List<SettingItem>
            {
                new ReadOnlySetting("Area", r.ViewKind + " " + r.ViewName + " · " + r.Area),
                new NoteSetting(r.Result, r.Native ? ChipKind.Info : ChipKind.Warn),
                new ReadOnlySetting("Starts from", "This view's range",
                    "The kit has no view-range presets yet. Presets such as a higher cut for high windows come from the kit (a kit change request)."),
                top, topOffset, cutOffset,
            };
            if (!r.CeilingPlan) items.AddRange(new SettingItem[] { bottom, bottomOffset });
            items.AddRange(new SettingItem[] { depth, depthOffset });

            return DialogViewModel.WithItems(Title, "Nothing changes until you apply. One Undo takes it back; model geometry is never touched.",
                items, "Apply", () =>
                {
                    double t = 0, cut = 0, b = c.Bottom.OffsetMm, d = 0;
                    var problem = Number(topOffset, ref t) ?? Number(cutOffset, ref cut)
                                  ?? (r.CeilingPlan ? null : Number(bottomOffset, ref b)) ?? Number(depthOffset, ref d);
                    if (problem != null) return Task.FromResult<string?>(problem);
                    var values = new ViewRangeValues(
                        new ViewRangePlane(top.Selected, t),
                        new ViewRangePlane(r.AssociatedLevel, cut),
                        r.CeilingPlan ? c.Bottom : new ViewRangePlane(bottom.Selected, b),
                        new ViewRangePlane(depth.Selected, d));
                    return Task.FromResult(ViewRange.Check(r, values) ?? apply(values));
                });
        }

        private static string? Number(TextSetting box, ref double mm) =>
            ViewRange.TryParseMm(box.Value, out mm) ? null : box.Label + ": type a number of mm, like 1200 or -300.";
    }
}
