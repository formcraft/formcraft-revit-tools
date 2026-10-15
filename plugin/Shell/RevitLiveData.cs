using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Formcraft.Shell.Services;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Settings › Manage › Keep FMC data filled in Revit (docs/LIVE_DATA.md): reads the open model's switch on idle and
    /// sets it when the BIM Manager presses Switch on/off in the pane (after the pane's own "are you sure"). The change is
    /// one Undo and is logged; nothing saves or syncs (rule 6). Claude has no tool that calls this.
    /// </summary>
    public sealed class RevitLiveData : ILiveDataService
    {
        private const string Title = "Formcraft: keep FMC data filled";
        private readonly ExternalEvent _event;
        private readonly Handler _handler;
        private string _key = "";
        private DateTime _lastRead = DateTime.MinValue;

        public RevitLiveData()
        {
            _handler = new Handler(this);
            _event = ExternalEvent.Create(_handler);
        }

        public LiveDataState Current { get; private set; } = LiveDataState.NoModel;
        public string LogPath => LiveDataLog.Path;
        public event EventHandler Changed;

        public void SetOn(bool on, Action<string> done)
        {
            _handler.On = on;
            _handler.Done = done;
            _event.Raise();
        }

        /// <summary>From ShellHost's idle check: re-reads the switch at most every two seconds, and at once on a new model.</summary>
        public void Update(Document doc, bool force = false)
        {
            string docKey = doc == null ? "" : doc.Title + "|" + doc.PathName;
            if (!force && docKey == _key.Split('#')[0] && (DateTime.UtcNow - _lastRead).TotalSeconds < 2) return;
            _lastRead = DateTime.UtcNow;

            LiveDataState state;
            if (doc == null) state = LiveDataState.NoModel;
            else if (doc.IsFamilyDocument) state = new LiveDataState(doc.Title, false, false, why: "Families don't use it: it runs in project models.");
            else
            {
                LiveDataSwitch.State s;
                try { s = LiveDataSwitch.Read(doc); }
                catch (Exception) { s = new LiveDataSwitch.State(); }
                state = new LiveDataState(doc.Title, true, s.Enabled, s.By, s.At, filledThisSession: LiveDataLog.FilledThisSession);
            }

            string key = docKey + "#" + state.Applies + state.On + state.By + state.At + state.FilledThisSession;
            if (key == _key) return;
            _key = key;
            Current = state;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        private sealed class Handler : IExternalEventHandler
        {
            private readonly RevitLiveData _owner;
            public bool On;
            public Action<string> Done;

            public Handler(RevitLiveData owner) { _owner = owner; }

            public void Execute(UIApplication app)
            {
                string message;
                Document doc = app.ActiveUIDocument?.Document;
                try
                {
                    bool before = doc != null && LiveDataSwitch.IsOn(doc);
                    string problem = LiveDataSwitch.Write(doc, On, app.Application.Username);
                    if (problem.Length > 0) message = "Keep FMC data filled wasn't changed: " + problem;
                    else
                    {
                        // The switch is logged like every other change the feature makes (no names: rule 9).
                        LiveDataLog.Append(new[]
                        {
                            LiveDataRules.LogLine(DateTime.Now, doc.Title, doc.ProjectInformation.Id.ToString(), "Keep FMC data filled",
                                before ? "on" : "off", On ? "on" : "off"),
                        }, filled: false);
                        message = On
                            ? "Keep FMC data filled is on for " + doc.Title + "." + (doc.IsWorkshared ? " Sync so the team gets it." : "")
                            : "Keep FMC data filled is off for " + doc.Title + ".";
                    }
                }
                catch (Exception e)
                {
                    message = "Keep FMC data filled wasn't changed: " + e.Message;
                }
                _owner.Update(doc, force: true);
                Done?.Invoke(message);
            }

            public string GetName() => Title;
        }
    }
}
