using System.Windows;
using System.Windows.Controls;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Controls
{
    /// <summary>
    /// A check line: tick box, label and a status chip on the right ("FMC Kit v2.2 found … OK").
    /// Styled by FmcCheckRow in FmcTheme.xaml.
    /// </summary>
    public class FmcCheckRow : CheckBox
    {
        public static readonly DependencyProperty StatusProperty = DependencyProperty.Register(
            nameof(Status), typeof(string), typeof(FmcCheckRow), new FrameworkPropertyMetadata(""));

        public static readonly DependencyProperty StatusKindProperty = DependencyProperty.Register(
            nameof(StatusKind), typeof(ChipKind), typeof(FmcCheckRow), new FrameworkPropertyMetadata(ChipKind.Good));

        /// <summary>Chip text; empty hides the chip.</summary>
        public string Status
        {
            get => (string)GetValue(StatusProperty);
            set => SetValue(StatusProperty, value);
        }

        public ChipKind StatusKind
        {
            get => (ChipKind)GetValue(StatusKindProperty);
            set => SetValue(StatusKindProperty, value);
        }
    }
}
