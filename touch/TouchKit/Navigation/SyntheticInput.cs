using System;
using System.Runtime.InteropServices;
using static TouchKit.Input.NativeMethods;

namespace TouchKit.Navigation
{
    /// <summary>
    /// Sends mouse and keyboard input to Revit as if it came from real hardware.
    ///
    /// Safety rules:
    ///  - every button/key we press is tracked, and <see cref="ReleaseAll"/> lets go of all of them
    ///  - ReleaseAll is called at the end of every gesture, on cancel, on errors and on shutdown
    ///  - everything we send carries <see cref="Signature"/> so our own hook can tell it apart from real input
    /// </summary>
    internal sealed class SyntheticInput
    {
        /// <summary>Marker in dwExtraInfo: "TKTK".</summary>
        public static readonly IntPtr Signature = new(0x544B544B);

        private static readonly int InputSize = Marshal.SizeOf<INPUT>();

        public bool MiddleHeld { get; private set; }
        public bool ShiftHeld { get; private set; }
        public bool AnythingHeld => MiddleHeld || ShiftHeld;

        /// <summary>Number of SendInput calls that Windows rejected (e.g. blocked by UIPI). For diagnostics.</summary>
        public int FailedSends { get; private set; }

        public void MoveTo(double x, double y) => SendMouse(MOUSEEVENTF_MOVE, x, y);

        public void MiddleDown(double x, double y)
        {
            SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_MIDDLEDOWN, x, y);
            MiddleHeld = true;
        }

        public void MiddleUp()
        {
            if (!MiddleHeld) return;
            SendMouseNoMove(MOUSEEVENTF_MIDDLEUP);
            MiddleHeld = false;
        }

        public void ShiftDown()
        {
            if (ShiftHeld) return;
            SendKey(VK_SHIFT, up: false);
            ShiftHeld = true;
        }

        public void ShiftUp()
        {
            if (!ShiftHeld) return;
            SendKey(VK_SHIFT, up: true);
            ShiftHeld = false;
        }

        public void LeftClick(double x, double y)
        {
            SendMouse(MOUSEEVENTF_MOVE, x, y);
            SendMouseNoMove(MOUSEEVENTF_LEFTDOWN);
            SendMouseNoMove(MOUSEEVENTF_LEFTUP);
        }

        public void RightClick(double x, double y)
        {
            SendMouse(MOUSEEVENTF_MOVE, x, y);
            SendMouseNoMove(MOUSEEVENTF_RIGHTDOWN);
            SendMouseNoMove(MOUSEEVENTF_RIGHTUP);
        }

        /// <summary>Positive notches zoom in (wheel away from you), negative zoom out.</summary>
        public void Wheel(double x, double y, int notches)
        {
            if (notches == 0) return;
            SendMouse(MOUSEEVENTF_MOVE, x, y);
            var input = MouseInput(MOUSEEVENTF_WHEEL, 0, 0);
            input.u.mi.mouseData = notches * WHEEL_DELTA;
            Send(input);
        }

        /// <summary>Let go of every button and key we pressed. Safe to call any time, any number of times.</summary>
        public void ReleaseAll()
        {
            if (MiddleHeld) { SendMouseNoMove(MOUSEEVENTF_MIDDLEUP); MiddleHeld = false; }
            if (ShiftHeld) { SendKey(VK_SHIFT, up: true); ShiftHeld = false; }
        }

        // ---- plumbing -----------------------------------------------------------------------------

        private void SendMouse(uint flags, double x, double y)
        {
            // Absolute coordinates are normalised 0..65535 across the whole virtual desktop (all monitors).
            int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int width = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1);
            int height = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1);

            int nx = (int)Math.Round((x - left) * 65535.0 / width);
            int ny = (int)Math.Round((y - top) * 65535.0 / height);

            Send(MouseInput(flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny));
        }

        private void SendMouseNoMove(uint flags) => Send(MouseInput(flags, 0, 0));

        private void SendKey(ushort vk, bool up)
        {
            var input = new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new InputUnion
                {
                    ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0, dwExtraInfo = Signature },
                },
            };
            Send(input);
        }

        private static INPUT MouseInput(uint flags, int dx, int dy) => new()
        {
            type = INPUT_MOUSE,
            u = new InputUnion
            {
                mi = new MOUSEINPUT { dx = dx, dy = dy, dwFlags = flags, dwExtraInfo = Signature },
            },
        };

        private void Send(INPUT input)
        {
            uint sent = SendInput(1, new[] { input }, InputSize);
            if (sent != 1) FailedSends++;
        }
    }
}
