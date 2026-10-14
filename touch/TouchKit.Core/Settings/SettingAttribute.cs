using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Reflection;

namespace TouchKit.Core.Settings
{
    /// <summary>
    /// Marks a property as a user setting. The settings window, reset buttons and import/export are all
    /// generated from these attributes, so adding a setting is one property plus one attribute.
    /// </summary>
    [AttributeUsage(AttributeTargets.Property)]
    public sealed class SettingAttribute : Attribute
    {
        public SettingAttribute(string group, string label)
        {
            Group = group;
            Label = label;
        }

        public string Group { get; }
        public string Label { get; }
        public string Description { get; set; } = "";
        public string Unit { get; set; } = "";
        public bool Advanced { get; set; }
        public double Min { get; set; } = double.NaN;
        public double Max { get; set; } = double.NaN;
        /// <summary>Display order within the group.</summary>
        public int Order { get; set; }
    }

    /// <summary>A setting discovered by reflection.</summary>
    public sealed record SettingInfo(PropertyInfo Property, SettingAttribute Meta)
    {
        public Type Type => Property.PropertyType;
        public object? Get(object owner) => Property.GetValue(owner);
        public void Set(object owner, object? value) => Property.SetValue(owner, value);

        /// <summary>Clamp numbers to Min/Max. Returns the value actually stored.</summary>
        public object? SetClamped(object owner, object? value)
        {
            if (value is double d)
            {
                if (!double.IsNaN(Meta.Min)) d = Math.Max(Meta.Min, d);
                if (!double.IsNaN(Meta.Max)) d = Math.Min(Meta.Max, d);
                value = d;
            }
            else if (value is int i)
            {
                if (!double.IsNaN(Meta.Min)) i = (int)Math.Max(Meta.Min, i);
                if (!double.IsNaN(Meta.Max)) i = (int)Math.Min(Meta.Max, i);
                value = i;
            }
            Set(owner, value);
            return value;
        }
    }

    public static class SettingsSchema
    {
        public static IReadOnlyList<SettingInfo> Describe(Type settingsType) =>
            settingsType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(p => (p, meta: p.GetCustomAttribute<SettingAttribute>()))
                .Where(x => x.meta is not null && x.p.CanRead && x.p.CanWrite)
                .Select(x => new SettingInfo(x.p, x.meta!))
                .OrderBy(s => s.Meta.Advanced)
                .ThenBy(s => s.Meta.Group)
                .ThenBy(s => s.Meta.Order)
                .ToList();

        /// <summary>Human label for an enum value: uses [Description] if present.</summary>
        public static string EnumLabel(object value)
        {
            FieldInfo? field = value.GetType().GetField(value.ToString()!);
            return field?.GetCustomAttribute<DescriptionAttribute>()?.Description ?? value.ToString()!;
        }
    }
}
