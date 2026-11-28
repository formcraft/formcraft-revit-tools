using System;
using System.Diagnostics;
using System.Threading;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;

namespace RevitMCPCommandSet
{
    /// <summary>
    /// Ogala night report: a save or a sync holds Revit 40-60 s, and calls sent meanwhile timed out although Revit runs
    /// them once it is free (a write then ran after its caller had given up). Every handler's wait goes through
    /// <see cref="Wait"/>: while Revit saves or syncs (and a few seconds after) the clock stops, so the call waits its
    /// turn instead of failing. A save never holds a call more than <see cref="MaxPauseMs"/>.
    /// </summary>
    public static class FmcBusy
    {
        public const int MaxPauseMs = 15 * 60 * 1000;
        private const int GraceMs = 5000;
        private static bool _hooked;
        private static int _depth;
        private static long _graceUntil;
        private static string _what = "";

        /// <summary>True while Revit is saving or syncing a model (or has just finished).</summary>
        public static bool Busy => Volatile.Read(ref _depth) > 0 || Environment.TickCount64 < Interlocked.Read(ref _graceUntil);

        /// <summary>What Revit is busy with ("saving Ogala"), "" when it isn't.</summary>
        public static string What => Busy ? _what : "";

        /// <summary>Call on Revit's API thread (any handler's Execute): listens to saves and syncs from then on.</summary>
        public static void Hook(UIApplication app)
        {
            if (_hooked || app == null) return;
            try
            {
                var a = app.Application;
                a.DocumentSaving += (s, e) => Start("saving " + e.Document?.Title);
                a.DocumentSaved += (s, e) => Stop();
                a.DocumentSavingAs += (s, e) => Start("saving " + e.Document?.Title);
                a.DocumentSavedAs += (s, e) => Stop();
                a.DocumentSynchronizingWithCentral += (s, e) => Start("syncing " + e.Document?.Title);
                a.DocumentSynchronizedWithCentral += (s, e) => Stop();
                _hooked = true;
            }
            catch (Exception) { /* without the hooks calls keep their plain timeouts */ }
        }

        private static void Start(string what) { _what = what ?? ""; Interlocked.Increment(ref _depth); }

        private static void Stop()
        {
            if (Interlocked.Decrement(ref _depth) < 0) Interlocked.Exchange(ref _depth, 0);
            Interlocked.Exchange(ref _graceUntil, Environment.TickCount64 + GraceMs);
        }

        /// <summary>Waits for the handle like WaitOne(timeoutMs), but time Revit spends saving or syncing doesn't count.</summary>
        public static bool Wait(WaitHandle handle, int timeoutMs)
        {
            var clock = Stopwatch.StartNew();
            long paused = 0, last = 0;
            while (true)
            {
                long left = timeoutMs - (clock.ElapsedMilliseconds - paused);
                if (handle.WaitOne(Busy ? 250 : (int)Math.Max(0, Math.Min(250, left)))) return true;
                long now = clock.ElapsedMilliseconds, step = now - last;
                last = now;
                if (Busy) { paused += step; if (paused > MaxPauseMs) return false; continue; }
                if (now - paused >= timeoutMs) return false;
            }
        }
    }
}
