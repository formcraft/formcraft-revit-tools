using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using static TouchKit.Input.NativeMethods;

namespace TouchKit.Input
{
    /// <summary>
    /// Observes (and optionally blocks) touch/pen input on Revit's UI thread.
    ///
    /// How it works: a WH_GETMESSAGE hook scoped to Revit's main thread sees every message the thread
    /// pulls from its queue *before* it is dispatched to a window. Windows only converts a finger into
    /// mouse clicks when the WM_POINTER message reaches DefWindowProc, so turning the message into
    /// WM_NULL here stops that conversion at the source. That is the key experiment of this phase.
    ///
    /// Rules this class must never break:
    ///  - never throw out of the callback (an exception here could take Revit down)
    ///  - never do slow work in the callback (it runs for every message Revit processes)
    ///  - only block input that lands inside a Revit view, in Revit's main window or a view window dragged out of it
    /// </summary>
    public sealed class PointerHook : IDisposable
    {
        private readonly ViewRegionTracker _views;
        private readonly Action<InputEvent> _sink;
        private readonly IntPtr _revitMainWindow;
        private readonly HookProc _callback;          // must stay referenced or the GC collects it -> crash
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly Dictionary<IntPtr, string> _classNames = new();
        private readonly StringBuilder _classBuffer = new(256);

        private IntPtr _hook = IntPtr.Zero;

        public PointerHook(ViewRegionTracker views, Action<InputEvent> sink, IntPtr revitMainWindow)
        {
            _views = views;
            _sink = sink;
            _revitMainWindow = revitMainWindow;
            _callback = Callback;
        }

        public bool IsInstalled => _hook != IntPtr.Zero;
        public uint ThreadId { get; private set; }
        public int LastInstallError { get; private set; }

        /// <summary>When true, touch input that lands on a Revit view is blocked before Revit sees it.</summary>
        public bool BlockTouchInViews { get; set; }

        /// <summary>Same as above but for pen. Off by default; pen will later drive markups.</summary>
        public bool BlockPenInViews { get; set; }

        /// <summary>Touch navigation. When set, fingers on views that touch has taken over go here instead of Revit.</summary>
        internal TouchRouter? Router { get; set; }

        /// <summary>Must be called on Revit's main (UI) thread, e.g. from IExternalApplication.OnStartup.</summary>
        public bool Install()
        {
            if (IsInstalled) return true;
            ThreadId = GetCurrentThreadId();
            _hook = SetWindowsHookExW(WH_GETMESSAGE, _callback, IntPtr.Zero, ThreadId);
            LastInstallError = _hook == IntPtr.Zero ? System.Runtime.InteropServices.Marshal.GetLastWin32Error() : 0;
            return IsInstalled;
        }

        public void Dispose()
        {
            if (_hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
            }
        }

        private unsafe IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            // Only act when the message is actually being removed from the queue (i.e. about to be dispatched).
            if (nCode >= 0 && (long)wParam == PM_REMOVE && lParam != IntPtr.Zero)
            {
                try
                {
                    MSG* msg = (MSG*)lParam;
                    if (IsInteresting(msg->message) && TryDescribe(ref *msg, out InputEvent? evt, out bool block))
                    {
                        if (block)
                        {
                            msg->message = WM_NULL;   // swallow: Revit (and DefWindowProc) never see it
                        }
                        _sink(evt!);
                    }
                }
                catch
                {
                    // Deliberately silent. See class remarks.
                }
            }

            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private static bool IsInteresting(uint m) =>
            (m >= WM_POINTERUPDATE && m <= WM_POINTERHWHEEL) ||
            m == WM_TOUCH || m == WM_GESTURE ||
            (m >= WM_MOUSEMOVE && m <= WM_MOUSEHWHEEL);

        private bool TryDescribe(ref MSG msg, out InputEvent? evt, out bool block)
        {
            evt = null;
            block = false;

            InputKind kind;
            InputSource source;
            uint pointerId = 0;
            uint rawFlags = 0;
            int x, y;
            string flags = "";

            if (msg.message >= WM_POINTERUPDATE && msg.message <= WM_POINTERHWHEEL)
            {
                kind = InputKind.Pointer;
                pointerId = LoWord(msg.wParam);
                source = GetPointerType(pointerId, out uint type) ? MapPointerType(type) : InputSource.Unknown;

                if (source == InputSource.Mouse) return false; // plain mouse via pointer API: not our business

                // For pointer messages lParam holds screen coordinates.
                x = SignedLoWord(msg.lParam);
                y = SignedHiWord(msg.lParam);
                rawFlags = HiWord(msg.wParam);
                flags = DescribePointerFlags(rawFlags);
            }
            else if (msg.message == WM_TOUCH || msg.message == WM_GESTURE)
            {
                kind = msg.message == WM_TOUCH ? InputKind.LegacyTouch : InputKind.Gesture;
                source = InputSource.Touch;
                x = msg.pt.X;
                y = msg.pt.Y;
            }
            else
            {
                // Mouse message: only interesting when Windows synthesised it from touch or pen.
                long extra = (long)GetMessageExtraInfo();
                if ((extra & SIGNATURE_MASK) != MI_WP_SIGNATURE) return false;

                kind = InputKind.PromotedMouse;
                source = (extra & MI_TOUCH_FLAG) != 0 ? InputSource.Touch : InputSource.Pen;
                x = msg.pt.X;   // msg.pt is always screen coordinates
                y = msg.pt.Y;
            }

            // The view may sit in Revit's main window or in a window of its own (a view tab dragged out, Revit 2022+).
            long root = GetAncestor(msg.hwnd, GA_ROOT).ToInt64();
            bool inMain = root == _revitMainWindow.ToInt64() || _views.IsViewWindow(root);
            ViewRegion? view = inMain ? _views.HitTest(x, y, root) : null;

            bool blockThisSource =
                (source == InputSource.Touch && BlockTouchInViews) ||
                (source == InputSource.Pen && BlockPenInViews);

            // 1) Touch navigation: does TouchKit own this finger?
            bool claimed = false;
            if (Router is not null && source == InputSource.Touch)
            {
                if (kind == InputKind.Pointer)
                    claimed = Router.TryClaim(msg.message, pointerId, rawFlags, x, y, view);
                else if (kind == InputKind.PromotedMouse)
                    claimed = Router.ShouldBlockPromotedMouse(view);
            }

            // 2) Probe testing switch: block everything of this device on views.
            bool probeBlock = blockThisSource && view is not null &&
                              (kind == InputKind.Pointer || kind == InputKind.PromotedMouse);

            block = claimed || probeBlock;

            evt = new InputEvent(
                _clock.Elapsed.TotalMilliseconds,
                kind,
                MessageName(msg.message),
                source,
                pointerId,
                x, y,
                flags,
                ClassNameOf(msg.hwnd),
                inMain,
                view,
                block);
            return true;
        }

        private string ClassNameOf(IntPtr hwnd)
        {
            if (_classNames.TryGetValue(hwnd, out string? name)) return name;
            if (_classNames.Count > 512) _classNames.Clear(); // windows come and go; keep the cache bounded

            _classBuffer.Clear();
            int len = GetClassNameW(hwnd, _classBuffer, _classBuffer.Capacity);
            name = len > 0 ? _classBuffer.ToString() : "?";
            _classNames[hwnd] = name;
            return name;
        }

        private static InputSource MapPointerType(uint type) => type switch
        {
            PT_TOUCH => InputSource.Touch,
            PT_PEN => InputSource.Pen,
            PT_MOUSE => InputSource.Mouse,
            PT_TOUCHPAD => InputSource.Touchpad,
            _ => InputSource.Unknown,
        };

        private static string DescribePointerFlags(uint f)
        {
            var sb = new StringBuilder();
            if ((f & POINTER_MESSAGE_FLAG_NEW) != 0) sb.Append("new ");
            if ((f & POINTER_MESSAGE_FLAG_INRANGE) != 0) sb.Append("range ");
            if ((f & POINTER_MESSAGE_FLAG_INCONTACT) != 0) sb.Append("contact ");
            if ((f & POINTER_MESSAGE_FLAG_PRIMARY) != 0) sb.Append("primary ");
            if ((f & POINTER_MESSAGE_FLAG_FIRSTBUTTON) != 0) sb.Append("btn1 ");
            return sb.ToString().TrimEnd();
        }

        public static string MessageName(uint m) => m switch
        {
            WM_POINTERUPDATE => "WM_POINTERUPDATE",
            WM_POINTERDOWN => "WM_POINTERDOWN",
            WM_POINTERUP => "WM_POINTERUP",
            WM_POINTERENTER => "WM_POINTERENTER",
            WM_POINTERLEAVE => "WM_POINTERLEAVE",
            WM_POINTERACTIVATE => "WM_POINTERACTIVATE",
            WM_POINTERCAPTURECHANGED => "WM_POINTERCAPTURECHANGED",
            WM_POINTERWHEEL => "WM_POINTERWHEEL",
            WM_POINTERHWHEEL => "WM_POINTERHWHEEL",
            WM_TOUCH => "WM_TOUCH",
            WM_GESTURE => "WM_GESTURE",
            WM_MOUSEMOVE => "WM_MOUSEMOVE",
            WM_LBUTTONDOWN => "WM_LBUTTONDOWN",
            WM_LBUTTONUP => "WM_LBUTTONUP",
            WM_LBUTTONDBLCLK => "WM_LBUTTONDBLCLK",
            WM_RBUTTONDOWN => "WM_RBUTTONDOWN",
            WM_RBUTTONUP => "WM_RBUTTONUP",
            WM_RBUTTONDBLCLK => "WM_RBUTTONDBLCLK",
            WM_MBUTTONDOWN => "WM_MBUTTONDOWN",
            WM_MBUTTONUP => "WM_MBUTTONUP",
            WM_MBUTTONDBLCLK => "WM_MBUTTONDBLCLK",
            WM_MOUSEWHEEL => "WM_MOUSEWHEEL",
            WM_MOUSEHWHEEL => "WM_MOUSEHWHEEL",
            _ => $"0x{m:X4}",
        };
    }
}
