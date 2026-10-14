using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using TouchKit.Core.Settings;
using TouchKit.Input;

namespace TouchKit.Takeover
{
    /// <summary>
    /// Decides which views TouchKit "owns" for touch. Fast to query from the input hook (dictionary lookups only).
    /// State is remembered per project on this computer; nothing is written into the Revit model.
    /// </summary>
    internal sealed class TakeoverService
    {
        private readonly Func<TouchSettings> _settings;
        private readonly JsonFileStore<ViewTouchStates> _store;
        private readonly ViewTouchStates _saved;

        // Explicit choices for the current project this session (also mirrored into _saved when remembering).
        private readonly Dictionary<long, bool> _current = new();
        private string? _projectKey;

        public TakeoverService(Func<TouchSettings> settings, string storePath)
        {
            _settings = settings;
            _store = new JsonFileStore<ViewTouchStates>(storePath);
            _saved = _store.Load();
        }

        /// <summary>Master switch. Always starts on; turning it off makes TouchKit ignore touch everywhere.</summary>
        public bool MasterOn { get; private set; } = true;

        /// <summary>Bumped whenever anything changes, so overlays know to redraw.</summary>
        public int Version { get; private set; }

        public string? ProjectKey => _projectKey;

        public event Action? Changed;

        public bool IsOn(ViewRegion view) => MasterOn && IsOnIgnoringMaster(view);

        public bool IsOnIgnoringMaster(ViewRegion view)
        {
            if (_current.TryGetValue(view.ViewId, out bool explicitState)) return explicitState;
            return DefaultFor(view.Kind);
        }

        public void SetMaster(bool on)
        {
            if (MasterOn == on) return;
            MasterOn = on;
            Bump();
        }

        public void Toggle(ViewRegion view) => Set(view.ViewId, !IsOnIgnoringMaster(view));

        public void Set(long viewId, bool on)
        {
            _current[viewId] = on;
            if (_settings().RememberPerView && _projectKey is not null)
            {
                _saved.Set(_projectKey, viewId, on);
                _store.Save(_saved);
            }
            Bump();
        }

        /// <summary>Call in API context when the active document may have changed.</summary>
        public void UpdateProject(Document? doc)
        {
            string? key = doc is null ? null : ProjectKeyOf(doc);
            if (key == _projectKey) return;

            _projectKey = key;
            _current.Clear();
            if (key is not null && _settings().RememberPerView && _saved.Projects.TryGetValue(key, out var views))
            {
                foreach (var pair in views) _current[pair.Key] = pair.Value;
            }
            Bump();
        }

        /// <summary>Settings changed (defaults may have changed) - redraw.</summary>
        public void Refresh() => Bump();

        private bool DefaultFor(ViewKind kind)
        {
            TouchSettings s = _settings();
            return s.NewViewDefault switch
            {
                NewViewTouchDefault.On => true,
                NewViewTouchDefault.ByViewType => kind switch
                {
                    ViewKind.Model3D => s.DefaultOn3D,
                    ViewKind.Model2D => s.DefaultOn2D,
                    ViewKind.Sheet => s.DefaultOnSheets,
                    ViewKind.Schedule => s.DefaultOnSchedules,
                    _ => false,
                },
                _ => false,
            };
        }

        private void Bump()
        {
            Version++;
            Changed?.Invoke();
        }

        /// <summary>
        /// A stable name for "this project" on this computer. Workshared local copies change name per user and
        /// per day, so for those we use the central model path; otherwise the file path, or the title if unsaved.
        /// </summary>
        private static string ProjectKeyOf(Document doc)
        {
            try
            {
                if (doc.IsWorkshared)
                {
                    ModelPath central = doc.GetWorksharingCentralModelPath();
                    if (central is not null)
                    {
                        string centralPath = ModelPathUtils.ConvertModelPathToUserVisiblePath(central);
                        if (!string.IsNullOrWhiteSpace(centralPath)) return "central:" + centralPath;
                    }
                }
            }
            catch
            {
                // Fall through to path/title.
            }

            if (!string.IsNullOrWhiteSpace(doc.PathName)) return "file:" + doc.PathName;
            return "title:" + doc.Title;
        }
    }
}
