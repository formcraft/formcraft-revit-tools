using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace Formcraft.Shell.Controls
{
    /// <summary>
    /// A dialog drawn over the pane (never a separate window, so it docks and themes with the pane).
    /// Header is the title, Content the body, Footer the buttons. Esc and the close button set IsOpen to false.
    /// Styled by FmcDialog in FmcTheme.xaml.
    /// </summary>
    public class FmcDialog : HeaderedContentControl
    {
        public static readonly RoutedCommand CloseCommand = new RoutedCommand(nameof(CloseCommand), typeof(FmcDialog));

        public static readonly DependencyProperty IsOpenProperty = DependencyProperty.Register(
            nameof(IsOpen), typeof(bool), typeof(FmcDialog),
            new FrameworkPropertyMetadata(false, FrameworkPropertyMetadataOptions.BindsTwoWayByDefault, OnIsOpenChanged));

        public static readonly DependencyProperty FooterProperty = DependencyProperty.Register(
            nameof(Footer), typeof(object), typeof(FmcDialog), new FrameworkPropertyMetadata(null));

        public FmcDialog()
        {
            CommandBindings.Add(new CommandBinding(CloseCommand, (_, _) => IsOpen = false));
            InputBindings.Add(new KeyBinding(CloseCommand, Key.Escape, ModifierKeys.None));
            KeyboardNavigation.SetTabNavigation(this, KeyboardNavigationMode.Cycle);
        }

        public bool IsOpen
        {
            get => (bool)GetValue(IsOpenProperty);
            set => SetValue(IsOpenProperty, value);
        }

        public object? Footer
        {
            get => GetValue(FooterProperty);
            set => SetValue(FooterProperty, value);
        }

        // Keyboard focus moves into the dialog when it opens, so Esc and Tab work at once.
        private static void OnIsOpenChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is FmcDialog dialog && (bool)e.NewValue)
                dialog.Dispatcher.BeginInvoke(new System.Action(() =>
                    dialog.MoveFocus(new TraversalRequest(FocusNavigationDirection.First))),
                    System.Windows.Threading.DispatcherPriority.Input);
        }
    }
}
