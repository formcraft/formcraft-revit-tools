using System.Windows;
using System.Windows.Controls;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Controls
{
    /// <summary>
    /// The document banner under the section buttons. Header is the model name, Content the lock line.
    /// Styled by FmcDocBanner in FmcTheme.xaml.
    /// </summary>
    public class FmcDocBanner : HeaderedContentControl
    {
        public static readonly DependencyProperty StateProperty = DependencyProperty.Register(
            nameof(State), typeof(DocState), typeof(FmcDocBanner), new FrameworkPropertyMetadata(DocState.Setup));

        public DocState State
        {
            get => (DocState)GetValue(StateProperty);
            set => SetValue(StateProperty, value);
        }

        /// <summary>One line only (the model name): set while a state banner shows, so the page keeps its room (F-005).</summary>
        public static readonly DependencyProperty CompactProperty = DependencyProperty.Register(
            nameof(Compact), typeof(bool), typeof(FmcDocBanner), new FrameworkPropertyMetadata(false));

        public bool Compact
        {
            get => (bool)GetValue(CompactProperty);
            set => SetValue(CompactProperty, value);
        }
    }
}
