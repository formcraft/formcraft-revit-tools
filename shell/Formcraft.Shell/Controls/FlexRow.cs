using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;

namespace Formcraft.Shell.Controls
{
    /// <summary>
    /// One row where every child shares the width equally but never gets less than it needs, like the boards'
    /// "flex: 1" tabs and section buttons. When the row is too narrow for everyone, each child is shrunk in
    /// proportion and trims its own text.
    /// </summary>
    public class FlexRow : Panel
    {
        public static readonly DependencyProperty GapProperty = DependencyProperty.Register(
            nameof(Gap), typeof(double), typeof(FlexRow),
            new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsMeasure));

        public double Gap
        {
            get => (double)GetValue(GapProperty);
            set => SetValue(GapProperty, value);
        }

        protected override Size MeasureOverride(Size available)
        {
            var visible = InternalChildren.Cast<UIElement>().Where(c => c.Visibility != Visibility.Collapsed).ToList();
            var height = 0.0;
            var natural = 0.0;
            foreach (var child in visible)
            {
                child.Measure(new Size(double.PositiveInfinity, available.Height));
                natural += child.DesiredSize.Width;
                height = Math.Max(height, child.DesiredSize.Height);
            }
            var gaps = Gap * Math.Max(0, visible.Count - 1);
            var width = double.IsInfinity(available.Width) ? natural + gaps : available.Width;
            var widths = Widths(visible.Select(c => c.DesiredSize.Width).ToArray(), width - gaps);
            for (var i = 0; i < visible.Count; i++)
                visible[i].Measure(new Size(widths[i], available.Height));
            return new Size(width, height);
        }

        protected override Size ArrangeOverride(Size final)
        {
            var visible = InternalChildren.Cast<UIElement>().Where(c => c.Visibility != Visibility.Collapsed).ToList();
            var gaps = Gap * Math.Max(0, visible.Count - 1);
            var widths = Widths(visible.Select(c => c.DesiredSize.Width).ToArray(), final.Width - gaps);
            var x = 0.0;
            for (var i = 0; i < visible.Count; i++)
            {
                visible[i].Arrange(new Rect(x, 0, widths[i], final.Height));
                x += widths[i] + Gap;
            }
            return final;
        }

        /// <summary>Equal shares, raised to each child's need; shrunk in proportion when the needs don't fit.</summary>
        public static double[] Widths(double[] needs, double space)
        {
            var n = needs.Length;
            var result = new double[n];
            if (n == 0) return result;
            space = Math.Max(0, space);

            var total = needs.Sum();
            if (total >= space)
            {
                for (var i = 0; i < n; i++) result[i] = total <= 0 ? space / n : needs[i] * space / total;
                return result;
            }

            // Children that need more than an equal share keep their need; the rest share what is left.
            var fixedSet = new bool[n];
            while (true)
            {
                var free = Enumerable.Range(0, n).Where(i => !fixedSet[i]).ToList();
                var left = space - Enumerable.Range(0, n).Where(i => fixedSet[i]).Sum(i => needs[i]);
                var share = left / free.Count;
                var grew = free.Where(i => needs[i] > share).ToList();
                if (grew.Count == 0)
                {
                    for (var i = 0; i < n; i++) result[i] = fixedSet[i] ? needs[i] : share;
                    return result;
                }
                foreach (var i in grew) fixedSet[i] = true;
            }
        }
    }
}
