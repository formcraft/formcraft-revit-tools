using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class SignInView : UserControl
    {
        public SignInView()
        {
            InitializeComponent();
        }

        // PasswordBox can't bind; pass the value to the view model without storing it elsewhere.
        private void OnPasswordChanged(object sender, RoutedEventArgs e)
        {
            if (DataContext is SignInViewModel vm && sender is PasswordBox box)
                vm.Password = box.Password;
        }

        private void OnLicenceDragOver(object sender, DragEventArgs e)
        {
            e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
            e.Handled = true;
        }

        private async void OnLicenceDrop(object sender, DragEventArgs e)
        {
            if (DataContext is SignInViewModel vm && e.Data.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0)
                await vm.UseOfflineLicenceAsync(files.First());
        }

        private async void OnChooseLicence(object sender, RoutedEventArgs e)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Offline licence file",
                Filter = "Formcraft licence (FMC_Licence_*.lic)|*.lic|All files|*.*",
                CheckFileExists = true,
            };
            if (dialog.ShowDialog(Window.GetWindow(this)) == true && DataContext is SignInViewModel vm && File.Exists(dialog.FileName))
                await vm.UseOfflineLicenceAsync(dialog.FileName);
        }
    }
}
