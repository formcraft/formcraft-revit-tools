using System.Windows;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class BuildWorkspaceWindow : Window
    {
        public BuildWorkspaceWindow(BuildWorkspacePage page)
        {
            InitializeComponent();
            ThemeService.Shared.Attach(this);
            ManipulationBoundaryFeedback += (_, e) => e.Handled = true; // finger scrolling: no window bounce
            DataContext = page;
        }

        /// <summary>Moves between the main monitor and the other one, and fills it (a maximised window takes its monitor).</summary>
        private void OnSecondMonitor(object sender, RoutedEventArgs e)
        {
            double primaryW = SystemParameters.PrimaryScreenWidth, primaryH = SystemParameters.PrimaryScreenHeight;
            if (SystemParameters.VirtualScreenWidth <= primaryW + 1 && SystemParameters.VirtualScreenHeight <= primaryH + 1)
            {
                MessageBox.Show(this, "Only one monitor is connected.", Title);
                return;
            }
            WindowState = WindowState.Normal;
            bool onPrimary = Left >= 0 && Left < primaryW && Top >= 0 && Top < primaryH;
            if (onPrimary)
            {
                // The other monitor sits left, right or above/below the main one: the virtual screen says which.
                Left = SystemParameters.VirtualScreenLeft < 0 ? SystemParameters.VirtualScreenLeft + 40
                     : SystemParameters.VirtualScreenWidth > primaryW + 1 ? primaryW + 40 : 40;
                Top = SystemParameters.VirtualScreenWidth > primaryW + 1 ? 40
                    : SystemParameters.VirtualScreenTop < 0 ? SystemParameters.VirtualScreenTop + 40 : primaryH + 40;
            }
            else { Left = 40; Top = 40; }
            WindowState = WindowState.Maximized;
        }
    }
}
