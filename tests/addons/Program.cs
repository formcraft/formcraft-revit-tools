using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using RevitMCPCommandSet.Bridge;

// Compile check for the saved add-ons and the bridge's transaction rule (tests/addons/AddonCompileCheck.csproj).
//   dotnet run --project tests/addons/AddonCompileCheck.csproj [-- <revit folder> <command set dll>]
// Exit 0: every check passed. 1: a check failed (listed). 2: Revit or the command set build is missing.
internal static class Program
{
    private static int _failed;

    private static int Main(string[] args)
    {
        string repo = FindRepo();
        string revit = args.Length > 0 ? args[0] : @"C:\Program Files\Autodesk\Revit 2025";
        string commandSet = args.Length > 1 ? args[1] : Path.Combine(repo, "commandset", "bin", "Release R25", "RevitMCPCommandSet.dll");
        foreach (string need in new[] { Path.Combine(revit, "RevitAPI.dll"), commandSet })
            if (!File.Exists(need)) { Console.Error.WriteLine($"Missing {need}"); return 2; }

        var references = new List<MetadataReference>();
        foreach (string tpa in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")).Split(Path.PathSeparator))
            references.Add(MetadataReference.CreateFromFile(tpa));
        foreach (string dll in new[] { Path.Combine(revit, "RevitAPI.dll"), Path.Combine(revit, "RevitAPIUI.dll"), commandSet,
                     Path.Combine(Path.GetDirectoryName(commandSet), "Newtonsoft.Json.dll") })
            references.Add(MetadataReference.CreateFromFile(dll));

        TransactionRule(references);

        string dir = Path.Combine(repo, "resources", "addons");
        foreach (string file in Directory.GetFiles(dir, "*.cs").OrderBy(f => f))
        {
            string code = File.ReadAllText(file);
            var usings = new List<string>(FmcScriptSource.DefaultUsings);
            Match m = Regex.Match(code, @"^//.*@usings\s+([^\r\n@]+)", RegexOptions.Multiline);
            if (m.Success) usings.AddRange(m.Groups[1].Value.Split(',').Select(u => u.Trim()).Where(u => u.Length > 0));
            string name = Path.GetFileName(file);
            if (!code.Contains("FmcScript.Params(parameters)")) Fail(name, "doesn't read its parameters with FmcScript.Params(parameters)");
            if (Regex.IsMatch(code, @"^//\s*@addon.*@writes\s+model", RegexOptions.Multiline) && !code.Contains("FmcScript.Tx("))
                Fail(name, "writes the model but doesn't use FmcScript.Tx");
            List<string> errors = Compile(code, usings, references, out int unguarded);
            if (unguarded > 0) Fail(name, $"{unguarded} transaction(s) not in a using");
            foreach (string e in errors) Fail(name, e);
            if (unguarded == 0 && errors.Count == 0) Console.WriteLine($"ok    {name} compiles as the bridge compiles it");
        }
        Console.WriteLine(_failed == 0 ? "All checks passed" : $"{_failed} check(s) failed");
        return _failed == 0 ? 0 : 1;
    }

    /// <summary>The bridge's own steps: wrapper, transaction rule, tracking, compile. Errors carry script lines.</summary>
    private static List<string> Compile(string code, List<string> usings, List<MetadataReference> references, out int unguarded)
    {
        SyntaxTree tree = FmcScriptSource.Parse(FmcScriptSource.Build(code, usings));
        unguarded = FmcScriptSource.UnguardedTransactions(tree).Count;
        tree = FmcScriptSource.AddTracking(tree);
        tree = FmcScriptSource.AddCancelChecks(tree);
        var compilation = CSharpCompilation.Create("AddonCheck_" + Guid.NewGuid().ToString("N"), new[] { tree }, references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        EmitResult emitted = compilation.Emit(ms);
        return emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d =>
        {
            FileLinePositionSpan span = d.Location.GetMappedLineSpan();
            string where = span.Path == FmcScriptSource.ScriptPath ? $"line {span.StartLinePosition.Line + 1}" : "template";
            return $"{where}: {d.Id} {d.GetMessage()}";
        }).ToList();
    }

    private static void TransactionRule(List<MetadataReference> references)
    {
        var cases = new (string code, int unguarded, int? line)[]
        {
            ("using (var t = new Transaction(document, \"a\")) { t.Start(); t.Commit(); }\nreturn null;", 0, null),
            ("using var g = new TransactionGroup(document, \"g\");\ng.Start(); g.Assimilate();\nreturn null;", 0, null),
            ("using (Autodesk.Revit.DB.SubTransaction st = new Autodesk.Revit.DB.SubTransaction(document)) { }\nreturn null;", 0, null),
            ("using (Transaction t = new(document, \"implicit\")) { }\nreturn null;", 0, null),
            ("int a = 1;\nvar t = new Transaction(document, \"leak\");\nt.Start();\nreturn null;", 1, 2),
            ("Transaction t = new(document, \"implicit leak\");\nreturn null;", 1, 1),
            ("var all = new List<object>();\nall.Add(new TransactionGroup(document));\nreturn null;", 1, 2),
            ("FmcScript.Tx(document, \"x\", true, () => { });\nreturn FmcScript.CopyOptionsUseDestinationTypes() != null && FmcScript.IsDryRun(parameters);", 0, null),
        };
        foreach (var (code, expected, line) in cases)
        {
            SyntaxTree tree = FmcScriptSource.Parse(FmcScriptSource.Build(code, FmcScriptSource.DefaultUsings));
            List<FmcScriptSource.TxUse> found = FmcScriptSource.UnguardedTransactions(tree);
            string first = code.Split('\n')[0];
            if (found.Count != expected) Fail("tx rule", $"{first}: {found.Count} unguarded, expected {expected}");
            else if (line.HasValue && found[0].Line != line) Fail("tx rule", $"{first}: line {found[0].Line}, expected {line}");
            List<string> errors = Compile(code, FmcScriptSource.DefaultUsings.ToList(), references, out _);
            foreach (string e in errors) Fail("tx rule", $"{first}: after tracking: {e}");
            if (found.Count == expected && errors.Count == 0) Console.WriteLine($"ok    tx rule: {first}");
        }
        string message = FmcScriptSource.UsingMessage(new[] { new FmcScriptSource.TxUse { Line = 2, Type = "Transaction", Code = "new Transaction(document, \"leak\")" } });
        if (!message.Contains("line 2") || !message.Contains("FmcScript.Tx")) Fail("tx rule", "the refusal names neither the line nor FmcScript.Tx");

        // Ogala night report: every loop gets a cancel check, and the script's line numbers stay
        string loops = "int n = 0;\nfor (int i = 0; i < 3; i++) n++;\nforeach (var x in new[] { 1 }) { n += x; }\nwhile (n < 9) n++;\ndo { n--; } while (n > 5);\nreturn n;";
        SyntaxTree checkedTree = FmcScriptSource.AddCancelChecks(FmcScriptSource.Parse(FmcScriptSource.Build(loops, FmcScriptSource.DefaultUsings)));
        int checks = Regex.Matches(checkedTree.ToString(), "FmcScript.CancelPoint").Count;
        var ret = checkedTree.GetRoot().DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax>().First();
        int retLine = ret.GetLocation().GetMappedLineSpan().StartLinePosition.Line + 1;
        List<string> loopErrors = Compile(loops, FmcScriptSource.DefaultUsings.ToList(), references, out _);
        if (checks != 4) Fail("cancel checks", $"{checks} cancel checks for 4 loops");
        else if (retLine != 6) Fail("cancel checks", $"the return moved from line 6 to {retLine}");
        else if (loopErrors.Count > 0) Fail("cancel checks", string.Join("; ", loopErrors));
        else Console.WriteLine("ok    cancel checks: one per loop, lines kept");
    }

    private static void Fail(string what, string why)
    {
        _failed++;
        Console.WriteLine($"FAIL  {what}: {why}");
    }

    private static string FindRepo()
    {
        string d = AppContext.BaseDirectory;
        while (d != null && !File.Exists(Path.Combine(d, "mcp-servers-for-revit.sln"))) d = Path.GetDirectoryName(d);
        return d ?? Directory.GetCurrentDirectory();
    }
}
