using System.Collections.Generic;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Preview
{
    public sealed class Option<T>
    {
        public Option(T value, string label)
        {
            Value = value;
            Label = label;
        }

        public T Value { get; }
        public string Label { get; }
    }

    /// <summary>
    /// Preview-only theme controls. "Revit theme" stands in for Revit's Options › Colors and calls SetHostTheme,
    /// exactly as the add-in will on UIApplication.ThemeChanged; "Pane theme" is the Settings › General choice.
    /// </summary>
    public sealed class PreviewTheme : ObservableObject
    {
        private readonly ThemeService _themes;

        public PreviewTheme(ThemeService themes)
        {
            _themes = themes;
            _themes.Changed += (_, _) => OnPropertyChanged(nameof(Effective));
        }

        public IReadOnlyList<Option<PaneTheme>> RevitThemes { get; } = new[]
        {
            new Option<PaneTheme>(PaneTheme.Light, "Light"),
            new Option<PaneTheme>(PaneTheme.Dark, "Dark"),
        };

        public IReadOnlyList<Option<ThemeChoice>> Choices { get; } = new[]
        {
            new Option<ThemeChoice>(ThemeChoice.FollowRevit, "Follow Revit"),
            new Option<ThemeChoice>(ThemeChoice.Light, "Light"),
            new Option<ThemeChoice>(ThemeChoice.Dark, "Dark"),
        };

        public PaneTheme RevitTheme
        {
            get => _themes.HostTheme;
            set
            {
                _themes.SetHostTheme(value);
                OnPropertyChanged();
            }
        }

        public ThemeChoice Choice
        {
            get => _themes.Choice;
            set
            {
                _themes.Choice = value;
                OnPropertyChanged();
            }
        }

        public string Effective => "Showing " + _themes.Effective.ToString().ToLowerInvariant();
    }
}
