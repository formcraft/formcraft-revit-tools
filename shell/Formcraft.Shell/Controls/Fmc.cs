using System;
using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace Formcraft.Shell.Controls
{
    /// <summary>The five chip states of the UI kit.</summary>
    public enum ChipKind { Good, Warn, Bad, Info, Grey }

    /// <summary>
    /// Attached properties the kit styles read, so plain WPF controls can show the board states:
    /// placeholder text, invalid input, busy buttons, the AI button's missing key and locked switches.
    /// </summary>
    public static class Fmc
    {
        public static readonly DependencyProperty PlaceholderProperty = DependencyProperty.RegisterAttached(
            "Placeholder", typeof(string), typeof(Fmc), new FrameworkPropertyMetadata(""));
        public static string GetPlaceholder(DependencyObject d) => (string)d.GetValue(PlaceholderProperty);
        public static void SetPlaceholder(DependencyObject d, string value) => d.SetValue(PlaceholderProperty, value);

        /// <summary>Marks an input invalid: red border. The message goes in a hint below it.</summary>
        public static readonly DependencyProperty InvalidProperty = DependencyProperty.RegisterAttached(
            "Invalid", typeof(bool), typeof(Fmc), new FrameworkPropertyMetadata(false));
        public static bool GetInvalid(DependencyObject d) => (bool)d.GetValue(InvalidProperty);
        public static void SetInvalid(DependencyObject d, bool value) => d.SetValue(InvalidProperty, value);

        /// <summary>A button whose action is running: spinner, no clicks.</summary>
        public static readonly DependencyProperty BusyProperty = DependencyProperty.RegisterAttached(
            "Busy", typeof(bool), typeof(Fmc), new FrameworkPropertyMetadata(false));
        public static bool GetBusy(DependencyObject d) => (bool)d.GetValue(BusyProperty);
        public static void SetBusy(DependencyObject d, bool value) => d.SetValue(BusyProperty, value);

        /// <summary>An AI button with no Claude key set: shown, not clickable, says why.</summary>
        public static readonly DependencyProperty NeedsKeyProperty = DependencyProperty.RegisterAttached(
            "NeedsKey", typeof(bool), typeof(Fmc), new FrameworkPropertyMetadata(false));
        public static bool GetNeedsKey(DependencyObject d) => (bool)d.GetValue(NeedsKeyProperty);
        public static void SetNeedsKey(DependencyObject d, bool value) => d.SetValue(NeedsKeyProperty, value);

        /// <summary>A switch set by a team rule or the user only: padlock, can't be changed here.</summary>
        public static readonly DependencyProperty LockedProperty = DependencyProperty.RegisterAttached(
            "Locked", typeof(bool), typeof(Fmc), new FrameworkPropertyMetadata(false));
        public static bool GetLocked(DependencyObject d) => (bool)d.GetValue(LockedProperty);
        public static void SetLocked(DependencyObject d, bool value) => d.SetValue(LockedProperty, value);
    }

    /// <summary>Table headers are upper case on the boards; WPF has no text-transform.</summary>
    public sealed class UpperCaseConverter : IValueConverter
    {
        public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            value?.ToString()?.ToUpper(culture);

        public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            Binding.DoNothing;
    }
}
