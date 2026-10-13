using System;
using System.Collections.Generic;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>One chip in "Show these parts": on shows that part of the module in the pane.</summary>
    public sealed class PartSwitch : ObservableObject
    {
        private readonly Action<bool> _save;
        private bool _isOn;

        public PartSwitch(PartDef part, bool isOn, Action<bool> save)
        {
            Id = part.Id;
            Name = part.Name;
            _isOn = isOn;
            _save = save;
        }

        public string Id { get; }
        public string Name { get; }

        public bool IsOn
        {
            get => _isOn;
            set { if (Set(ref _isOn, value)) _save(value); }
        }

        /// <summary>Shows a value saved elsewhere (another chip, the ribbon) without saving it again.</summary>
        public void Refresh(bool isOn)
        {
            if (_isOn == isOn) return;
            _isOn = isOn;
            OnPropertyChanged(nameof(IsOn));
        }
    }

    /// <summary>A licensed module's parts switches (boards: */PaneSettings*, "parts in the pane").</summary>
    public sealed class ModuleParts
    {
        public ModuleParts(FmcModule module, IEnumerable<PartSwitch> parts)
        {
            Module = module;
            Switches = parts.ToList();
        }

        public FmcModule Module { get; }
        public IReadOnlyList<PartSwitch> Switches { get; }
        public string Title => Module + " · parts in the pane";
        public string Hint => "Same list as the " + Module + " parts switch on the ribbon. Saved for you, not the team.";
    }
}
