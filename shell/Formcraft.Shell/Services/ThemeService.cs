using System;
using System.Collections.Generic;
using System.Windows;
using Microsoft.Win32;

namespace Formcraft.Shell.Services
{
    /// <summary>The two colour sets in Theme/FmcColors.*.xaml.</summary>
    public enum PaneTheme { Light, Dark }

    /// <summary>The Theme setting (Settings › General): follow Revit, or override it.</summary>
    public enum ThemeChoice { FollowRevit, Light, Dark }

    /// <summary>
    /// Keeps every Formcraft view on the right colours. The add-in reports Revit's UI theme through SetHostTheme,
    /// at start-up and on each UIApplication.ThemeChanged, so the pane switches with Revit at once (no restart).
    /// No Revit reference here: the host passes the theme in. Views call Attach once; styles read colours with
    /// DynamicResource, so swapping the colour dictionary repaints everything that is open.
    /// </summary>
    public sealed class ThemeService
    {
        private const string MarkerKey = "Fmc.ThemeName";
        private readonly List<WeakReference<FrameworkElement>> _roots = new List<WeakReference<FrameworkElement>>();
        private ThemeChoice _choice;
        private PaneTheme _hostTheme;

        public ThemeService(PaneTheme hostTheme = PaneTheme.Light, ThemeChoice choice = ThemeChoice.FollowRevit)
        {
            _hostTheme = hostTheme;
            _choice = choice;
        }

        /// <summary>The one service the pane, its dialogs and windows share inside Revit.</summary>
        public static ThemeService Shared { get; } = new ThemeService(WindowsAppTheme());

        public event EventHandler? Changed;

        /// <summary>Revit's current UI theme, as last reported by the host.</summary>
        public PaneTheme HostTheme => _hostTheme;

        public ThemeChoice Choice
        {
            get => _choice;
            set => Update(() => _choice = value);
        }

        /// <summary>The theme on screen: Revit's, unless the person chose Light or Dark.</summary>
        public PaneTheme Effective =>
            _choice == ThemeChoice.Light ? PaneTheme.Light :
            _choice == ThemeChoice.Dark ? PaneTheme.Dark :
            _hostTheme;

        /// <summary>Called by the host with Revit's UI theme (UIThemeManager.CurrentTheme, ThemeChanged).</summary>
        public void SetHostTheme(PaneTheme theme) => Update(() => _hostTheme = theme);

        /// <summary>
        /// Puts the theme on a view or window and keeps it current. The element's resources should merge
        /// FmcColors.Light.xaml and FmcTheme.xaml (as the views do in XAML); the colour dictionary is swapped here.
        /// </summary>
        public void Attach(FrameworkElement root)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            Apply(root.Resources, Effective);
            lock (_roots)
            {
                _roots.RemoveAll(r => !r.TryGetTarget(out _));
                _roots.Add(new WeakReference<FrameworkElement>(root));
            }
        }

        /// <summary>Puts the colours for a theme into a resource dictionary, replacing any colours already there.</summary>
        public static void Apply(ResourceDictionary resources, PaneTheme theme)
        {
            var merged = resources.MergedDictionaries;
            for (var i = 0; i < merged.Count; i++)
            {
                if (!merged[i].Contains(MarkerKey)) continue;
                if (Equals(merged[i][MarkerKey], theme.ToString())) return;
                merged[i] = LoadColours(theme);
                return;
            }
            merged.Insert(0, LoadColours(theme));
            if (!HasStyles(resources)) merged.Add(LoadStyles());
        }

        public static ResourceDictionary LoadColours(PaneTheme theme) => new ResourceDictionary
        {
            Source = new Uri($"pack://application:,,,/Formcraft.Shell;component/Theme/FmcColors.{theme}.xaml", UriKind.Absolute),
        };

        public static ResourceDictionary LoadStyles() => new ResourceDictionary
        {
            Source = new Uri("pack://application:,,,/Formcraft.Shell;component/Theme/FmcTheme.xaml", UriKind.Absolute),
        };

        /// <summary>
        /// The Windows app theme (Settings › Personalisation › Colours). Used outside Revit, and as the start
        /// value until the host reports Revit's theme.
        /// </summary>
        public static PaneTheme WindowsAppTheme()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
                return key?.GetValue("AppsUseLightTheme") is int light && light == 0 ? PaneTheme.Dark : PaneTheme.Light;
            }
            catch (Exception)
            {
                return PaneTheme.Light;
            }
        }

        private static bool HasStyles(ResourceDictionary resources)
        {
            foreach (var d in resources.MergedDictionaries)
                if (d.Contains("FmcButton.Primary")) return true;
            return false;
        }

        private void Update(Action change)
        {
            var before = Effective;
            change();
            if (Effective == before) return;

            List<FrameworkElement> live = new List<FrameworkElement>();
            lock (_roots)
            {
                _roots.RemoveAll(r => !r.TryGetTarget(out _));
                foreach (var r in _roots)
                    if (r.TryGetTarget(out var root)) live.Add(root);
            }
            foreach (var root in live)
            {
                if (root.Dispatcher.CheckAccess()) Apply(root.Resources, Effective);
                else root.Dispatcher.Invoke(() => Apply(root.Resources, Effective));
            }
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
