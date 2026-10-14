using System.Collections.Generic;

namespace TouchKit.Core.Settings
{
    /// <summary>
    /// Which views have touch switched on, remembered per project on this computer.
    /// Key = project key (central model path for workshared models, otherwise file path or title).
    /// </summary>
    public sealed class ViewTouchStates
    {
        public Dictionary<string, Dictionary<long, bool>> Projects { get; set; } = new();

        public bool? Get(string projectKey, long viewId) =>
            Projects.TryGetValue(projectKey, out var views) && views.TryGetValue(viewId, out bool on) ? on : null;

        public void Set(string projectKey, long viewId, bool on)
        {
            if (!Projects.TryGetValue(projectKey, out var views))
            {
                views = new Dictionary<long, bool>();
                Projects[projectKey] = views;
            }
            views[viewId] = on;
        }

        public void ClearProject(string projectKey) => Projects.Remove(projectKey);
    }
}
