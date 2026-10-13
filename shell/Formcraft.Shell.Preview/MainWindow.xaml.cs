using System.Windows;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Preview
{
    public partial class MainWindow : Window
    {
        private KitGalleryWindow? _gallery;

        public MainWindow() : this(new PreviewServices())
        {
        }

        public MainWindow(PreviewServices services)
        {
            InitializeComponent();
            ThemeService.Shared.Attach(this);
            Themes.DataContext = new PreviewTheme(ThemeService.Shared);
            // Mock sign-in: any email and password, then code 123456.
            Services = services;
            Documents.DataContext = Services;
            Shell.DataContext = Services.Pane;
        }

        public PreviewServices Services { get; }

        private void OnOpenGallery(object sender, RoutedEventArgs e)
        {
            if (_gallery == null)
            {
                _gallery = new KitGalleryWindow { Owner = this };
                _gallery.Closed += (_, _) => _gallery = null;
            }
            _gallery.Show();
            _gallery.Activate();
        }
    }
}
