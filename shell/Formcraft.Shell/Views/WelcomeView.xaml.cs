using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class WelcomeView : UserControl
    {
        public WelcomeView()
        {
            InitializeComponent();
        }

        // Enter in the path box checks the folder at once (it also checks when the box loses focus).
        private void OnKitFolderKey(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Enter) return;
            KitFolderBox.GetBindingExpression(TextBox.TextProperty)?.UpdateSource();
            e.Handled = true;
        }

        private void OnBrowse(object sender, RoutedEventArgs e)
        {
            if (!(DataContext is WelcomeViewModel vm)) return;
            var start = Directory.Exists(vm.KitFolder) ? vm.KitFolder : "";
#if NET8_0_OR_GREATER
            var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Formcraft kit folder", InitialDirectory = start };
            if (dialog.ShowDialog(Window.GetWindow(this)) == true) vm.KitFolder = dialog.FolderName;
#else
            // Revit 2020-2024 (net48) has no folder dialog in WPF: pick any file inside the kit folder.
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Formcraft kit folder: pick FMC_Kit.json in it",
                Filter = "Formcraft kit (FMC_Kit.json)|FMC_Kit.json|All files|*.*",
                InitialDirectory = start,
            };
            if (dialog.ShowDialog(Window.GetWindow(this)) == true) vm.KitFolder = Path.GetDirectoryName(dialog.FileName) ?? vm.KitFolder;
#endif
        }
    }
}
