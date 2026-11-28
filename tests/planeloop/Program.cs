using System;
using System.Linq;
using RevitMCPCommandSet.Services.Fmc;

// G011: the add-in's own checks on plane loops (extrusion outline_planes, revolution profile_planes), without Revit.
internal static class Program
{
    static int _failed, _passed;

    static void Main()
    {
        var l = new[] { new[] { "Left", "Front" }, new[] { "Right", "Front" }, new[] { "Right", "Mid" }, new[] { "Notch", "Mid" }, new[] { "Notch", "Back" }, new[] { "Left", "Back" } };
        var (along, problems) = FmcPlaneLoopMath.Along(l);
        Eq(problems.Count, 0, "an L loop has no problems");
        Eq(string.Join(",", along), "Front,Right,Mid,Notch,Back,Left", "each edge runs along the plane its corners share");
        Eq(FmcPlaneLoopMath.Normalize(l.Concat(new[] { new[] { "Front", "Left" } }).ToList()).Count, 6, "a closing repeat of the first corner is dropped");
        Eq(FmcPlaneLoopMath.Along(l.Take(2).ToList()).Problems.Any(p => p.Contains("three corners")), true, "two corners aren't a loop");
        Eq(FmcPlaneLoopMath.Along(new[] { new[] { "Left", "Front" }, new[] { "Right", "Back" }, new[] { "Left", "Back" } }).Problems.Any(p => p.Contains("share exactly one plane")), true, "neighbours on no shared plane");
        Eq(FmcPlaneLoopMath.Along(new[] { new[] { "Left", "Left" }, new[] { "Left", "Back" }, new[] { "Right", "Back" } }).Problems.Any(p => p.Contains("names one plane twice")), true, "a corner naming one plane twice");
        Eq(FmcPlaneLoopMath.Along(new[] { new[] { "Left", "Front" }, new[] { "Notch", "Front" }, new[] { "Right", "Front" }, new[] { "Right", "Back" }, new[] { "Left", "Back" } }).Problems.Any(p => p.Contains("both run along Front")), true, "a corner in the middle of an edge");

        // x = 100, y = -300, z = 50
        var p = FmcPlaneLoopMath.Cross3(new double[] { 1, 0, 0 }, 100, new double[] { 0, 2, 0 }, -600, new double[] { 0, 0, 1 }, 50);
        Eq(p != null && Math.Abs(p[0] - 100) < 1e-9 && Math.Abs(p[1] + 300) < 1e-9 && Math.Abs(p[2] - 50) < 1e-9, true, "three planes meet at one point");
        Eq(FmcPlaneLoopMath.Cross3(new double[] { 1, 0, 0 }, 0, new double[] { 2, 0, 0 }, 5, new double[] { 0, 0, 1 }, 0) == null, true, "parallel planes: no point");
        Eq(FmcPlaneLoopMath.Area2(new[] { new double[] { 0, 0 }, new double[] { 10, 0 }, new double[] { 10, 5 }, new double[] { 0, 5 } }), 100.0, "twice the area, counter-clockwise positive");
        Eq(FmcPlaneLoopMath.Area2(new[] { new double[] { 0, 0 }, new double[] { 10, 0 }, new double[] { 20, 0 } }), 0.0, "a flat loop has no area");

        Console.WriteLine($"plane loop tests: {_passed} passed, {_failed} failed");
        if (_failed > 0) Environment.Exit(1);
    }

    static void Eq<T>(T actual, T expected, string what)
    {
        if (Equals(actual, expected)) { _passed++; return; }
        _failed++;
        Console.WriteLine($"FAIL {what}: expected {expected}, got {actual}");
    }
}
