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
    }
}
