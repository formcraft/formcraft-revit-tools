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
            DataContextChanged += (_, e) =>
            {
                if (e.OldValue is ShellViewModel old) old.OpenLogRequested -= OnOpenLog;
                if (e.NewValue is ShellViewModel vm) vm.OpenLogRequested += OnOpenLog;
            };
        }

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
