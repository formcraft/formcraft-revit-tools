using System;

namespace TouchKit.Core.Gestures
{
    /// <summary>A point in screen pixels.</summary>
    public readonly record struct Pt(double X, double Y)
    {
        public static Pt operator +(Pt a, Pt b) => new(a.X + b.X, a.Y + b.Y);
        public static Pt operator -(Pt a, Pt b) => new(a.X - b.X, a.Y - b.Y);
        public static Pt operator *(Pt a, double s) => new(a.X * s, a.Y * s);

        public double Length => Math.Sqrt(X * X + Y * Y);
        public static double Distance(Pt a, Pt b) => (a - b).Length;
        public static Pt Midpoint(Pt a, Pt b) => new((a.X + b.X) / 2, (a.Y + b.Y) / 2);

        public override string ToString() => $"({X:F0},{Y:F0})";
    }

    public enum PointerPhase
    {
        Down,
        Move,
        Up,
        /// <summary>Windows cancelled the contact (e.g. palm rejection, capture lost).</summary>
        Cancel,
    }

    /// <summary>One raw contact update, already filtered to "a finger on a view TouchKit owns".</summary>
    public readonly record struct PointerSample(uint Id, PointerPhase Phase, Pt Position, double TimeMs);
}
