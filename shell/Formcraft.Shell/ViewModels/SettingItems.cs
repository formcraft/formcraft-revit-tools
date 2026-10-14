using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>One row of a Settings group. Each kind has its own DataTemplate in SettingsView.</summary>
    public abstract class SettingItem : ObservableObject
    {
        protected SettingItem(string label, string hint = "")
        {
            Label = label;
            Hint = hint;
        }

        public string Label { get; }
        public string Hint { get; }
        public bool HasLabel => Label.Length > 0;
        public bool HasHint => Hint.Length > 0;
    }

    /// <summary>Where a setting's value lives: the person's settings.json, under "settings.&lt;tab&gt;.&lt;id&gt;".</summary>
    public sealed class SettingStore
    {
        private readonly IUserSettings _settings;
        private readonly string _prefix;

        public SettingStore(IUserSettings settings, string prefix = "settings.")
        {
            _settings = settings;
            _prefix = prefix;
        }

        public string? Get(string key) => _settings.Get(_prefix + key);
        public void Set(string key, string? value) => _settings.Set(_prefix + key, value);
    }

    /// <summary>A value the person can see and copy but not change here (set by Admin, the kit or Revit).</summary>
    public sealed class ReadOnlySetting : SettingItem
    {
        public ReadOnlySetting(string label, string value, string hint = "", bool mono = false) : base(label, hint)
        {
            Value = value;
            Mono = mono;
        }

        public string Value { get; }
        public bool Mono { get; }
    }

    /// <summary>One of a few options: a segmented control, or a drop-down when there are more or longer options.</summary>
    public sealed class ChoiceSetting : SettingItem
    {
        private readonly SettingStore _store;
        private readonly string _key;
        private readonly Action<string>? _changed;

        public ChoiceSetting(SettingStore store, string key, string label, IReadOnlyList<string> options, int fallback = 0,
                             bool dropdown = false, string hint = "", Action<string>? changed = null) : base(label, hint)
        {
            _store = store;
            _key = key;
            Options = options;
            IsDropdown = dropdown;
            Default = options[fallback];
            _changed = changed;
        }

        internal string KeyForReset => _key;
        public IReadOnlyList<string> Options { get; }
        public bool IsDropdown { get; }
        public bool IsSegmented => !IsDropdown;
        public string Default { get; }

        public string Selected
        {
            get => _store.Get(_key) is string v && Options.Contains(v) ? v : Default;
            set
            {
                if (value == null || !Options.Contains(value) || value == Selected) return;
                _store.Set(_key, value);
                OnPropertyChanged();
                _changed?.Invoke(value);
            }
        }

        /// <summary>The value changed somewhere else (the ribbon, Revit): show it.</summary>
        public void Refresh() => OnPropertyChanged(nameof(Selected));
    }

    /// <summary>An on/off switch. Locked ones show the padlock: set by a team rule, a professional or Admin.</summary>
    public sealed class ToggleSetting : SettingItem
    {
        private readonly SettingStore _store;
        private readonly string _key;
        private readonly bool _default;

        public ToggleSetting(SettingStore store, string key, string label, bool fallback, string hint = "", bool locked = false, string lockedWhy = "")
            : base(label, hint)
        {
            _store = store;
            _key = key;
            _default = fallback;
            Locked = locked;
            LockedWhy = lockedWhy;
        }

        internal string KeyForReset => _key;
        public bool Locked { get; }
        public string LockedWhy { get; }

        public bool IsOn
        {
            get => Locked ? _default : _store.Get(_key) is string v ? v == "true" : _default;
            set
            {
                if (Locked || value == IsOn) return;
                _store.Set(_key, value ? "true" : "false");
                OnPropertyChanged();
            }
        }

        /// <summary>The value changed somewhere else (the ribbon, Revit): show it.</summary>
        public void Refresh() => OnPropertyChanged(nameof(IsOn));
    }

    public sealed class OptionChip : ObservableObject
    {
        private readonly Action<OptionChip> _changed;
        private bool _isOn;

        public OptionChip(string name, bool isOn, Action<OptionChip> changed)
        {
            Name = name;
            _isOn = isOn;
            _changed = changed;
        }

        public string Name { get; }
        public bool IsOn { get => _isOn; set { if (Set(ref _isOn, value)) _changed(this); } }
    }

    /// <summary>Several options on or off: chips, or a list of check lines (AsChecks).</summary>
    public sealed class MultiSetting : SettingItem
    {
        private readonly SettingStore _store;
        private readonly string _key;

        public MultiSetting(SettingStore store, string key, string label, IReadOnlyList<string> options, IEnumerable<string> fallbackOn,
                            bool asChecks = false, string hint = "") : base(label, hint)
        {
            _store = store;
            _key = key;
            AsChecks = asChecks;
            var saved = store.Get(key);
            var on = saved == null ? new HashSet<string>(fallbackOn) : new HashSet<string>(saved.Split('|').Where(s => s.Length > 0));
            Options = options.Select(o => new OptionChip(o, on.Contains(o), _ => Save())).ToList();
        }

        internal string KeyForReset => _key;
        public IReadOnlyList<OptionChip> Options { get; }
        public bool AsChecks { get; }
        public bool AsChips => !AsChecks;
        public IEnumerable<string> On => Options.Where(o => o.IsOn).Select(o => o.Name);

        private void Save() => _store.Set(_key, string.Join("|", On));
    }

    /// <summary>One view's row in Settings › Flow › Touch: its name, type and touch switch.</summary>
    public sealed class TouchViewRow : ObservableObject
    {
        private readonly ITouchService _touch;
        private bool _on;

        public TouchViewRow(ITouchService touch, TouchView view)
        {
            _touch = touch;
            Id = view.Id;
            Name = view.Name;
            Type = view.IsActive ? view.Type + " · active" : view.Type;
            _on = view.On;
        }

        public long Id { get; }
        public string Name { get; }
        public string Type { get; }

        public bool On
        {
            get => _on;
            set { if (Set(ref _on, value)) _touch.SetView(Id, value); }
        }

        internal void Show(bool on) { _on = on; OnPropertyChanged(nameof(On)); }
    }

    /// <summary>
    /// Touch views (board flow/PaneFlowTouch): every open view with its own switch, on screen first and then background
    /// tabs, with All on and All off. Background tabs never get touch until they are on screen, but keep their switch.
    /// </summary>
    public sealed class TouchViewsSetting : SettingItem
    {
        private readonly ITouchService _touch;

        public TouchViewsSetting(ITouchService touch) : base("Touch views", "Per view, remembered for this project on this computer. Nothing is written into the model.")
        {
            _touch = touch;
            AllOnCommand = new RelayCommand(() => _touch.SetAllViews(true));
            AllOffCommand = new RelayCommand(() => _touch.SetAllViews(false));
            Update();
        }

        public System.Collections.ObjectModel.ObservableCollection<TouchViewRow> OnScreen { get; } = new System.Collections.ObjectModel.ObservableCollection<TouchViewRow>();
        public System.Collections.ObjectModel.ObservableCollection<TouchViewRow> Background { get; } = new System.Collections.ObjectModel.ObservableCollection<TouchViewRow>();
        public bool HasOnScreen => OnScreen.Count > 0;
        public bool HasBackground => Background.Count > 0;
        public bool NoViews => !HasOnScreen && !HasBackground;
        public ICommand AllOnCommand { get; }
        public ICommand AllOffCommand { get; }

        /// <summary>Follows the views open in Revit; rows that stay keep their place so a switch under a finger doesn't jump.</summary>
        public void Update()
        {
            Sync(OnScreen, _touch.Views.Where(v => v.OnScreen).ToList());
            Sync(Background, _touch.Views.Where(v => !v.OnScreen).ToList());
            OnPropertyChanged(nameof(HasOnScreen));
            OnPropertyChanged(nameof(HasBackground));
            OnPropertyChanged(nameof(NoViews));
        }

        private void Sync(System.Collections.ObjectModel.ObservableCollection<TouchViewRow> rows, List<TouchView> views)
        {
            bool same = rows.Count == views.Count && rows.Zip(views, (r, v) => r.Id == v.Id && r.Name == v.Name && r.Type.StartsWith(v.Type) && r.Type.EndsWith("active") == v.IsActive).All(x => x);
            if (same)
            {
                for (int i = 0; i < rows.Count; i++) if (rows[i].On != views[i].On) rows[i].Show(views[i].On);
                return;
            }
            rows.Clear();
            foreach (var v in views) rows.Add(new TouchViewRow(_touch, v));
        }
    }

    /// <summary>A module's parts switches: the same chips as Settings parts and the ribbon parts switch.</summary>
    public sealed class PartsSetting : SettingItem
    {
        public PartsSetting(ModuleParts parts) : base("Show these parts", parts.Hint) => Parts = parts;

        public ModuleParts Parts { get; }
    }

    /// <summary>A note under a group: info (teal) or warning (amber), as on the boards.</summary>
    public sealed class NoteSetting : SettingItem
    {
        public NoteSetting(string text, ChipKind kind = ChipKind.Info) : base("")
        {
            Text = text;
            Kind = kind;
        }

        public string Text { get; }
        public ChipKind Kind { get; }
    }

    public sealed class WorksWithRow
    {
        public WorksWithRow(string text, string status, ChipKind kind)
        {
            Text = text;
            Status = status;
            Kind = kind;
        }

        public string Text { get; }
        public string Status { get; }
        public ChipKind Kind { get; }
    }

    /// <summary>"Works with": what this module shares with Core and the others, and whether each is licensed.</summary>
    public sealed class WorksWithSetting : SettingItem
    {
        public WorksWithSetting(IReadOnlyList<WorksWithRow> rows) : base("") => Rows = rows;

        public IReadOnlyList<WorksWithRow> Rows { get; }
    }

    public sealed class SettingButton
    {
        public SettingButton(string label, ICommand command, bool primary = false)
        {
            Label = label;
            Command = command;
            Primary = primary;
        }

        public string Label { get; }
        public ICommand Command { get; }
        public bool Primary { get; }
    }

    /// <summary>A row of buttons (Apply the standard, Fix the clash, a module tab link…).</summary>
    public sealed class ButtonsSetting : SettingItem
    {
        public ButtonsSetting(string label, IReadOnlyList<SettingButton> buttons, string hint = "") : base(label, hint) => Buttons = buttons;

        public IReadOnlyList<SettingButton> Buttons { get; }
    }

    /// <summary>A typed value: a name, a number, a reason for the audit log. Saved to the store when it has a key.</summary>
    public sealed class TextSetting : SettingItem
    {
        private readonly SettingStore? _store;
        private readonly string _key;
        private string _value;

        public TextSetting(string label, string value = "", string placeholder = "", string hint = "", SettingStore? store = null, string key = "", bool mono = false)
            : base(label, hint)
        {
            _store = store;
            _key = key;
            _value = store != null && key.Length > 0 ? store.Get(key) ?? value : value;
            Placeholder = placeholder;
            Mono = mono;
        }

        public string Placeholder { get; }
        public bool Mono { get; }

        public string Value
        {
            get => _value;
            set
            {
                if (!Set(ref _value, value ?? "")) return;
                if (_store != null && _key.Length > 0) _store.Set(_key, _value);
            }
        }
    }

    public sealed class TableRow : ObservableObject
    {
        public TableRow(object? tag, params string[] cells)
        {
            Tag = tag;
            Cells = cells;
        }

        /// <summary>What the row stands for (a person, a request), for the buttons under the table.</summary>
        public object? Tag { get; }
        public IReadOnlyList<string> Cells { get; }
    }

    /// <summary>A small table (team, permissions, seats, audit log). Rows can be picked when buttons act on one.</summary>
    public sealed class TableSetting : SettingItem
    {
        private TableRow? _selected;

        public TableSetting(string label, IReadOnlyList<string> columns, IEnumerable<TableRow> rows, bool selectable = false, string hint = "")
            : base(label, hint)
        {
            Columns = columns;
            Rows = rows.ToList();
            Selectable = selectable;
        }

        public IReadOnlyList<string> Columns { get; }
        public IReadOnlyList<TableRow> Rows { get; }
        public bool Selectable { get; }
        public int ColumnCount => Columns.Count;
        public TableRow? Selected { get => _selected; set => Set(ref _selected, value); }
    }

    /// <summary>
    /// Author's considerations (every Settings board): notes sent with every Claude request from this panel and saved in
    /// the log. They never override a rule; a conflict is flagged. A saved set can be picked, or the text saved as one.
    /// </summary>
    public sealed class ConsiderationsSetting : SettingItem
    {
        public const string NoneSelected = "Saved: none selected";
        private readonly SettingStore _store;
        private readonly string _key;
        private readonly Action<string> _status;
        private string _text;

        public ConsiderationsSetting(SettingStore store, string key, Action<string> status)
            : base("Author's considerations", "Sent with every AI request from this panel and saved in the log. It never overrides a rule; a conflict is flagged.")
        {
            _store = store;
            _key = key;
            _status = status;
            _text = store.Get(key + ".text") ?? "";
            Saved = new ChoiceSetting(store, key + ".saved", "", new[] { NoneSelected, "Client house style notes", "Permit-set rules" }, dropdown: true);
            SaveCommand = new RelayCommand(() => { Persist(); _status("Considerations saved for this panel."); });
            SaveAsCommand = new RelayCommand(() => { Persist(); _status("Save as…: names this set so you can pick it again (saved sets come with Ask Claude, U27)."); });
        }

        internal string KeyForReset => _key;
        public ChoiceSetting Saved { get; }
        public RelayCommand SaveCommand { get; }
        public RelayCommand SaveAsCommand { get; }

        public string Text { get => _text; set => Set(ref _text, value ?? ""); }

        private void Persist() => _store.Set(_key + ".text", Text.Trim().Length == 0 ? null : Text);
    }
}
