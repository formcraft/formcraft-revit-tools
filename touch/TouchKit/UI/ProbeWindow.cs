using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using TouchKit.Diagnostics;
using TouchKit.Input;

namespace TouchKit.UI
{
    /// <summary>
    /// Diagnostics window: shows what touch/pen messages Revit receives, where they land, and lets you
    /// test blocking them. Built in code (no XAML) to keep the probe self-contained.
    /// </summary>
    public sealed class ProbeWindow : Window
    {
        private static ProbeWindow? _instance;

        public static readonly string[] TestScript =
        {
            "A  1-finger TAP on a floor plan",
            "B  1-finger DRAG on a floor plan",
            "C  2-finger PINCH on a floor plan",
            "D  2-finger DRAG on a floor plan",
            "E  LONG PRESS (hold 1s) on a floor plan",
            "F  1-finger DRAG in a 3D view",
            "G  2-finger PINCH in a 3D view",
            "H  Touch the ribbon / Project Browser",
            "I  BLOCKING ON: repeat A-C on the floor plan",
            "J  BLOCKING ON: touch the ribbon (should still work)",
            "K  PEN tap + drag on a floor plan (if you have a pen)",
            "L  Free play / anything odd you noticed",
        };

        private readonly PointerHook _hook;
        private readonly ProbeLog _log;
        private readonly ViewRegionTracker _views;
        private readonly Func<string> _environment;

        private readonly TextBlock _status = new() { Margin = new Thickness(0, 0, 0, 6), TextWrapping = TextWrapping.Wrap };
        private readonly TextBox _summary = MonoBox();
        private readonly TextBox _lines = MonoBox();
        private readonly ComboBox _tests = new() { MinWidth = 330, Margin = new Thickness(0, 0, 6, 0) };
        private readonly DispatcherTimer _timer;
        private long _shownRevision = -1;
        private int _nextTest;

        public static void ShowSingleton(IntPtr revitWindow, PointerHook hook, ProbeLog log, ViewRegionTracker views, Func<string> environment)
        {
            if (_instance is { IsLoaded: true })
            {
                _instance.Activate();
                return;
            }

            _instance = new ProbeWindow(hook, log, views, environment);
            new WindowInteropHelper(_instance).Owner = revitWindow;
            _instance.Show();
        }

        private ProbeWindow(PointerHook hook, ProbeLog log, ViewRegionTracker views, Func<string> environment)
        {
            _hook = hook;
            _log = log;
            _views = views;
            _environment = environment;

            Title = "Formcraft Flow · touch probe";
            Width = 1100;
            Height = 720;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            ShowInTaskbar = false;

            Content = BuildLayout();

            _timer = new DispatcherTimer(TimeSpan.FromMilliseconds(150), DispatcherPriority.Background, (_, _) => Refresh(), Dispatcher);
            _timer.Start();

            Closed += (_, _) =>
            {
                _timer.Stop();
                // Never leave input blocked once the diagnostics window is gone.
                _hook.BlockTouchInViews = false;
                _hook.BlockPenInViews = false;
                _instance = null;
            };

            Refresh();
        }

        private UIElement BuildLayout()
        {
            var root = new DockPanel { Margin = new Thickness(10) };

            // --- Top: status + options -------------------------------------------------------------
            var top = new StackPanel();
            top.Children.Add(_status);

            var options = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
            options.Children.Add(Check("Block TOUCH on Revit views", v => _hook.BlockTouchInViews = v, _hook.BlockTouchInViews));
            options.Children.Add(Check("Block PEN on Revit views", v => _hook.BlockPenInViews = v, _hook.BlockPenInViews));
            options.Children.Add(Check("Log move events", v => _log.LogMoves = v, _log.LogMoves));
            options.Children.Add(Check("Pause", v => _log.Paused = v, _log.Paused));
            top.Children.Add(options);

            var testRow = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
            testRow.Children.Add(new TextBlock { Text = "Test: ", VerticalAlignment = VerticalAlignment.Center });
            foreach (string t in TestScript) _tests.Items.Add(t);
            _tests.SelectedIndex = 0;
            testRow.Children.Add(_tests);
            testRow.Children.Add(MakeButton("Start test", StartTest));
            testRow.Children.Add(MakeButton("Clear", () => { _log.Clear(); _nextTest = 0; _tests.SelectedIndex = 0; }));
            testRow.Children.Add(MakeButton("Copy report", CopyReport));
            testRow.Children.Add(MakeButton("Save report...", SaveReport));
            top.Children.Add(testRow);

            DockPanel.SetDock(top, Dock.Top);
            root.Children.Add(top);

            // --- Body: summary over live log -------------------------------------------------------
            var body = new Grid();
            body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(2, GridUnitType.Star) });

            var summaryBox = Labeled("Summary  (count, device, message -> receiving window class, where it landed)", _summary);
            Grid.SetRow(summaryBox, 0);
            body.Children.Add(summaryBox);

            var splitter = new GridSplitter { Height = 6, HorizontalAlignment = HorizontalAlignment.Stretch, Background = Brushes.Transparent };
            Grid.SetRow(splitter, 1);
            body.Children.Add(splitter);

            var logBox = Labeled("Live log  (newest at bottom)", _lines);
            Grid.SetRow(logBox, 2);
            body.Children.Add(logBox);

            root.Children.Add(body);
            return root;
        }

        private void StartTest()
        {
            if (_tests.SelectedItem is not string label) return;
            _log.AddMarker("TEST " + label);
            _nextTest = Math.Min(_tests.SelectedIndex + 1, TestScript.Length - 1);
            _tests.SelectedIndex = _nextTest;
        }

        private void Refresh()
        {
            _status.Text =
                $"Hook: {(_hook.IsInstalled ? $"active on Revit UI thread {_hook.ThreadId}" : $"NOT installed (Win32 error {_hook.LastInstallError})")}    " +
                $"Open views tracked: {_views.Regions.Count}" +
                (_views.LastError is null ? "" : $"    View tracking error: {_views.LastError}") +
                (_hook.BlockTouchInViews || _hook.BlockPenInViews ? "    BLOCKING IS ON - use the mouse to navigate views" : "");

            if (_log.Revision == _shownRevision) return;
            _shownRevision = _log.Revision;

            _summary.Text = _log.Summary();
            _lines.Text = string.Join(Environment.NewLine, _log.RecentLines(400));
            _lines.ScrollToEnd();
        }

        private string Report() => _log.BuildReport(_environment(), _views.Regions);

        private void CopyReport()
        {
            try
            {
                Clipboard.SetText(Report());
                _log.AddMarker("report copied to clipboard");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "Formcraft Flow", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private void SaveReport()
        {
            var dialog = new Microsoft.Win32.SaveFileDialog
            {
                FileName = $"Flow_touch_probe_{DateTime.Now:yyyyMMdd_HHmmss}.txt",
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
                Filter = "Text file (*.txt)|*.txt",
            };
            if (dialog.ShowDialog(this) != true) return;

            try
            {
                File.WriteAllText(dialog.FileName, Report());
                _log.AddMarker("report saved: " + dialog.FileName);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "Formcraft Flow", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        // ---- small UI helpers ---------------------------------------------------------------------

        private static TextBox MonoBox() => new()
        {
            IsReadOnly = true,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 12,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            TextWrapping = TextWrapping.NoWrap,
        };

        private static CheckBox Check(string text, Action<bool> onChange, bool initial)
        {
            var box = new CheckBox { Content = text, IsChecked = initial, Margin = new Thickness(0, 0, 18, 0), VerticalAlignment = VerticalAlignment.Center };
            box.Checked += (_, _) => onChange(true);
            box.Unchecked += (_, _) => onChange(false);
            return box;
        }

        private static Button MakeButton(string text, Action onClick)
        {
            var button = new Button { Content = text, Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(0, 0, 6, 0), MinHeight = 32 };
            button.Click += (_, _) => onClick();
            return button;
        }

        private static UIElement Labeled(string label, UIElement content)
        {
            var panel = new DockPanel();
            var header = new TextBlock { Text = label, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 3) };
            DockPanel.SetDock(header, Dock.Top);
            panel.Children.Add(header);
            panel.Children.Add(content);
            return panel;
        }
    }
}
