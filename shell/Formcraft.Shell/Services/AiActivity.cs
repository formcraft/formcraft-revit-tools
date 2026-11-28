using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace Formcraft.Shell.Services
{
    /// <summary>What an AI app connected over MCP is doing in this Revit, shown by the AI activity strip on the ribbon.</summary>
    public enum AiActivityKind { Idle, Reading, Waiting, Changing }

    /// <summary>
    /// Tracks the AI calls that reach this Revit (the add-in's socket) and says what the strip shows. The MCP server tags
    /// every call with _fmcActivity (server/src/fmc/policy.ts callActivity): "change" (a model-changing command),
    /// "dryrun" (a dry run of one), "read", or "person" (a person's click in the pane, never shown).
    /// Thread-safe: calls arrive on socket threads, the strip reads on the UI thread.
    /// <list type="bullet">
    /// <item>Changing while any change call runs; else Reading while any other call runs.</item>
    /// <item>Waiting after a dry run answers, until the next call starts or <see cref="WaitFor"/> passes.</item>
    /// <item>The last state stays for <see cref="Linger"/> after a call ends, so a run of short calls doesn't flicker.</item>
    /// </list>
    /// </summary>
    public sealed class AiActivityTracker
    {
        public static readonly TimeSpan Linger = TimeSpan.FromSeconds(2);
        public static readonly TimeSpan WaitFor = TimeSpan.FromMinutes(10);

        /// <summary>The one tracker the add-in's socket and the ribbon strip share.</summary>
        public static AiActivityTracker Shared { get; } = new AiActivityTracker();

        private readonly Func<DateTime> _now;
        private readonly object _lock = new object();
        private readonly Dictionary<long, AiActivityKind> _running = new Dictionary<long, AiActivityKind>();
        private long _next;
        private DateTime _waitingSince = DateTime.MinValue;
        private AiActivityKind _last = AiActivityKind.Idle;
        private DateTime _lastEnded = DateTime.MinValue;

        public AiActivityTracker(Func<DateTime>? now = null) { _now = now ?? (() => DateTime.UtcNow); }

        /// <summary>The _fmcActivity tag as a kind. A call with no tag (an older server) counts as reading.</summary>
        public static AiActivityKind KindOf(string? tag) =>
            string.Equals(tag, "change", StringComparison.OrdinalIgnoreCase) ? AiActivityKind.Changing : AiActivityKind.Reading;

        /// <summary>A call started. Dispose the result, or call <see cref="Call.End"/>, when it answers or fails.</summary>
        public Call Begin(string? tag)
        {
            // A person's own click in the pane (FMC_CALLER=pane on the server) is not AI work: not shown, waiting kept.
            if (string.Equals(tag, "person", StringComparison.OrdinalIgnoreCase)) return new Call(this, 0, false);
            var kind = KindOf(tag);
            bool dryRun = string.Equals(tag, "dryrun", StringComparison.OrdinalIgnoreCase);
            lock (_lock)
            {
                long id = ++_next;
                _running[id] = kind;
                _waitingSince = DateTime.MinValue;
                return new Call(this, id, dryRun);
            }
        }

        private void End(long id, bool dryRun, bool ok)
        {
            lock (_lock)
            {
                if (!_running.TryGetValue(id, out var kind)) return;
                _running.Remove(id);
                _last = kind;
                _lastEnded = _now();
                // A dry run that answered waits for the person's yes; one that failed waits for nothing.
                if (dryRun && ok && _running.Count == 0) _waitingSince = _lastEnded;
            }
        }

        /// <summary>Forget everything (the AI connection was switched off).</summary>
        public void Reset()
        {
            lock (_lock)
            {
                _running.Clear();
                _waitingSince = DateTime.MinValue;
                _last = AiActivityKind.Idle;
                _lastEnded = DateTime.MinValue;
            }
        }

        /// <summary>What the strip shows now.</summary>
        public AiActivityKind Current
        {
            get
            {
                lock (_lock)
                {
                    var now = _now();
                    if (_running.Count > 0)
                    {
                        foreach (var k in _running.Values)
                            if (k == AiActivityKind.Changing) return AiActivityKind.Changing;
                        return AiActivityKind.Reading;
                    }
                    if (_waitingSince != DateTime.MinValue)
                    {
                        if (now - _waitingSince < WaitFor) return AiActivityKind.Waiting;
                        _waitingSince = DateTime.MinValue;
                    }
                    if (_lastEnded != DateTime.MinValue && now - _lastEnded < Linger) return _last;
                    return AiActivityKind.Idle;
                }
            }
        }

        /// <summary>One AI call in flight.</summary>
        public sealed class Call : IDisposable
        {
            private readonly AiActivityTracker _owner;
            private readonly long _id;
            private readonly bool _dryRun;
            private int _ended;

            internal Call(AiActivityTracker owner, long id, bool dryRun)
            {
                _owner = owner;
                _id = id;
                _dryRun = dryRun;
            }

            public void End(bool ok)
            {
                if (Interlocked.Exchange(ref _ended, 1) == 1) return;
                _owner.End(_id, _dryRun, ok);
            }

            public void Dispose() => End(false);
        }
    }

    /// <summary>
    /// Settings › General › AI activity strip: the switch, a switch per state and a colour per state. Colours are theme
    /// tokens (docs/UI_KIT.md), so the strip matches the pane in Light and Dark.
    /// </summary>
    public static class AiStripSettings
    {
        public const string Key = "general.aistrip";

        /// <summary>The colours on offer: the name the person picks, and the theme colour it uses.</summary>
        public static readonly IReadOnlyList<(string Name, string Token)> Colours = new[]
        {
            ("Orange", "Fmc.Orange"), ("Amber", "Fmc.Warning"), ("Blue", "Fmc.Model"), ("Navy blue", "Fmc.Primary"),
            ("Teal", "Fmc.Flow"), ("Gold", "Fmc.Build"), ("Green", "Fmc.Good"), ("Red", "Fmc.Critical"),
        };

        public static readonly IReadOnlyList<string> ColourNames = Colours.Select(c => c.Name).ToArray();

        /// <summary>The states with their label and default colour, in the order the settings show them.</summary>
        public static readonly IReadOnlyList<(AiActivityKind Kind, string Id, string Label, string Colour)> States = new[]
        {
            (AiActivityKind.Changing, "changing", "AI is changing the model", "Orange"),
            (AiActivityKind.Waiting, "waiting", "AI is waiting for your yes", "Amber"),
            (AiActivityKind.Reading, "reading", "AI is reading or checking", "Blue"),
        };

        public static string OnKey(string id) => Key + "." + id;
        public static string ColourKey(string id) => Key + "." + id + ".colour";

        /// <summary>The theme colour token the strip shows for a state, or null for no strip (off, idle, or that state off).</summary>
        public static string? TokenFor(AiActivityKind kind, Func<string, string?> get)
        {
            if (kind == AiActivityKind.Idle || get(Key) == "false") return null;
            foreach (var s in States)
            {
                if (s.Kind != kind) continue;
                if (get(OnKey(s.Id)) == "false") return null;
                string name = get(ColourKey(s.Id)) ?? s.Colour;
                foreach (var c in Colours)
                    if (c.Name == name) return c.Token;
                foreach (var c in Colours)
                    if (c.Name == s.Colour) return c.Token;
            }
            return null;
        }
    }
}
