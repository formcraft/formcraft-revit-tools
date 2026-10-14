using System;
using System.Collections.Concurrent;
using System.Linq;
using Autodesk.Revit.UI;

namespace TouchKit.Navigation
{
    /// <summary>
    /// Runs work that needs the Revit API (zoom to fit, view changes) from places that are not in API context,
    /// such as the input hook. Work is queued and Revit runs it as soon as it is idle.
    /// Create on Revit's UI thread during OnStartup.
    /// </summary>
    internal sealed class RevitActionQueue : IExternalEventHandler
    {
        private readonly ConcurrentQueue<Action<UIApplication>> _work = new();
        private readonly ExternalEvent _event;

        public RevitActionQueue()
        {
            _event = ExternalEvent.Create(this);
        }

        public string? LastError { get; private set; }

        public void Enqueue(Action<UIApplication> action)
        {
            _work.Enqueue(action);
            _event.Raise();
        }

        public void Execute(UIApplication app)
        {
            while (_work.TryDequeue(out Action<UIApplication>? action))
            {
                try { action(app); }
                catch (Exception ex) { LastError = ex.Message; }
            }
        }

        public string GetName() => "Formcraft Flow touch";

        /// <summary>Zoom the given open view to fit its contents.</summary>
        public void ZoomToFit(long viewId) => Enqueue(app =>
        {
            UIView? view = app.ActiveUIDocument?.GetOpenUIViews().FirstOrDefault(v => v.ViewId.Value == viewId);
            view?.ZoomToFit();
        });
    }
}
