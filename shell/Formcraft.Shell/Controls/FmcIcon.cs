using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Formcraft.Shell.Controls
{
    /// <summary>
    /// A line icon from Theme/FmcIcons.xaml, drawn in the current Foreground on the 24 px grid and scaled to Size.
    /// Icons are never the only label: give the button text or AutomationProperties.Name.
    /// </summary>
    public class FmcIcon : Control
    {
        public static readonly DependencyProperty DataProperty = DependencyProperty.Register(
            nameof(Data), typeof(Geometry), typeof(FmcIcon), new FrameworkPropertyMetadata(null));

        /// <summary>Key in Theme/FmcIcons.xaml ("Icon.QA"); follows the resource like DynamicResource would.</summary>
        public static readonly DependencyProperty IconKeyProperty = DependencyProperty.Register(
            nameof(IconKey), typeof(string), typeof(FmcIcon), new FrameworkPropertyMetadata("", OnIconKeyChanged));

        public static readonly DependencyProperty SizeProperty = DependencyProperty.Register(
            nameof(Size), typeof(double), typeof(FmcIcon), new FrameworkPropertyMetadata(14.0));

        static FmcIcon()
        {
            FocusableProperty.OverrideMetadata(typeof(FmcIcon), new FrameworkPropertyMetadata(false));
            IsTabStopProperty.OverrideMetadata(typeof(FmcIcon), new FrameworkPropertyMetadata(false));
        }

        public Geometry? Data
        {
            get => (Geometry?)GetValue(DataProperty);
            set => SetValue(DataProperty, value);
        }

        public string IconKey
        {
            get => (string)GetValue(IconKeyProperty);
            set => SetValue(IconKeyProperty, value);
        }

        public double Size
        {
            get => (double)GetValue(SizeProperty);
            set => SetValue(SizeProperty, value);
        }

        private static void OnIconKeyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is FmcIcon icon && e.NewValue is string key && key.Length > 0)
                icon.SetResourceReference(DataProperty, key);
        }
    }
}
