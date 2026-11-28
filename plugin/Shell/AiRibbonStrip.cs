using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows.Media;
using System.Windows.Threading;
using Formcraft.Shell.Services;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// The AI activity strip (owner, 15 Oct): while an AI app works in this Revit, the panel title bars on every ribbon
    /// tab take a colour per state (Changing, Waiting for yes, Reading; AiActivityTracker). Colours and switches are in
    /// Settings › General › AI activity strip (AiStripSettings); colours are theme tokens, Light or Dark as the pane.
    /// <para>
    /// Revit's ribbon API has no colours, so this sets RibbonPanel.CustomPanelTitleBarBackground through AdWindows
    /// (Autodesk.Windows.ComponentManager.Ribbon), by reflection: no compile-time reference, and if a Revit version
    /// changes those types the strip switches itself off and says why (Problem), never breaking the ribbon. Each panel's
    /// own brush is kept and put back when the AI stops, the connection goes off or Revit closes.
    /// </para>
    /// A WPF timer on Revit's UI thread checks four times a second and changes the ribbon only when the colour changes;
    /// panels Revit adds later (contextual tabs) are coloured on the next tick.
    /// </summary>
    public static class AiRibbonStrip
    {
        private const string TitleBarProperty = "CustomPanelTitleBarBackground";

        private static DispatcherTimer _timer;
        private static Func<string, string> _get;
        private static string _shown;          // the token on the ribbon now, or null
        private static Brush _brush;
        private static PaneTheme _brushTheme;
        private static readonly Dictionary<object, object> Original = new Dictionary<object, object>(new ByReference());

        /// <summary>Why the strip is off for this session (AdWindows not as expected), or null.</summary>
        public static string Problem { get; private set; }

        /// <summary>Call once on Revit's UI thread (ShellHost.Register). <paramref name="get"/> reads a pane setting by key.</summary>
        public static void Start(Func<string, string> get)
        {
            if (_timer != null) return;
            _get = get;
            _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(250) };
            _timer.Tick += (s, e) => Tick();
            _timer.Start();
        }

        /// <summary>Puts every panel's own colour back and stops (Revit closing).</summary>
        public static void Stop()
        {
            _timer?.Stop();
            _timer = null;
            try { Restore(); } catch (Exception) { /* Revit is closing; nothing more to do */ }
        }

        private static void Tick()
        {
            if (Problem != null) return;
            try
            {
                string token = AiStripSettings.TokenFor(AiActivityTracker.Shared.Current, _get);
                if (token == null)
                {
                    if (_shown != null) Restore();
                    return;
                }
                var theme = ThemeService.Shared.Effective;
                if (token != _shown || _brush == null || theme != _brushTheme)
                {
                    _brush = BrushFor(token, theme);
                    _brushTheme = theme;
                    _shown = token;
                    foreach (var panel in Panels()) Paint(panel, _brush);
                    return;
                }
                // Same colour: only panels that appeared since (contextual tabs) need it.
                foreach (var panel in Panels())
                    if (!Original.ContainsKey(panel)) Paint(panel, _brush);
            }
            catch (Exception ex)
            {
                Problem = "The AI activity strip is off for this session: " + ex.GetType().Name + ": " + ex.Message;
                System.Diagnostics.Trace.WriteLine(Problem);
                try { Restore(); } catch (Exception) { /* leave the ribbon as it is */ }
            }
        }

        private static Brush BrushFor(string token, PaneTheme theme)
        {
            var colours = ThemeService.LoadColours(theme);
            var colour = colours[token] is Color c ? c : Colors.Orange;
            var brush = new SolidColorBrush(colour);
            brush.Freeze();
            return brush;
        }

        private static void Paint(object panel, Brush brush)
        {
            var property = panel.GetType().GetProperty(TitleBarProperty, BindingFlags.Public | BindingFlags.Instance);
            if (property == null || !property.CanWrite) throw new MissingMemberException(panel.GetType().FullName, TitleBarProperty);
            if (!Original.ContainsKey(panel)) Original[panel] = property.GetValue(panel);
            property.SetValue(panel, brush);
        }

        private static void Restore()
        {
            foreach (var pair in Original)
            {
                var property = pair.Key.GetType().GetProperty(TitleBarProperty, BindingFlags.Public | BindingFlags.Instance);
                property?.SetValue(pair.Key, pair.Value);
            }
            Original.Clear();
            _shown = null;
        }

        /// <summary>Every panel on every tab of Revit's ribbon (AdWindows), found by reflection.</summary>
        private static IEnumerable<object> Panels()
        {
            Type manager = null;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                if (assembly.GetName().Name == "AdWindows") { manager = assembly.GetType("Autodesk.Windows.ComponentManager"); break; }
            if (manager == null) throw new TypeLoadException("Autodesk.Windows.ComponentManager (AdWindows) is not loaded");
            var ribbon = manager.GetProperty("Ribbon", BindingFlags.Public | BindingFlags.Static)?.GetValue(null)
                ?? throw new MissingMemberException("Autodesk.Windows.ComponentManager", "Ribbon");
            var panels = new List<object>();
            if (!(ribbon.GetType().GetProperty("Tabs")?.GetValue(ribbon) is IEnumerable tabs))
                throw new MissingMemberException(ribbon.GetType().FullName, "Tabs");
            foreach (var tab in tabs)
            {
                if (tab == null) continue;
                if (tab.GetType().GetProperty("Panels")?.GetValue(tab) is IEnumerable list)
                    foreach (var panel in list)
                        if (panel != null) panels.Add(panel);
            }
            return panels;
        }

        /// <summary>Panels are kept by identity, never by their own Equals.</summary>
        private sealed class ByReference : IEqualityComparer<object>
        {
            public new bool Equals(object x, object y) => ReferenceEquals(x, y);
            public int GetHashCode(object obj) => RuntimeHelpers.GetHashCode(obj);
        }
    }
}
