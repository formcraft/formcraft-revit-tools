using System;
using System.Collections.Generic;
using System.Linq;
using RevitMCPCommandSet.Services.Fmc;

// Stand-in for Autodesk.Revit.DB.BuiltInCategory (same shape: named members with negative values).
enum FakeCategory { INVALID = -1, OST_Walls = -2000011, OST_Doors = -2000023, OST_Floors = -2000032 }

static class Program
{
    static int _pass, _fail;

    static void Check(string name, bool ok, string detail = "")
    {
        if (ok) { _pass++; Console.WriteLine("PASS " + name); }
        else { _fail++; Console.WriteLine("FAIL " + name + (detail.Length > 0 ? " :: " + detail : "")); }
    }

    static bool Throws(Action a, out string message)
    {
        try { a(); message = null; return false; }
        catch (ArgumentException e) { message = e.Message; return true; }
    }

    static int Main()
    {
        // VE-4 / MQ-3: exact BuiltInCategory names pass.
        var ok = FmcReadShape.RequireKnownNames<FakeCategory>("t", new[] { "OST_Walls", "OST_Doors" });
        Check("known names parse", ok.Parsed.Count == 2 && ok.Unknown.Count == 0);
        Check("applied names listed", ok.Applied.SequenceEqual(new[] { "OST_Walls", "OST_Doors" }));

        // VE-5(2) / MQ-4(1): a friendly name is refused, not an unfiltered read.
        string msg;
        Check("'Walls' refused", Throws(() => FmcReadShape.RequireKnownNames<FakeCategory>("get_material_quantities", new[] { "Walls" }), out msg));
        Check("refusal has code", msg != null && msg.StartsWith("[FMC-BAD-CATEGORY]"), msg ?? "");
        Check("refusal names the token", msg != null && msg.Contains("\"Walls\""), msg ?? "");
        Check("refusal names the tool", msg != null && msg.Contains("get_material_quantities"), msg ?? "");

        // MQ-4(2): a mixed list refuses and names only the bad token.
        Check("mixed list refused", Throws(() => FmcReadShape.RequireKnownNames<FakeCategory>("t", new[] { "OST_Walls", "Walls" }), out msg));
        Check("mixed list names only bad token", msg != null && msg.Contains("name(s) \"Walls\"."), msg ?? "");

        // Numeric strings parse with Enum.TryParse but are not names: refused.
        var num = FmcReadShape.SplitEnumNames<FakeCategory>(new[] { "-2000011", "5" });
        Check("numeric strings unknown", num.Parsed.Count == 0 && num.Unknown.Count == 2);

        // Case-sensitive: 'ost_walls' is not a BuiltInCategory name.
        var lower = FmcReadShape.SplitEnumNames<FakeCategory>(new[] { "ost_walls" });
        Check("wrong case unknown", lower.Parsed.Count == 0 && lower.Unknown.Count == 1);

        // Blank and null tokens are unknown, not ignored.
        var blank = FmcReadShape.SplitEnumNames<FakeCategory>(new[] { "", null, "  " });
        Check("blank tokens unknown", blank.Parsed.Count == 0 && blank.Unknown.Count >= 2);

        // Whitespace around a real name is trimmed.
        var trimmed = FmcReadShape.SplitEnumNames<FakeCategory>(new[] { " OST_Floors " });
        Check("trimmed name parses", trimmed.Parsed.Count == 1 && trimmed.Parsed[0] == FakeCategory.OST_Floors);

        // Duplicates kept once.
        var dup = FmcReadShape.SplitEnumNames<FakeCategory>(new[] { "OST_Walls", "OST_Walls" });
        Check("duplicates kept once", dup.Parsed.Count == 1);

        // Null list: nothing requested, nothing refused.
        var none = FmcReadShape.SplitEnumNames<FakeCategory>(null);
        Check("null list empty split", none.Parsed.Count == 0 && none.Unknown.Count == 0);

        // GSE-3 / GSE-4: count is the full selection, truncated when the cap hides items.
        var seven = Enumerable.Range(1, 7).ToList();
        var p = FmcReadShape.Cap(seven, 5);
        Check("cap: count is full total", p.Count == 7);
        Check("cap: truncated true", p.Truncated);
        Check("cap: items capped", p.Items.Count == 5 && p.Limit == 5);
        var q = FmcReadShape.Cap(seven, 7);
        Check("cap: exact fit not truncated", !q.Truncated && q.Items.Count == 7);
        var d = FmcReadShape.Cap(Enumerable.Range(1, 150).ToList(), null);
        Check("cap: default 100", d.Limit == 100 && d.Items.Count == 100 && d.Truncated && d.Count == 150);
        var z = FmcReadShape.Cap(seven, 0);
        Check("cap: 0 means default", z.Limit == 100 && !z.Truncated);
        var e = FmcReadShape.Cap(new List<int>(), 5);
        Check("cap: empty selection", e.Count == 0 && !e.Truncated && e.Items.Count == 0);

        Console.WriteLine($"ReadShape tests: {_pass} passed, {_fail} failed");
        return _fail == 0 ? 0 : 1;
    }
}
