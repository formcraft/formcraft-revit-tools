using System.Windows.Controls.Primitives;

namespace Formcraft.Shell.Controls
{
    /// <summary>
    /// A button that shows a state it doesn't own: IsChecked comes only from its binding (the open group, section
    /// or header page), and a click only runs Command. A plain ToggleButton or RadioButton would flip itself and
    /// break the binding.
    /// </summary>
    public class FmcStateButton : ToggleButton
    {
        protected override void OnToggle()
        {
        }
    }
}
