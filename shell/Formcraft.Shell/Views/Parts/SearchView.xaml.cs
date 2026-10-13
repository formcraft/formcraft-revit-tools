using System.Windows.Controls;

namespace Formcraft.Shell.Views.Parts
{
    public partial class SearchView : UserControl
    {
        public SearchView()
        {
            InitializeComponent();
            // Arrow keys move the selection from the search box; keep it in sight.
            List.SelectionChanged += (_, _) =>
            {
                if (List.SelectedItem != null) List.ScrollIntoView(List.SelectedItem);
            };
        }
    }
}
