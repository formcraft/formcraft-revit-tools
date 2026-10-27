using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace RevitMCPCommandSet.Bridge
{
    /// <summary>
    /// The source side of send_code_to_revit (docs/BRIDGE.md, docs/ADDONS.md), with no Revit types so a test harness can
    /// compile scripts and saved add-ons exactly as the bridge does (tests/addons):
    /// <list type="bullet">
    /// <item><see cref="Build"/>: the wrapper around a script body (usings, <c>object Execute(Document document, object[] parameters)</c>,
    /// and a <c>#line 1 "script.cs"</c> so errors name the script's own lines).</item>
    /// <item><see cref="UnguardedTransactions"/> (KISIC §4.1, FMC-CODE-TX-USING): every <c>new Transaction(</c>,
    /// <c>new SubTransaction(</c> and <c>new TransactionGroup(</c> must be the subject of a <c>using</c>. A transaction
    /// left open after an exception crashed Revit on 19 Oct 2026 (Pure Virtual Function Call).</item>
    /// <item><see cref="AddTracking"/>: wraps each of those creations in <c>FmcScript.Track(...)</c>, so the bridge can roll
    /// back whatever a script leaves open (FMC-CODE-TX-LEAK). Line numbers are kept; columns on those lines shift.</item>
    /// </list>
    /// </summary>
    public static class FmcScriptSource
    {
        /// <summary>The file name the script's lines map to.</summary>
        public const string ScriptPath = "script.cs";

        /// <summary>Revit's transaction types (Autodesk.Revit.DB), matched by their last name.</summary>
        public static readonly string[] TransactionTypes = { "Transaction", "SubTransaction", "TransactionGroup" };

        /// <summary>Always in scope: the old template's namespaces, rooms and structure, and the Formcraft helpers.</summary>
        public static readonly string[] DefaultUsings =
        {
            "System", "System.Linq", "System.Collections.Generic", "System.Text",
            "Autodesk.Revit.DB", "Autodesk.Revit.DB.Architecture", "Autodesk.Revit.DB.Structure", "Autodesk.Revit.UI",
            "RevitMCPCommandSet.Bridge",
        };

        private const string TrackCall = "global::RevitMCPCommandSet.Bridge.FmcScript.Track";

        /// <summary>The script inside the bridge's template: usings, namespace, class, Execute, then the body at line 1.</summary>
        public static string Build(string code, IEnumerable<string> usings)
        {
            var source = new StringBuilder();
            foreach (string u in usings) source.Append("using ").Append(u).Append(";\n");
            source.Append("namespace AIGeneratedCode\n{\n    public static class CodeExecutor\n    {\n");
            source.Append("        public static object Execute(Document document, object[] parameters)\n        {\n");
            source.Append("#line 1 \"").Append(ScriptPath).Append("\"\n");
            source.Append(code).Append('\n');
            source.Append("#line default\n        }\n    }\n}\n");
            return source.ToString();
        }

        public static SyntaxTree Parse(string source) =>
            CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), new CSharpParseOptions(LanguageVersion.Latest), path: "template.cs");

        /// <summary>A transaction created outside a using: its script line (null when outside the script) and the code.</summary>
        public sealed class TxUse
        {
            public int? Line { get; set; }
            public string Type { get; set; }
            public string Code { get; set; }
        }

        /// <summary>Every transaction, sub-transaction or transaction group created anywhere but as the subject of a using.</summary>
        public static List<TxUse> UnguardedTransactions(SyntaxTree tree)
        {
            var found = new List<TxUse>();
            foreach (ExpressionSyntax creation in TransactionCreations(tree.GetRoot()))
            {
                if (InUsing(creation)) continue;
                FileLinePositionSpan span = creation.GetLocation().GetMappedLineSpan();
                string text = creation.ToString();
                found.Add(new TxUse
                {
                    Line = span.Path == ScriptPath ? span.StartLinePosition.Line + 1 : (int?)null,
                    Type = TransactionTypeOf(creation),
                    Code = text.Length > 80 ? text.Substring(0, 80) + "…" : text,
                });
            }
            return found;
        }

        /// <summary>The refusal text for <see cref="UnguardedTransactions"/>, naming each line.</summary>
        public static string UsingMessage(IReadOnlyList<TxUse> uses)
        {
            string where = string.Join("; ", uses.Take(5).Select(u => $"{(u.Line.HasValue ? "line " + u.Line : "template")}: {u.Code}"));
            return $"{uses.Count} transaction{(uses.Count == 1 ? " is" : "s are")} not in a using ({where}). A transaction left open " +
                   "after an error can crash Revit. Write `using (var t = new Transaction(document, \"name\")) { t.Start(); ... t.Commit(); }`, " +
                   "or use FmcScript.Tx(document, \"name\", dryRun, () => { ... }) (commits, rolls back on any exception, rolls back a dry run).";
        }

        /// <summary>The same tree with each transaction creation wrapped in FmcScript.Track(...). No new lines are added.</summary>
        public static SyntaxTree AddTracking(SyntaxTree tree)
        {
            SyntaxNode root = tree.GetRoot();
            List<ExpressionSyntax> creations = TransactionCreations(root).ToList();
            if (creations.Count == 0) return tree;
            // "current" already carries the rewrite of any creation nested in this one's arguments.
            SyntaxNode rewritten = root.ReplaceNodes(creations, (original, current) =>
            {
                string inner = current is ImplicitObjectCreationExpressionSyntax implicitNew
                    ? $"new {DeclaredType((ImplicitObjectCreationExpressionSyntax)original)}{implicitNew.ArgumentList.WithoutTrivia().ToFullString()}{implicitNew.Initializer?.WithoutTrivia().ToFullString() ?? ""}"
                    : current.WithoutTrivia().ToFullString();
                return SyntaxFactory.ParseExpression($"{TrackCall}({inner})").WithTriviaFrom(original);
            });
            return Parse(rewritten.ToFullString());
        }

        private const string CancelCall = "global::RevitMCPCommandSet.Bridge.FmcScript.CancelPoint();";

        /// <summary>
        /// Ogala night report (a cancelled script ran to its end): a cancel check at the top of every loop body. No new
        /// lines are added, so the script's line numbers stay.
        /// </summary>
        public static SyntaxTree AddCancelChecks(SyntaxTree tree)
        {
            SyntaxNode root = tree.GetRoot();
            SyntaxNode rewritten = new CancelChecks().Visit(root);
            return rewritten == root ? tree : Parse(rewritten.ToFullString());
        }

        private sealed class CancelChecks : CSharpSyntaxRewriter
        {
            private static StatementSyntax Guard(StatementSyntax body)
            {
                StatementSyntax check = SyntaxFactory.ParseStatement(CancelCall);
                if (body is BlockSyntax b) return b.WithStatements(b.Statements.Insert(0, check));
                return SyntaxFactory.Block(check, body.WithoutTrivia()).WithTriviaFrom(body);
            }

            public override SyntaxNode VisitForStatement(ForStatementSyntax node) { var n = (ForStatementSyntax)base.VisitForStatement(node); return n.WithStatement(Guard(n.Statement)); }
            public override SyntaxNode VisitForEachStatement(ForEachStatementSyntax node) { var n = (ForEachStatementSyntax)base.VisitForEachStatement(node); return n.WithStatement(Guard(n.Statement)); }
            public override SyntaxNode VisitForEachVariableStatement(ForEachVariableStatementSyntax node) { var n = (ForEachVariableStatementSyntax)base.VisitForEachVariableStatement(node); return n.WithStatement(Guard(n.Statement)); }
            public override SyntaxNode VisitWhileStatement(WhileStatementSyntax node) { var n = (WhileStatementSyntax)base.VisitWhileStatement(node); return n.WithStatement(Guard(n.Statement)); }
            public override SyntaxNode VisitDoStatement(DoStatementSyntax node) { var n = (DoStatementSyntax)base.VisitDoStatement(node); return n.WithStatement(Guard(n.Statement)); }
        }

        private static IEnumerable<ExpressionSyntax> TransactionCreations(SyntaxNode root)
        {
            foreach (SyntaxNode node in root.DescendantNodes())
            {
                if (node is ObjectCreationExpressionSyntax explicitNew && IsTransactionName(LastName(explicitNew.Type)))
                    yield return explicitNew;
                else if (node is ImplicitObjectCreationExpressionSyntax implicitNew && DeclaredType(implicitNew) != null)
                    yield return implicitNew;
            }
        }

        private static bool IsTransactionName(string name) => name != null && TransactionTypes.Contains(name, StringComparer.Ordinal);

        private static string LastName(TypeSyntax type)
        {
            switch (type)
            {
                case IdentifierNameSyntax i: return i.Identifier.ValueText;
                case QualifiedNameSyntax q: return q.Right.Identifier.ValueText;
                case AliasQualifiedNameSyntax a: return a.Name.Identifier.ValueText;
                default: return null;
            }
        }

        /// <summary>`Transaction t = new(...)`: the declared transaction type, else null.</summary>
        private static string DeclaredType(ImplicitObjectCreationExpressionSyntax creation)
        {
            if (creation.Parent is EqualsValueClauseSyntax eq && eq.Parent is VariableDeclaratorSyntax vd &&
                vd.Parent is VariableDeclarationSyntax decl && IsTransactionName(LastName(decl.Type)))
                return decl.Type.WithoutTrivia().ToFullString();
            return null;
        }

        private static string TransactionTypeOf(ExpressionSyntax creation) =>
            creation is ObjectCreationExpressionSyntax o ? LastName(o.Type) : LastName(((VariableDeclarationSyntax)creation.Parent.Parent.Parent).Type);

        private static bool InUsing(ExpressionSyntax creation)
        {
            SyntaxNode child = creation;
            SyntaxNode parent = creation.Parent;
            while (parent is ParenthesizedExpressionSyntax || parent is CastExpressionSyntax)
            {
                child = parent;
                parent = parent.Parent;
            }
            if (parent is UsingStatementSyntax statement && statement.Expression == child) return true;
            if (parent is EqualsValueClauseSyntax && parent.Parent is VariableDeclaratorSyntax && parent.Parent.Parent is VariableDeclarationSyntax decl)
            {
                if (decl.Parent is UsingStatementSyntax) return true;
                if (decl.Parent is LocalDeclarationStatementSyntax local && local.UsingKeyword.IsKind(SyntaxKind.UsingKeyword)) return true;
            }
            return false;
        }
    }
}
