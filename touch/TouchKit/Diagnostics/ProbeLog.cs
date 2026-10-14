using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using TouchKit.Input;

namespace TouchKit.Diagnostics
{
    /// <summary>
    /// Collects input events for the Touch Probe. Called from the hook on Revit's UI thread, so it only
    /// appends to memory; the window pulls changes on a timer.
    /// </summary>
    public sealed class ProbeLog
    {
        private const int MaxLines = 3000;

        private readonly object _gate = new();
        private readonly LinkedList<string> _events = new();
        private readonly Dictionary<string, int> _counts = new();
        private readonly Dictionary<uint, double> _lastMoveLogged = new();
        private long _total;
        private long _blocked;

        /// <summary>Include WM_POINTERUPDATE / WM_MOUSEMOVE in the line log (they are always counted).</summary>
        public bool LogMoves { get; set; }

        /// <summary>Pause collection without uninstalling the hook.</summary>
        public bool Paused { get; set; }

        /// <summary>Bumped on every change so the UI knows when to redraw.</summary>
        public long Revision { get; private set; }

        public void Add(InputEvent e)
        {
            if (Paused) return;

            lock (_gate)
            {
                _total++;
                if (e.Swallowed) _blocked++;

                string key = $"{e.Source,-6} {e.Message,-22} -> {e.WindowClass,-28} {Where(e)}";
                _counts[key] = _counts.TryGetValue(key, out int c) ? c + 1 : 1;

                if (e.IsMoveLike)
                {
                    if (!LogMoves) { Revision++; return; }

                    // Even with moves on, keep at most one line per pointer every 40 ms so the log stays readable.
                    if (_lastMoveLogged.TryGetValue(e.PointerId, out double last) && e.TimeMs - last < 40)
                    {
                        Revision++;
                        return;
                    }
                    _lastMoveLogged[e.PointerId] = e.TimeMs;
                }

                Append(e.ToString());
            }
        }

        /// <summary>Insert a labelled divider, e.g. "TEST A - one-finger tap in floor plan".</summary>
        public void AddMarker(string label)
        {
            lock (_gate)
            {
                Append($"---------- {label} ----------");
            }
        }

        private void Append(string line)
        {
            _events.AddLast(line);
            while (_events.Count > MaxLines) _events.RemoveFirst();
            Revision++;
        }

        public void Clear()
        {
            lock (_gate)
            {
                _events.Clear();
                _counts.Clear();
                _lastMoveLogged.Clear();
                _total = 0;
                _blocked = 0;
                Revision++;
            }
        }

        public List<string> RecentLines(int max)
        {
            lock (_gate)
            {
                return _events.Skip(Math.Max(0, _events.Count - max)).ToList();
            }
        }

        public string Summary()
        {
            lock (_gate)
            {
                var sb = new StringBuilder();
                sb.AppendLine($"Messages seen: {_total:N0}    blocked: {_blocked:N0}");
                foreach (var pair in _counts.OrderByDescending(p => p.Value))
                {
                    sb.AppendLine($"{pair.Value,8:N0}  {pair.Key}");
                }
                return sb.ToString();
            }
        }

        public string BuildReport(string environment, IEnumerable<ViewRegion> regions)
        {
            var sb = new StringBuilder();
            sb.AppendLine("Formcraft Flow - touch probe report");
            sb.AppendLine($"Saved: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            sb.AppendLine();
            sb.AppendLine("== Environment ==");
            sb.AppendLine(environment);
            sb.AppendLine();
            sb.AppendLine("== Open views (screen pixels, * = active) ==");
            foreach (ViewRegion r in regions) sb.AppendLine(r.ToString());
            sb.AppendLine();
            sb.AppendLine("== Summary (count, source, message -> window class, where) ==");
            sb.AppendLine(Summary());
            sb.AppendLine("== Event log ==");
            sb.AppendLine("    time ms  source   message                id    (    x,    y)  flags                    window class                 where");
            lock (_gate)
            {
                foreach (string line in _events) sb.AppendLine(line);
            }
            return sb.ToString();
        }

        private static string Where(InputEvent e) =>
            e.View is not null ? $"in {e.View.Kind}" : e.InRevitMainWindow ? "outside views" : "other window";
    }
}
