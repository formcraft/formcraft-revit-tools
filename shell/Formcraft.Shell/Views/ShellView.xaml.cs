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
        }

        // PasswordBox can't bind; pass the value to the view model without storing it elsewhere.
        private void OnPasswordChanged(object sender, RoutedEventArgs e)
        {
            if (DataContext is ShellViewModel vm && sender is PasswordBox box)
                vm.SignIn.Password = box.Password;
        }

        // Ctrl+K: find a feature (board core/UI_Palette; the search itself is U04).
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
