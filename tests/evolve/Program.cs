using System;
using System.Collections.Generic;
using RevitMCPCommandSet.Services.Fmc;

internal static class Program
{
    static int _failed, _passed;

    static int Main()
    {
        UnnamedPlanes();
        AxisOfNormals();
        RoundingMatchesTheServer();
        BindDecisions();
        TempNamesAreFree();
        Console.WriteLine($"fmc evolve rules: {_passed} passed, {_failed} failed");
        return _failed > 0 ? 1 : 0;
    }

    static void UnnamedPlanes()
    {
        True(FmcEvolveRules.IsUnnamedPlane(""), "blank");
        True(FmcEvolveRules.IsUnnamedPlane(null), "null");
        True(FmcEvolveRules.IsUnnamedPlane("Reference Plane"), "default name");
        True(FmcEvolveRules.IsUnnamedPlane("  reference plane "), "default name, any case");
        True(!FmcEvolveRules.IsUnnamedPlane("Head"), "named");
        True(!FmcEvolveRules.IsUnnamedPlane("Reference Plane 2"), "a name that starts like the default");
    }

    static void AxisOfNormals()
    {
        Eq(FmcEvolveRules.AxisOf(1, 0, 0), "x", "+x");
        Eq(FmcEvolveRules.AxisOf(-1, 0, 0), "x", "-x");
        Eq(FmcEvolveRules.AxisOf(0, 1, 0), "y", "+y");
        Eq(FmcEvolveRules.AxisOf(0, 0, -1), "z", "-z");
        Eq(FmcEvolveRules.AxisOf(0.9999999999, 0.0000001, 0), "x", "within tolerance");
        Eq(FmcEvolveRules.AxisOf(Math.Sqrt(0.5), Math.Sqrt(0.5), 0), "", "45 degrees");
        Eq(FmcEvolveRules.AxisOf(double.NaN, 0, 1), "", "NaN");
    }

    static void RoundingMatchesTheServer()
    {
        // the server rounds with Math.round(v * 10) / 10 (half up); positions are reported the same way
        Eq(FmcEvolveRules.Round1(450.05).ToString(System.Globalization.CultureInfo.InvariantCulture), "450.1", "half up");
        Eq(FmcEvolveRules.Round1(-120.46).ToString(System.Globalization.CultureInfo.InvariantCulture), "-120.5", "negative");
        Eq(FmcEvolveRules.Round1(2100).ToString(System.Globalization.CultureInfo.InvariantCulture), "2100", "whole");
    }

    static void BindDecisions()
    {
        Eq(FmcEvolveRules.Bind(true, true, true), FmcEvolveRules.BindAction.Skip, "already bound");
        Eq(FmcEvolveRules.Bind(true, false, false), FmcEvolveRules.BindAction.Skip, "kit GUID present");
        Eq(FmcEvolveRules.Bind(false, false, false), FmcEvolveRules.BindAction.RefuseMissing, "missing: add_shared_param adds it");
        Eq(FmcEvolveRules.Bind(false, true, true), FmcEvolveRules.BindAction.RefuseOtherGuid, "another GUID: a person decides");
        Eq(FmcEvolveRules.Bind(false, true, false), FmcEvolveRules.BindAction.Replace, "a family parameter is replaced");
    }

    static void TempNamesAreFree()
    {
        Eq(FmcEvolveRules.TempName("FMC_Asset_Tag", _ => false), "FMC_Asset_Tag (fmc evolve)", "free");
        var taken = new HashSet<string> { "FMC_Asset_Tag (fmc evolve)", "FMC_Asset_Tag (fmc evolve) 2" };
        Eq(FmcEvolveRules.TempName("FMC_Asset_Tag", taken.Contains), "FMC_Asset_Tag (fmc evolve) 3", "next free");
        bool threw = false;
        try { FmcEvolveRules.TempName("X", _ => true); } catch (InvalidOperationException) { threw = true; }
        True(threw, "no free name throws");
    }

    static void True(bool ok, string what) { if (ok) _passed++; else { _failed++; Console.Error.WriteLine("FAIL " + what); } }
    static void Eq<T>(T got, T want, string what) => True(EqualityComparer<T>.Default.Equals(got, want), $"{what}: got {got}, want {want}");
}
