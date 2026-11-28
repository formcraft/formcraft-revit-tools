using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Tests
{
    /// <summary>
    /// F02: keyboard users must always see where focus is. Every kit style for a control that can take focus
    /// either sets a focus visual (Fmc.FocusVisual) or draws its own focus state with a template or style trigger.
    /// </summary>
    public class FocusRingTests
    {
        private static readonly HashSet<string> FocusTriggers = new HashSet<string>
        {
            "IsKeyboardFocused", "IsKeyboardFocusWithin", "IsFocused",
            "IsHighlighted", // a ComboBoxItem: the arrow keys move the highlight, not keyboard focus
        };

        // Containers whose items or cells take keyboard focus and draw the cue themselves.
        private static readonly HashSet<Type> FocusGoesToItems = new HashSet<Type>
        {
            typeof(ListBox), typeof(DataGrid), typeof(DataGridRow),
        };

        [Test]
        public async Task Every_focusable_kit_style_shows_keyboard_focus()
        {
            var (checkedCount, missing) = Sta.Run(() =>
            {
                var kit = ThemeService.LoadStyles();
                var gaps = new List<string>();
                var n = 0;
                foreach (var key in kit.Keys)
                {
                    if (!(kit[key] is Style style) || style.TargetType == null) continue;
                    if (!typeof(UIElement).IsAssignableFrom(style.TargetType)) continue;
                    if (FocusGoesToItems.Contains(style.TargetType)) continue;
                    if (!IsFocusable(style)) continue;
                    n++;
                    if (HasFocusVisual(style) || HasFocusTrigger(style)) continue;
                    gaps.Add($"{key} ({style.TargetType.Name})");
                }
                gaps.Sort(StringComparer.Ordinal);
                return (n, string.Join(", ", gaps));
            });

            await Assert.That(missing).IsEqualTo("");
            await Assert.That(checkedCount).IsGreaterThan(10);
        }

        [Test]
        [Arguments("FmcTextBox")]
        [Arguments("FmcPasswordBox")]
        [Arguments("FmcTable.Cell")]
        public async Task Inputs_without_a_ring_draw_focus_in_their_template(string key)
        {
            var (noRing, trigger) = Sta.Run(() =>
            {
                var style = (Style)ThemeService.LoadStyles()[key];
                return (!HasFocusVisual(style), HasFocusTrigger(style));
            });

            await Assert.That(noRing).IsTrue();
            await Assert.That(trigger).IsTrue();
        }

        private static IEnumerable<Style> Chain(Style style)
        {
            for (var s = style; s != null; s = s.BasedOn) yield return s;
        }

        private static IEnumerable<Setter> Setters(Style style) => Chain(style).SelectMany(s => s.Setters.OfType<Setter>());

        private static bool IsFocusable(Style style)
        {
            var setter = Setters(style).FirstOrDefault(s => s.Property == UIElement.FocusableProperty);
            if (setter != null) return !(setter.Value is bool b) || b;
            return UIElement.FocusableProperty.GetMetadata(style.TargetType).DefaultValue is bool d && d;
        }

        private static bool HasFocusVisual(Style style)
        {
            var setter = Setters(style).FirstOrDefault(s => s.Property == FrameworkElement.FocusVisualStyleProperty);
            return setter != null && setter.Value != null;
        }

        private static bool HasFocusTrigger(Style style)
        {
            foreach (var s in Chain(style))
            {
                if (s.Triggers.Any(IsFocusTrigger)) return true;
                foreach (var setter in s.Setters.OfType<Setter>())
                    if (setter.Property == Control.TemplateProperty && setter.Value is ControlTemplate t && t.Triggers.Any(IsFocusTrigger))
                        return true;
            }
            return false;
        }

        private static bool IsFocusTrigger(TriggerBase trigger) => trigger switch
        {
            Trigger t => t.Property != null && FocusTriggers.Contains(t.Property.Name),
            MultiTrigger m => m.Conditions.Any(c => c.Property != null && FocusTriggers.Contains(c.Property.Name)),
            _ => false,
        };
    }
}
