using System.Collections.Generic;
using System.Windows.Input;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Preview
{
    /// <summary>Sample values for the kit gallery. Text follows the boards; values are samples.</summary>
    public sealed class KitGalleryViewModel : ObservableObject
    {
        private double _paneWidth = 440;
        private bool _busy;
        private bool _dialogOpen;
        private ThemeChoice _segmentedSample = ThemeChoice.FollowRevit;

        public KitGalleryViewModel(ThemeService themes)
        {
            Theme = new PreviewTheme(themes);
            OpenDialogCommand = new RelayCommand(() => DialogOpen = true);
            CloseDialogCommand = new RelayCommand(() => DialogOpen = false);
            ToggleBusyCommand = new RelayCommand(() => Busy = !Busy);
        }

        public PreviewTheme Theme { get; }

        public IReadOnlyList<Option<double>> Widths { get; } = new[]
        {
            new Option<double>(440, "440 px"),
            new Option<double>(360, "360 px"),
        };

        public double PaneWidth
        {
            get => _paneWidth;
            set => Set(ref _paneWidth, value);
        }

        public bool Busy
        {
            get => _busy;
            set => Set(ref _busy, value);
        }

        public bool DialogOpen
        {
            get => _dialogOpen;
            set => Set(ref _dialogOpen, value);
        }

        public IReadOnlyList<Option<ThemeChoice>> SegmentedOptions => Theme.Choices;

        public ThemeChoice SegmentedSample
        {
            get => _segmentedSample;
            set => Set(ref _segmentedSample, value);
        }

        public ICommand OpenDialogCommand { get; }
        public ICommand CloseDialogCommand { get; }
        public ICommand ToggleBusyCommand { get; }

        public IReadOnlyList<ModuleRow> Modules { get; } = new[]
        {
            new ModuleRow("Core", "Included", "—"),
            new ModuleRow("Manage", "Active", "31 Dec"),
            new ModuleRow("Flow", "Active", "31 Dec"),
            new ModuleRow("Model", "Trial", "9 days left"),
            new ModuleRow("Build", "Not licensed", "—"),
        };

        public IReadOnlyList<string> Swatches { get; } = new[]
        {
            "Navy", "Orange", "Primary", "Accent", "Ink", "Muted", "Surface", "Field", "Header", "Footer", "Line", "Divider",
            "Hover", "Selected", "Flow", "Model", "Build", "Good", "Warning", "Critical",
        };
    }

    public sealed class ModuleRow
    {
        public ModuleRow(string module, string status, string until)
        {
            Module = module;
            Status = status;
            Until = until;
        }

        public string Module { get; }
        public string Status { get; }
        public string Until { get; }
    }
}
