using System.Windows;
using System.Windows.Controls;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class ShellView : UserControl
    {
        public ShellView()
        {
            InitializeComponent();
        }

        // PasswordBox can't bind; pass the value to the view model without storing it elsewhere.
        private void OnPasswordChanged(object sender, RoutedEventArgs e)
        {
            if (DataContext is ShellViewModel vm && sender is PasswordBox box)
                vm.SignIn.Password = box.Password;
        }
    }
}
