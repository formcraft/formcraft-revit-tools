using System;
using System.Collections.Generic;
using System.Linq;

namespace Formcraft.Shell.Services
{
    /// <summary>One open view in Settings › Flow › Touch (board flow/PaneFlowTouch).</summary>
    public sealed class TouchView
    {
        public TouchView(long id, string name, string type, bool onScreen, bool isActive, bool on)
        {
            Id = id;
            Name = name;
            Type = type;
            OnScreen = onScreen;
            IsActive = isActive;
            On = on;
        }

        public long Id { get; }
        public string Name { get; }
        public string Type { get; }
        public bool OnScreen { get; }
        public bool IsActive { get; }
        public bool On { get; }
    }

    /// <summary>
    /// Formcraft Flow's touch (the engine that was TouchKit 0.2): the master switch, touch per view, gestures and the
    /// on-view feedback. In Revit the add-in supplies it; the preview and tests use <see cref="MockTouchService"/>.
    /// Options are read and written as the pane's own words (<see cref="TouchKeys"/>), so the pane needs no engine types.
    /// </summary>
    public interface ITouchService
    {
        /// <summary>False when touch couldn't start here (older Revit, or a start-up error); <see cref="Problem"/> says why.</summary>
        bool Available { get; }
        string Problem { get; }

        bool MasterOn { get; }
        void SetMaster(bool on);

        IReadOnlyList<TouchView> Views { get; }
        void SetView(long id, bool on);
        void SetAllViews(bool on);

        /// <summary>A setting by its <see cref="TouchKeys"/> key, as one of that key's options (or "true"/"false").</summary>
        string? Get(string key);
        void Set(string key, string value);

        /// <summary>Gestures, sensitivity and on-view feedback back to the factory defaults on this computer.</summary>
        void ResetToDefaults();

        /// <summary>The touch probe: which touch and pen messages reach Revit, and a report for support.</summary>
        void OpenProbe();

        event EventHandler? Changed;
    }

    /// <summary>The touch settings the pane shows, and their options in the board's words.</summary>
    public static class TouchKeys
    {
        public const string SelectWith = "selectWith";
        public const string Tap = "tap";
        public const string TwoFingerTap = "twoFingerTap";
        public const string DoubleTap = "doubleTap";
        public const string Drag3D = "drag3d";
        public const string Drag2D = "drag2d";
        public const string Zoom = "zoom";
        public const string Orbit = "orbit";
        public const string InvertZoom = "invertZoom";
        public const string NewViews = "newViews";
        public const string ViewTypes = "viewTypes";
        public const string Frame = "frame";
        public const string Ring = "ring";
        public const string Badge = "badge";

        public static readonly string[] SelectWithOptions = { "Long press", "Tap" };
        public static readonly string[] TapOptions = { "Nothing", "Click" };
        public static readonly string[] TwoFingerTapOptions = { "Right-click menu", "Nothing" };
        public static readonly string[] DoubleTapOptions = { "Zoom to fit", "Double-click", "Nothing" };
        public static readonly string[] Drag3DOptions = { "Orbit", "Pan", "Nothing" };
        public static readonly string[] Drag2DOptions = { "Pan", "Nothing" };
        public static readonly string[] SpeedOptions = { "Gentle", "Normal", "Fast" };
        public static readonly string[] NewViewsOptions = { "Off", "By view type", "On" };
        public static readonly string[] ViewTypeOptions = { "Plans and sections", "3D", "Sheets", "Schedules" };

        /// <summary>The factory defaults, as the pane shows them.</summary>
        public static readonly IReadOnlyDictionary<string, string> Defaults = new Dictionary<string, string>
        {
            [SelectWith] = "Long press", [Tap] = "Nothing", [TwoFingerTap] = "Right-click menu", [DoubleTap] = "Zoom to fit",
            [Drag3D] = "Orbit", [Drag2D] = "Pan", [Zoom] = "Normal", [Orbit] = "Normal", [InvertZoom] = "false",
            [NewViews] = "Off", [ViewTypes] = "Plans and sections|3D|Sheets", [Frame] = "true", [Ring] = "true", [Badge] = "false",
        };

        /// <summary>Speed words for the engine's multipliers.</summary>
        public static double SpeedValue(string word) => word == "Gentle" ? 0.6 : word == "Fast" ? 1.6 : 1.0;
        public static string SpeedWord(double value) => value < 0.8 ? "Gentle" : value > 1.3 ? "Fast" : "Normal";
    }

    /// <summary>Lets the ordinary setting rows (switches, segmented choices, chips) read and write touch settings.</summary>
    public sealed class TouchSettingsStore : IUserSettings
    {
        private readonly ITouchService _touch;
        public TouchSettingsStore(ITouchService touch) { _touch = touch; }

        public const string MasterKey = "master";

        public string? Get(string key) => key == MasterKey ? (_touch.MasterOn ? "true" : "false") : _touch.Get(key);

        public void Set(string key, string? value)
        {
            if (value == null) return;
            if (key == MasterKey) _touch.SetMaster(value == "true");
            else _touch.Set(key, value);
        }

        public bool IsPartOn(string partId) => true;
        public void SetPart(string partId, bool on) { }
        public event EventHandler? Changed { add { } remove { } }
    }

    /// <summary>Sample touch for the preview app and tests: the views and values on board flow/PaneFlowTouch.</summary>
    public sealed class MockTouchService : ITouchService
    {
        private readonly Dictionary<string, string> _values = TouchKeys.Defaults.ToDictionary(kv => kv.Key, kv => kv.Value);
        private List<TouchView> _views = new List<TouchView>
        {
            new TouchView(1, "Level 1 - GA Plan", "Plan", true, true, true),
            new TouchView(2, "{3D} Coordination", "3D", true, false, true),
            new TouchView(3, "A-101 - Ground Floor", "Sheet", true, false, false),
            new TouchView(4, "Level 2 - GA Plan", "Plan", false, false, false),
            new TouchView(5, "Section 1 - North", "Section", false, false, false),
        };

        public bool Available { get; set; } = true;
        public string Problem { get; set; } = "";
        public bool MasterOn { get; private set; } = true;
        public IReadOnlyList<TouchView> Views => _views;
        public int ProbeOpened { get; private set; }
        public event EventHandler? Changed;

        public void SetMaster(bool on) { MasterOn = on; Raise(); }

        public void SetView(long id, bool on)
        {
            _views = _views.Select(v => v.Id == id ? new TouchView(v.Id, v.Name, v.Type, v.OnScreen, v.IsActive, on) : v).ToList();
            Raise();
        }

        public void SetAllViews(bool on)
        {
            _views = _views.Select(v => new TouchView(v.Id, v.Name, v.Type, v.OnScreen, v.IsActive, on)).ToList();
            Raise();
        }

        public string? Get(string key) => _values.TryGetValue(key, out var v) ? v : null;
        public void Set(string key, string value) { _values[key] = value; Raise(); }

        public void ResetToDefaults()
        {
            foreach (var kv in TouchKeys.Defaults) _values[kv.Key] = kv.Value;
            Raise();
        }

        public void OpenProbe() => ProbeOpened++;

        private void Raise() => Changed?.Invoke(this, EventArgs.Empty);
    }
}
