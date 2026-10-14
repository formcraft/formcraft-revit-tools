using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Formcraft.Shell.Controls;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class ShellView : UserControl
    {
        public ShellView()
        {
            InitializeComponent();
            ThemeService.Shared.Attach(this);
            // Compact below 400 px; everything inside reads the inherited c:Fmc.Compact.
            Pane.SizeChanged += (_, e) => Fmc.SetCompact(this, Fmc.IsCompact(e.NewSize.Width));
            PreviewKeyDown += OnPreviewKeyDown;
            // Finger panning reaches the end of a list: don't bounce Revit's window (WPF's default boundary feedback).
            ManipulationBoundaryFeedback += (_, e) => e.Handled = true;
            PreviewMouseWheel += OnWheel;
            DataContextChanged += (_, e) =>
            {
                if (e.OldValue is ShellViewModel old) old.OpenLogRequested -= OnOpenLog;
                if (e.NewValue is ShellViewModel vm) vm.OpenLogRequested += OnOpenLog;
            };
        }

        /// <summary>Pixels per wheel notch: about three lines of text, as Windows scrolls elsewhere.</summary>
        private const double WheelStep = 64;

        /// <summary>
        /// Inside Revit's dockable pane the wheel moved the page a few pixels per notch, and tables swallowed it (F-005).
        /// Scroll the nearest list or page that can still move that way, a normal step per notch; at a list's end the
        /// page under it scrolls. Only this pane: Revit's own panels keep their behaviour.
        /// </summary>
        private void OnWheel(object sender, MouseWheelEventArgs e)
        {
            if (e.Handled || !(e.OriginalSource is DependencyObject d)) return;
            bool up = e.Delta > 0;
            for (var v = d; v != null; v = Parent(v))
            {
                if (v is ComboBox || v is TextBox tb && tb.AcceptsReturn) return; // their own wheel meaning
                if (!(v is ScrollViewer sv) || sv.ScrollableHeight <= 0) continue;
                if (up ? sv.VerticalOffset <= 0 : sv.VerticalOffset >= sv.ScrollableHeight) continue;
                double notches = Math.Abs(e.Delta) / 120.0;
                if (sv.CanContentScroll)
                    for (int i = 0; i < Math.Max(1, (int)Math.Round(3 * notches)); i++) { if (up) sv.LineUp(); else sv.LineDown(); }
                else
                    sv.ScrollToVerticalOffset(sv.VerticalOffset + (up ? -1 : 1) * WheelStep * Math.Max(1, notches));
                e.Handled = true;
                return;
            }
        }

        private static DependencyObject? Parent(DependencyObject d) =>
            d is System.Windows.Media.Visual || d is System.Windows.Media.Media3D.Visual3D
                ? System.Windows.Media.VisualTreeHelper.GetParent(d) ?? LogicalTreeHelper.GetParent(d)
                : LogicalTreeHelper.GetParent(d);

        // Log file window (board core/UI_Log): a window of its own, one at a time.
        private LogWindow? _log;

        private void OnOpenLog(object? sender, EventArgs e)
        {
            if (!(DataContext is ShellViewModel vm)) return;
            if (_log == null)
            {
                _log = new LogWindow(new CsvLogReader(vm.LogPath)) { Owner = Window.GetWindow(this) };
                _log.Closed += (_, _) => _log = null;
            }
            _log.Show();
            _log.Activate();
        }

        // In the search box: arrows move through the results, Enter opens, Esc clears and puts the section back.
        private void OnSearchKeyDown(object sender, KeyEventArgs e)
        {
            if (!(DataContext is ShellViewModel vm) || !vm.Search.IsOpen) return;
            switch (e.Key)
            {
                case Key.Down: vm.Search.MoveNext(); break;
                case Key.Up: vm.Search.MovePrevious(); break;
                case Key.Enter: vm.Search.OpenSelected(); break;
                case Key.Escape: vm.Search.Close(); break;
                default: return;
            }
            e.Handled = true;
        }

        // Ctrl+K: find a feature (board core/UI_Palette).
        private void OnPreviewKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.K && Keyboard.Modifiers == ModifierKeys.Control && Search.IsVisible)
            {
                Search.Focus();
                e.Handled = true;
            }
        }
    }
}
