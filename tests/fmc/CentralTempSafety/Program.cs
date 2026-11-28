using System;
using System.IO;
using RevitMCPCommandSet.Services.Fmc;

// Exit 0 when IsSafeTempPath refuses the temp root itself and accepts only a local strict subfolder.
int failed = 0, total = 0;
void Check(string name, bool actual, bool expected)
{
    total++;
    if (actual != expected)
    {
        failed++;
        Console.WriteLine("FAIL " + name + ": expected " + expected + ", got " + actual);
    }
}

string root = FmcCentralPaths.TempRoot();
string sub = Path.Combine(root, "job", "a.rvt");
string trailing = root + Path.DirectorySeparatorChar;
string neighbour = root + "-evil" + Path.DirectorySeparatorChar + "a.rvt";
string outside = Path.Combine(Path.GetTempPath(), "fmc-central-temp-outside", "a.rvt");
string unc = @"\\srv\bim\t\a.rvt";

Check("IsUnder(root, root) still true (promote must keep treating the root as under itself)", FmcCentralPaths.IsUnder(root, root), true);
Check("IsUnder(sub, root)", FmcCentralPaths.IsUnder(sub, root), true);
Check("IsUnder(neighbour, root) is false", FmcCentralPaths.IsUnder(neighbour, root), false);
Check("IsSafeTempPath(root) is false: the root itself is refused", FmcCentralPaths.IsSafeTempPath(root), false);
Check("IsSafeTempPath(root with trailing slash) is false", FmcCentralPaths.IsSafeTempPath(trailing), false);
Check("IsSafeTempPath(strict subfolder) is true on a local disk", FmcCentralPaths.IsSafeTempPath(sub), true);
Check("IsSafeTempPath(neighbour) is false", FmcCentralPaths.IsSafeTempPath(neighbour), false);
Check("IsSafeTempPath(outside) is false", FmcCentralPaths.IsSafeTempPath(outside), false);
Check("IsSafeTempPath(UNC) is false", FmcCentralPaths.IsSafeTempPath(unc), false);
Check("IsUnc(UNC)", FmcCentralPaths.IsUnc(unc), true);
Check("Canonical(trailing slash) equals root", FmcCentralPaths.Canonical(trailing).Equals(FmcCentralPaths.Canonical(root), StringComparison.OrdinalIgnoreCase), true);

Console.WriteLine(total + " central temp-path cases, " + failed + " failed");
return failed == 0 ? 0 : 1;
