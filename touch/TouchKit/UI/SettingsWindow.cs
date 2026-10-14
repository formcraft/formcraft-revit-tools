using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using TouchKit.Core.Settings;

namespace TouchKit.UI
{
    /// <summary>
    /// Settings window generated from [Setting] attributes. Changes apply live and are saved immediately,
    /// so there is no OK/Cancel: what you see is what's in effect.
    /// </summary>
    public sealed class SettingsWindow : Window
    {
        private static SettingsWindow? _instance;

        private readonly Func<TouchSettings> _get;
        private readonly Action<TouchSettings> _replace;
        private readonly Action _changed;
        private readonly IReadOnlyList<SettingInfo> _schema = SettingsSchema.Describe(typeof(TouchSettings));
        private readonly StackPanel _rows = new();
        private readonly CheckBox _showAdvanced = new() { Content = "Show advanced settings", Margin = new Thickness(0, 0, 0, 8) };

        /// <param name="get">Returns the live settings object.</param>
        /// <param name="replace">Swap in a whole new settings object (reset / import).</param>
        /// <param name="changed">Called after any change: apply and save.</param>
        public static void ShowSingleton(IntPtr owner, Func<TouchSettings> get, Action<TouchSettings> replace, Action changed)
        {
            if (_instance is { IsLoaded: true }) { _instance.Activate(); return; }
            _instance = new SettingsWindow(get, replace, changed);
            new WindowInteropHelper(_instance).Owner = owner;
            _instance.Show();
        }

        private SettingsWindow(Func<TouchSettings> get, Action<TouchSettings> replace, Action changed)
        {
            _get = get;
            _replace = replace;
            _changed = changed;

            Title = "Formcraft Flow · touch settings";
            Width = 640;
            Height = 760;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            ShowInTaskbar = false;
            FontSize = 14; // a little larger than default: this window gets used with fingers too

            _showAdvanced.Checked += (_, _) => Rebuild();
            _showAdvanced.Unchecked += (_, _) => Rebuild();

            var footer = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
            footer.Children.Add(MakeButton("Reset all to factory", ResetAll));
            footer.Children.Add(MakeButton("Export...", Export));
            footer.Children.Add(MakeButton("Import...", Import));
            footer.Children.Add(MakeButton("Close", Close));

            var root = new DockPanel { Margin = new Thickness(14) };
            DockPanel.SetDock(_showAdvanced, Dock.Top);
            DockPanel.SetDock(footer, Dock.Bottom);
            root.Children.Add(_showAdvanced);
            root.Children.Add(footer);
            root.Children.Add(new ScrollViewer { Content = _rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, PanningMode = PanningMode.VerticalOnly });
            Content = root;

            Closed += (_, _) => _instance = null;
            Rebuild();
        }

        private void Rebuild()
        {
            _rows.Children.Clear();
            TouchSettings settings = _get();
            var factory = new TouchSettings();
            bool advanced = _showAdvanced.IsChecked == true;

            foreach (var group in _schema.Where(s => advanced || !s.Meta.Advanced).GroupBy(s => s.Meta.Group))
            {
                _rows.Children.Add(new TextBlock
                {
                    Text = group.Key,
                    FontSize = 17,
                    FontWeight = FontWeights.SemiBold,
                    Margin = new Thickness(0, 14, 0, 6),
                });

                foreach (SettingInfo info in group) _rows.Children.Add(BuildRow(info, settings, factory));
            }
        }

        private UIElement BuildRow(SettingInfo info, TouchSettings settings, TouchSettings factory)
        {
            var grid = new Grid { Margin = new Thickness(0, 3, 0, 3), MinHeight = 34 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(230) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var label = new TextBlock { Text = info.Meta.Label, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 10, 0) };
            if (!string.IsNullOrEmpty(info.Meta.Description)) label.ToolTip = info.Meta.Description;
            grid.Children.Add(label);

            object? factoryValue = info.Get(factory);
            var reset = new Button
            {
                Content = "↺",
                ToolTip = $"Reset to factory default ({Describe(factoryValue)})",
                Width = 34,
                Margin = new Thickness(6, 0, 0, 0),
                IsEnabled = !Equals(info.Get(settings), factoryValue),
            };
            reset.Click += (_, _) => { info.Set(settings, factoryValue); _changed(); Rebuild(); };
            Grid.SetColumn(reset, 2);
            grid.Children.Add(reset);

            // A single edit applies + saves, and only refreshes this row's reset button, so focus isn't lost.
            void Edited()
            {
                _changed();
                reset.IsEnabled = !Equals(info.Get(settings), factoryValue);
            }

            FrameworkElement editor = BuildEditor(info, settings, Edited);
            Grid.SetColumn(editor, 1);
            grid.Children.Add(editor);

            return grid;
        }

        private FrameworkElement BuildEditor(SettingInfo info, TouchSettings settings, Action edited)
        {
            object? value = info.Get(settings);

            if (info.Type == typeof(bool))
            {
                var box = new CheckBox { IsChecked = (bool)value!, VerticalAlignment = VerticalAlignment.Center };
                box.Checked += (_, _) => { info.Set(settings, true); edited(); };
                box.Unchecked += (_, _) => { info.Set(settings, false); edited(); };
                return box;
            }

            if (info.Type.IsEnum)
            {
                var combo = new ComboBox { VerticalAlignment = VerticalAlignment.Center, MinHeight = 30 };
                foreach (object option in Enum.GetValues(info.Type))
                {
                    combo.Items.Add(new ComboBoxItem { Content = SettingsSchema.EnumLabel(option), Tag = option });
                }
                combo.SelectedItem = combo.Items.Cast<ComboBoxItem>().FirstOrDefault(i => Equals(i.Tag, value));
                combo.SelectionChanged += (_, _) =>
                {
                    if (combo.SelectedItem is ComboBoxItem item) { info.Set(settings, item.Tag); edited(); }
                };
                return combo;
            }

            if (info.Type == typeof(int) || info.Type == typeof(double))
            {
                var panel = new DockPanel { VerticalAlignment = VerticalAlignment.Center };
                var unit = new TextBlock { Text = info.Meta.Unit, Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center, Foreground = Brushes.Gray, MinWidth = 24 };
                DockPanel.SetDock(unit, Dock.Right);
                var text = new TextBox { Text = Describe(value), MinHeight = 30, VerticalContentAlignment = VerticalAlignment.Center };

                string range = double.IsNaN(info.Meta.Min) ? "" : $"Range {info.Meta.Min:G}–{info.Meta.Max:G} {info.Meta.Unit}. ";
                text.ToolTip = range + info.Meta.Description;

                void Apply()
                {
                    if (!TryParse(text.Text, out double parsed)) { text.Text = Describe(info.Get(settings)); return; }
                    // Cast to object first: without it the conditional's type is double, and setting an int property throws.
                    object boxed = info.Type == typeof(int) ? (object)(int)Math.Round(parsed) : parsed;
                    if (Equals(boxed, info.Get(settings))) return;
                    info.SetClamped(settings, boxed);
                    text.Text = Describe(info.Get(settings)); // show the clamped value
                    edited();
                }

                text.LostKeyboardFocus += (_, _) => Apply();
                text.KeyDown += (_, e) => { if (e.Key == Key.Enter) Apply(); };

                panel.Children.Add(unit);
                panel.Children.Add(text);
                return panel;
            }

            return new TextBlock { Text = Describe(value) };
        }

        /// <summary>Whole-object change (reset all / import): apply, save, redraw every row.</summary>
        private void Commit()
        {
            _changed();
            Dispatcher.BeginInvoke(new Action(Rebuild));
        }

        private void ResetAll()
        {
            if (MessageBox.Show(this, "Reset every Flow touch setting to its factory default?", "Formcraft Flow",
                    MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            _replace(new TouchSettings());
            Commit();
        }

        private void Export()
        {
            var dialog = new Microsoft.Win32.SaveFileDialog
            {
                FileName = "Flow-touch-settings.json",
                Filter = "Flow touch settings (*.json)|*.json",
            };
            if (dialog.ShowDialog(this) != true) return;
            try { JsonFileStore<TouchSettings>.Write(dialog.FileName, _get()); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Formcraft Flow", MessageBoxButton.OK, MessageBoxImage.Warning); }
        }

        private void Import()
        {
            var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "Flow touch settings (*.json)|*.json" };
            if (dialog.ShowDialog(this) != true) return;
            try
            {
                _replace(JsonFileStore<TouchSettings>.Read(dialog.FileName));
                Commit();
            }
            catch (Exception ex) { MessageBox.Show(this, "That file couldn't be read as Flow touch settings.\n\n" + ex.Message, "Formcraft Flow", MessageBoxButton.OK, MessageBoxImage.Warning); }
        }

        // ---- helpers ------------------------------------------------------------------------------

        private static bool TryParse(string s, out double value) =>
            double.TryParse(s, NumberStyles.Float, CultureInfo.CurrentCulture, out value) ||
            double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value);

        private static string Describe(object? value) => value switch
        {
            null => "",
            bool b => b ? "on" : "off",
            double d => d.ToString("0.###", CultureInfo.CurrentCulture),
            Enum e => SettingsSchema.EnumLabel(e),
            _ => Convert.ToString(value, CultureInfo.CurrentCulture) ?? "",
        };

        private static Button MakeButton(string text, Action onClick)
        {
            var b = new Button { Content = text, Padding = new Thickness(14, 6, 14, 6), Margin = new Thickness(0, 0, 8, 0), MinHeight = 36 };
            b.Click += (_, _) => onClick();
            return b;
        }
    }
}
