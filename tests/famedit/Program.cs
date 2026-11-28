using System;
using System.Collections.Generic;
using System.Linq;
using RevitMCPCommandSet.Services.Fmc;

internal static class Program
{
    static int _failed, _passed;

    static int Main()
    {
        DeleteOps();
        PersonApproval();
        OriginPlanes();
        Renames();
        FlexValues();
        LastType();
        Formulas();
        Console.WriteLine($"fmc famedit rules: {_passed} passed, {_failed} failed");
        return _failed > 0 ? 1 : 0;
    }

    static void DeleteOps()
    {
        True(FmcFamEditRules.IsDeleteOp("param_remove") && FmcFamEditRules.IsDeleteOp("type_delete") && FmcFamEditRules.IsDeleteOp("plane_delete"), "the three deletes");
        True(!FmcFamEditRules.IsDeleteOp("param_rename") && !FmcFamEditRules.IsDeleteOp("delete_template_element") && !FmcFamEditRules.IsDeleteOp(null), "not deletes");
        True(FmcFamEditRules.Ops.Length == 11 && FmcFamEditRules.DeleteOps.All(FmcFamEditRules.Handles), "11 ops, deletes among them");
        True(FmcFamEditRules.Handles("type_flex_matrix") && !FmcFamEditRules.Handles("set_formula"), "handles only its own ops");
    }

    static void PersonApproval()
    {
        True(FmcFamEditRules.PersonApproved("approved", "USER"), "a person in the pane");
        True(!FmcFamEditRules.PersonApproved("approved", "auto-approved (testing)"), "testing auto-approve never counts");
        True(!FmcFamEditRules.PersonApproved("approved", " "), "nobody named");
        True(!FmcFamEditRules.PersonApproved("pending", "USER"), "pending");
        True(!FmcFamEditRules.PersonApproved("used", "USER"), "already used");
        True(!FmcFamEditRules.PersonApproved("rejected", "USER"), "rejected");
        True(!FmcFamEditRules.PersonApproved("Approved", "USER"), "exact status only");
    }

    static void OriginPlanes()
    {
        True(FmcFamEditRules.IsOriginPlaneName("Center (Left/Right)") && FmcFamEditRules.IsOriginPlaneName(" Center (Front/Back) ") && FmcFamEditRules.IsOriginPlaneName("Ref. Level"), "origin planes");
        True(!FmcFamEditRules.IsOriginPlaneName("Left") && !FmcFamEditRules.IsOriginPlaneName(null), "other planes");
    }

    static void Renames()
    {
        var names = new[] { "Width", "Depth", "Height" };
        True(FmcFamEditRules.RenameProblem("Width", "Overall Width", names) == null, "a free name");
        True(FmcFamEditRules.RenameProblem("Width", "depth", names)?.Contains("already used") == true, "clash, any case");
        True(FmcFamEditRules.RenameProblem("Width", "WIDTH", names) == null, "a case change of itself is fine");
        True(FmcFamEditRules.RenameProblem("Width", "Width", names)?.Contains("same") == true, "same name");
        True(FmcFamEditRules.RenameProblem("Width", " ", names)?.Contains("blank") == true, "blank");
        True(FmcFamEditRules.RenameProblem("Width", "W:1", names)?.Contains("character") == true, "a character Revit refuses");
    }

    static void FlexValues()
    {
        Same(FmcFamEditRules.FlexValues(300, 900, 3), new List<double> { 300, 600, 900 }, "3 steps");
        Same(FmcFamEditRules.FlexValues(0, 1, 4), new List<double> { 0, 0.333, 0.667, 1 }, "rounded");
        True(FmcFamEditRules.FlexValues(1, 2, 99).Count == 6 && FmcFamEditRules.FlexValues(1, 2, 0).Count == 2, "clamped 2..6");
        bool threw = false;
        try { FmcFamEditRules.FlexValues(5, 5, 3); } catch (ArgumentException) { threw = true; }
        True(threw, "high must be above low");
    }

    static void LastType()
    {
        True(!FmcFamEditRules.CanDeleteType(1) && !FmcFamEditRules.CanDeleteType(0) && FmcFamEditRules.CanDeleteType(2), "never the last type");
    }

    static void Formulas()
    {
        var f = new Dictionary<string, string> { ["Width"] = "", ["Leaf Width"] = "", ["Half"] = "Width / 2", ["Leaf"] = "Leaf Width - 10", ["Widthy"] = "", ["X"] = "Widthy + 1", ["Self"] = "" };
        Same(FmcFamEditRules.FormulasUsing("Width", f), new List<string> { "Half" }, "whole names only, not Leaf Width or Widthy");
        Same(FmcFamEditRules.FormulasUsing("Leaf Width", f), new List<string> { "Leaf" }, "a name with a space");
        Same(FmcFamEditRules.FormulasUsing("Self", f), new List<string>(), "unused");
        Same(FmcFamEditRules.FormulasUsing("", f), new List<string>(), "blank");
    }

    static void True(bool ok, string what) { if (ok) _passed++; else { _failed++; Console.WriteLine("FAIL " + what); } }
    static void Same<T>(List<T> a, List<T> b, string what) => True(a.SequenceEqual(b), what + ": got [" + string.Join(", ", a) + "]");
}
