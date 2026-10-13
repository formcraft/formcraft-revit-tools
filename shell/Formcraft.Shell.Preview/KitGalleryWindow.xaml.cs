using System.Windows;
using System.Windows.Controls;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Preview
{
    /// <summary>
    /// Every UI kit style in every state, light and dark, at 440 or 360 px. Compare it with the
    /// "Build-ready UI kit" board (design/boards/core/UI_Kit.dc.html).
    /// </summary>
    public partial class KitGalleryWindow : Window
    {
        public KitGalleryWindow()
        {
            InitializeComponent();
            ThemeService.Shared.Attach(this);
            DataContext = new KitGalleryViewModel(ThemeService.Shared);
        }
    }

    /// <summary>Paints a swatch with a theme colour by name, so it follows the theme like everything else.</summary>
    public static class Swatch
    {
        public static readonly DependencyProperty TokenProperty = DependencyProperty.RegisterAttached(
            "Token", typeof(string), typeof(Swatch), new PropertyMetadata("", OnTokenChanged));

        public static string GetToken(DependencyObject d) => (string)d.GetValue(TokenProperty);
        public static void SetToken(DependencyObject d, string value) => d.SetValue(TokenProperty, value);

        private static void OnTokenChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is Border border && e.NewValue is string token && token.Length > 0)
                border.SetResourceReference(Border.BackgroundProperty, $"Fmc.{token}Brush");
        }
    }
}
