using System;
using System.Runtime.InteropServices;
using System.Threading;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// F-022: keeps Revit's message loop awake while an MCP command waits for its external event.
    /// ExternalEvent.Raise only runs when Revit's UI thread next goes idle, and a Revit that gets no input (the person is
    /// working in another app) can wait a long time for that. While a command is in flight this posts WM_NULL to Revit's
    /// main window every 100 ms and asks Idling to fire again without delay, so the event runs in the background. With no
    /// command in flight it does nothing, so an idle Revit costs no CPU.
    /// F-064: while a command is in flight it also tells Windows the system is in use (every 30 s), so the PC doesn't go to
    /// sleep in the middle of a long job (an overnight batch was cut off by sleep on 17-18 Oct). The screen may still turn off.
    /// </summary>
    public static class RevitWake
    {
        private const uint WM_NULL = 0x0000;
        private static IntPtr _mainWindow = IntPtr.Zero;
        private static int _inFlight;
        private static Timer _timer;
        private static bool _hooked;

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        private const uint ES_SYSTEM_REQUIRED = 0x00000001;
        [DllImport("kernel32.dll")]
        private static extern uint SetThreadExecutionState(uint esFlags);
        private static long _lastAwakeTicks;

        /// <summary>Call once on the UI thread (OnStartup or the socket service's Initialize).</summary>
        public static void Initialize(UIApplication uiApp)
        {
            try { _mainWindow = uiApp.MainWindowHandle; } catch { _mainWindow = IntPtr.Zero; }
            if (_hooked) return;
            try { uiApp.Idling += OnIdling; _hooked = true; } catch { /* waking is best effort; commands still run on the next input */ }
            if (_timer == null) _timer = new Timer(_ => Poke(), null, Timeout.Infinite, Timeout.Infinite);
        }

        public static int InFlight => Volatile.Read(ref _inFlight);

        /// <summary>Wrap a command: using (RevitWake.Busy()) { ... }.</summary>
        public static IDisposable Busy()
        {
            if (Interlocked.Increment(ref _inFlight) == 1) _timer?.Change(0, 100);
            Poke();
            return new Token();
        }

        private static void Done()
        {
            if (Interlocked.Decrement(ref _inFlight) <= 0)
            {
                Interlocked.Exchange(ref _inFlight, 0);
                _timer?.Change(Timeout.Infinite, Timeout.Infinite);
            }
        }

        private static void Poke()
        {
            if (InFlight <= 0) return;
            if (_mainWindow != IntPtr.Zero)
            {
                try { PostMessage(_mainWindow, WM_NULL, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
            KeepSystemAwake();
        }

        /// <summary>Resets Windows' sleep timer, at most every 30 s (any thread may call it; it holds no state).</summary>
        public static void KeepSystemAwake()
        {
            // F75: a Revit the unattended test runner started never holds the PC awake (it pauses with the PC instead)
            if (UnattendedMode.NoKeepAwake) return;
            long now = DateTime.UtcNow.Ticks, last = Interlocked.Read(ref _lastAwakeTicks);
            if (now - last < TimeSpan.TicksPerSecond * 30) return;
            Interlocked.Exchange(ref _lastAwakeTicks, now);
            try { SetThreadExecutionState(ES_SYSTEM_REQUIRED); } catch { /* best effort */ }
        }

        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            if (InFlight > 0) e.SetRaiseWithoutDelay();
        }

        private sealed class Token : IDisposable
        {
            private int _disposed;
            public void Dispose() { if (Interlocked.Exchange(ref _disposed, 1) == 0) Done(); }
        }
    }
}
