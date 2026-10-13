using System.Windows;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Preview
{
    public partial class MainWindow : Window
    {
        public MainWindow()
        {
            InitializeComponent();
            // Mock sign-in: any email and password, then code 123456.
            Shell.DataContext = new ShellViewModel(new MockLicenceService());
        }
    }
}
