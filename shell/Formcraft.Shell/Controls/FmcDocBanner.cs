using System.Windows;
using System.Windows.Controls;

namespace Formcraft.Shell.Controls
{
    /// <summary>What the live-model lock allows on the open document (CLAUDE.md rule 1).</summary>
    public enum DocState
    {
        /// <summary>Family, new unsaved model or a staging file: setup tools open.</summary>
        Setup,
        /// <summary>Workshared model with "Claude in shared models" on.</summary>
        Shared,
        /// <summary>Live project: Claude reads and reports.</summary>
        Live,
    }

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
