using System;

namespace Formcraft.Shell.Services
{
    /// <summary>"Keep FMC data filled" on the open model, as Settings › Manage shows it (docs/LIVE_DATA.md).</summary>
    public sealed class LiveDataState
    {
        public LiveDataState(string model, bool applies, bool on, string by = "", string at = "", string why = "", int filledThisSession = 0)
        {
            Model = model;
            Applies = applies;
            On = on;
            By = by;
            At = at;
            Why = why;
            FilledThisSession = filledThisSession;
        }

        /// <summary>The open model's name, or "" when none is open.</summary>
        public string Model { get; }
        /// <summary>A project model the switch can be set on (not a family, a link or nothing).</summary>
        public bool Applies { get; }
        public bool On { get; }
        public string By { get; }
        public string At { get; }
        /// <summary>Why the switch doesn't apply here, in plain words.</summary>
        public string Why { get; }
        public int FilledThisSession { get; }

        public static LiveDataState NoModel => new LiveDataState("", false, false, why: "Open a project model to see its setting.");
    }

    /// <summary>
    /// The per-project switch for "Keep FMC data filled": in Revit the add-in supplies it (the setting lives in the model,
    /// on Project Information); the preview and tests use <see cref="MockLiveDataService"/>. The BIM Manager sets it from
    /// the pane; Claude has no tool that does.
    /// </summary>
    public interface ILiveDataService
    {
        LiveDataState Current { get; }

        /// <summary>Sets the switch on the open model (one Undo; never saves or syncs). <paramref name="done"/> gets the outcome.</summary>
        void SetOn(bool on, Action<string> done);

        /// <summary>The log of every value filled: timestamp, model, element id, field, old, new.</summary>
        string LogPath { get; }

        event EventHandler? Changed;
    }

    /// <summary>Sample for the preview app and tests: a project model with the switch off.</summary>
    public sealed class MockLiveDataService : ILiveDataService
    {
        public LiveDataState Current { get; private set; } = new LiveDataState("F26001-FMC-ZZ-ZZ-M3-E-0001", true, false);
        public string LogPath => @"%APPDATA%\Formcraft\FMC_LiveData_Log.csv";
        public event EventHandler? Changed;

        public void SetOn(bool on, Action<string> done)
        {
            Current = new LiveDataState(Current.Model, true, on, on ? "BIM Manager" : "", on ? DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") : "");
            Changed?.Invoke(this, EventArgs.Empty);
            done(on ? "Keep FMC data filled is on for this project (sample)." : "Keep FMC data filled is off for this project (sample).");
        }

        /// <summary>Tests: another model, or none.</summary>
        public void Show(LiveDataState state)
        {
            Current = state;
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
