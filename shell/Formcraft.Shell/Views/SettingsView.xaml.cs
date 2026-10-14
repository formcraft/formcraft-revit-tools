using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Views
{
    public partial class SettingsView : UserControl
    {
        public SettingsView()
        {
            InitializeComponent();
            DataContextChanged += (_, e) =>
            {
                if (e.OldValue is SettingsViewModel old) old.PropertyChanged -= OnChanged;
                if (e.NewValue is SettingsViewModel vm) vm.PropertyChanged += OnChanged;
            };
        }

        /// <summary>
        /// Settings opened on one group (search, the kit banner: F-012): once the tab has laid out, scroll the group to the
        /// top and put the cursor in its first field, so nobody hunts for it.
        /// </summary>
        private void OnChanged(object? sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName != nameof(SettingsViewModel.FocusGroup) || !(sender is SettingsViewModel vm) || string.IsNullOrEmpty(vm.FocusGroup)) return;
            string focus = vm.FocusGroup!;
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new System.Action(() =>
            {
                var group = Find(this, d => d is FrameworkElement f && f.DataContext is SettingsGroup g && g.Title == focus) as FrameworkElement;
                if (group == null) return;
                var scroller = Find(this, d => d is ScrollViewer) as ScrollViewer;
                if (scroller != null && group.IsDescendantOf(scroller))
                {
                    var top = group.TransformToAncestor(scroller).Transform(new Point(0, 0)).Y;
                    scroller.ScrollToVerticalOffset(scroller.VerticalOffset + top - 8);
                }
                else group.BringIntoView();
                (Find(group, d => d is TextBox t && t.IsEnabled && t.IsVisible) as TextBox)?.Focus();
            }));
        }

        /// <summary>The first element in the visual tree under <paramref name="root"/> that matches.</summary>
        private static DependencyObject? Find(DependencyObject root, System.Func<DependencyObject, bool> match)
        {
            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
            {
                var child = VisualTreeHelper.GetChild(root, i);
                if (match(child)) return child;
                var deeper = Find(child, match);
                if (deeper != null) return deeper;
            }
            return null;
        }
    }
}
