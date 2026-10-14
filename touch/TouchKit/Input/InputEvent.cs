namespace TouchKit.Input
{
    /// <summary>Which physical device produced the input.</summary>
    public enum InputSource
    {
        Unknown,
        Touch,
        Pen,
        Mouse,
        Touchpad,
    }

    /// <summary>Which family of Windows message carried it.</summary>
    public enum InputKind
    {
        /// <summary>WM_POINTER* - the modern, raw touch/pen stream (what we ultimately want to own).</summary>
        Pointer,
        /// <summary>WM_TOUCH - legacy multi-touch, only produced if a window registered for it.</summary>
        LegacyTouch,
        /// <summary>WM_GESTURE - Windows' own built-in gesture recogniser output.</summary>
        Gesture,
        /// <summary>WM_*BUTTON* / WM_MOUSEMOVE that Windows synthesised from a finger or pen.</summary>
        PromotedMouse,
    }

    /// <summary>One observed input message, as seen on Revit's UI thread.</summary>
    public sealed record InputEvent(
        double TimeMs,
        InputKind Kind,
        string Message,
        InputSource Source,
        uint PointerId,
        int X,
        int Y,
        string Flags,
        string WindowClass,
        bool InRevitMainWindow,
        ViewRegion? View,
        bool Swallowed)
    {
        /// <summary>True for high-frequency "move" style messages that we collapse in the live log.</summary>
        public bool IsMoveLike => Message is "WM_POINTERUPDATE" or "WM_MOUSEMOVE";

        public override string ToString()
        {
            string where = View is null
                ? (InRevitMainWindow ? "outside views" : "other window")
                : $"{View.Kind} '{View.ViewName}'";
            string id = Kind == InputKind.Pointer ? $"#{PointerId}" : "";
            string swallowed = Swallowed ? "  [BLOCKED]" : "";
            return $"{TimeMs,9:F1}  {Source,-8} {Message,-22} {id,-5} ({X,5},{Y,5})  {Flags,-24} {WindowClass,-28} {where}{swallowed}";
        }
    }
}
