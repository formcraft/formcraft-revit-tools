using System.Diagnostics;
using System.Windows;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class LogWindow : Window
    {
        public LogWindow(ILogReader reader)
        {
            InitializeComponent();
            ThemeService.Shared.Attach(this);
            ManipulationBoundaryFeedback += (_, e) => e.Handled = true; // finger scrolling: no window bounce
            DataContext = new LogViewModel(reader,
                path => Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }),
                text => Clipboard.SetText(text));
        }
    }
}
