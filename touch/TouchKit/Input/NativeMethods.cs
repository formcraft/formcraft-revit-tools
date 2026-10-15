using System;
using System.Runtime.InteropServices;
using System.Text;

namespace TouchKit.Input
{
    /// <summary>Win32 interop used by the input layer. Kept in one place so it is easy to audit.</summary>
    internal static class NativeMethods
    {
        // ---- Hooks ---------------------------------------------------------------------------
        public const int WH_GETMESSAGE = 3;
        public const int PM_REMOVE = 0x0001;

        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        // ---- Messages ------------------------------------------------------------------------
        public const uint WM_NULL = 0x0000;
        public const uint WM_GESTURE = 0x0119;
        public const uint WM_TOUCH = 0x0240;

        public const uint WM_POINTERUPDATE = 0x0245;
        public const uint WM_POINTERDOWN = 0x0246;
        public const uint WM_POINTERUP = 0x0247;
        public const uint WM_POINTERENTER = 0x0249;
        public const uint WM_POINTERLEAVE = 0x024A;
        public const uint WM_POINTERACTIVATE = 0x024B;
        public const uint WM_POINTERCAPTURECHANGED = 0x024C;
        public const uint WM_POINTERWHEEL = 0x024E;
        public const uint WM_POINTERHWHEEL = 0x024F;

        public const uint WM_MOUSEMOVE = 0x0200;
        public const uint WM_LBUTTONDOWN = 0x0201;
        public const uint WM_LBUTTONUP = 0x0202;
        public const uint WM_LBUTTONDBLCLK = 0x0203;
        public const uint WM_RBUTTONDOWN = 0x0204;
        public const uint WM_RBUTTONUP = 0x0205;
        public const uint WM_RBUTTONDBLCLK = 0x0206;
        public const uint WM_MBUTTONDOWN = 0x0207;
        public const uint WM_MBUTTONUP = 0x0208;
        public const uint WM_MBUTTONDBLCLK = 0x0209;
        public const uint WM_MOUSEWHEEL = 0x020A;
        public const uint WM_MOUSEHWHEEL = 0x020E;

        // Pointer message flags (HIWORD of wParam)
        public const uint POINTER_MESSAGE_FLAG_NEW = 0x00000001;
        public const uint POINTER_MESSAGE_FLAG_INRANGE = 0x00000002;
        public const uint POINTER_MESSAGE_FLAG_INCONTACT = 0x00000004;
        public const uint POINTER_MESSAGE_FLAG_FIRSTBUTTON = 0x00000010;
        public const uint POINTER_MESSAGE_FLAG_PRIMARY = 0x00002000;

        // POINTER_INPUT_TYPE
        public const uint PT_POINTER = 1;
        public const uint PT_TOUCH = 2;
        public const uint PT_PEN = 3;
        public const uint PT_MOUSE = 4;
        public const uint PT_TOUCHPAD = 5;

        // Mouse messages synthesised by Windows from touch/pen carry this signature in GetMessageExtraInfo().
        public const long MI_WP_SIGNATURE = 0xFF515700;
        public const long SIGNATURE_MASK = 0xFFFFFF00;
        public const long MI_TOUCH_FLAG = 0x80;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
            public uint lPrivate;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetPointerType(uint pointerId, out uint pointerType);

        [DllImport("user32.dll")]
        public static extern IntPtr GetMessageExtraInfo();

        // ---- Windows -------------------------------------------------------------------------
        public const uint GA_ROOT = 2;

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool EnumThreadWindows(uint dwThreadId, EnumWindowsProc lpfn, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        // ---- System info ---------------------------------------------------------------------
        public const int SM_DIGITIZER = 94;
        public const int SM_MAXIMUMTOUCHES = 95;

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);

        public const uint POINTER_MESSAGE_FLAG_CANCELED = 0x00008000;

        // ---- Synthetic input (SendInput) -----------------------------------------------------
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const ushort VK_SHIFT = 0x10;
        public const int WHEEL_DELTA = 120;

        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public int mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        // ---- Overlay windows -----------------------------------------------------------------
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_TRANSPARENT = 0x00000020;
        public const long WS_EX_TOOLWINDOW = 0x00000080;
        public const long WS_EX_LAYERED = 0x00080000;
        public const long WS_EX_NOACTIVATE = 0x08000000;

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowEnabled(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsIconic(IntPtr hWnd);

        public static void AddExStyle(IntPtr hwnd, long flags)
        {
            long current = (long)GetWindowLongPtr(hwnd, GWL_EXSTYLE);
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(current | flags));
        }

        // ---- Helpers -------------------------------------------------------------------------
        public static ushort LoWord(IntPtr value) => (ushort)((long)value & 0xFFFF);
        public static ushort HiWord(IntPtr value) => (ushort)(((long)value >> 16) & 0xFFFF);
        public static short SignedLoWord(IntPtr value) => unchecked((short)LoWord(value));
        public static short SignedHiWord(IntPtr value) => unchecked((short)HiWord(value));
    }
}
