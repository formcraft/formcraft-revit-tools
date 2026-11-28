using System;
using RevitMCPCommandSet.Services.Fmc;

// fmc_generate_bind's dashed Legend Back: add_subcategory line_pattern picks the closest pattern the family has.
internal static class Program
{
    static int _failed, _passed;

    static void Main()
    {
        var metricDoor = new[] { "Dash", "Dash 1/16\"", "Dash dot", "Hidden 1/8\"", "Center 1/4\"", "Dot 1/16\"" };
        var hiddenOnly = new[] { "Hidden 1/8\"", "Hidden", "Centerline" };
        var none = new[] { "Grid Line", "Aligning Line" };

        Eq(FmcLinePatternPick.Pick("Dash", metricDoor), "Dash", "exact name wins");
        Eq(FmcLinePatternPick.Pick("dash", metricDoor), "Dash", "case does not matter");
        Eq(FmcLinePatternPick.Pick("Dash 1/16\"", metricDoor), "Dash 1/16\"", "exact long name");
        Eq(FmcLinePatternPick.Pick("Hidden", metricDoor), "Hidden 1/8\"", "shortest name starting with the request");
        Eq(FmcLinePatternPick.Pick("Dash", hiddenOnly), "Hidden", "dash falls back to the hidden kin, shortest first");
        Eq(FmcLinePatternPick.Pick("Dashed", new[] { "Dash 1/8\"", "Dash dot 3/16\"" }), "Dash 1/8\"", "dashed finds dash");
        Eq(FmcLinePatternPick.Pick("Centre", hiddenOnly), "Centerline", "centre finds center");
        Eq(FmcLinePatternPick.Pick("Dash", none), null, "nothing like it: null, the caller keeps solid lines");
        Eq(FmcLinePatternPick.Pick("Solid", none), FmcLinePatternPick.Solid, "Solid is Revit's built-in solid line");
        Eq(FmcLinePatternPick.Pick("", metricDoor), null, "empty request: no change");
        Eq(FmcLinePatternPick.Pick("Dash", null), null, "no patterns at all");
        Eq(FmcLinePatternPick.Pick("Dash", new[] { "Dash", "Dash" }), "Dash", "duplicate names are fine");

        Console.WriteLine($"line pattern tests: {_passed} passed, {_failed} failed");
        if (_failed > 0) Environment.Exit(1);
    }

    static void Eq(string actual, string expected, string what)
    {
        if (actual == expected) { _passed++; return; }
        _failed++;
        Console.Error.WriteLine($"FAIL {what}: expected {expected ?? "null"}, got {actual ?? "null"}");
    }
}
