using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPCommandSet.Services.Fmc;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Commands.ExecuteDynamicCode
{
    /// <summary>
    /// Runs send_code_to_revit's script on Revit's API thread (docs/BRIDGE.md).
    /// <list type="bullet">
    /// <item>The script is the body of <c>object Execute(Document document, object[] parameters)</c>; its line 1 is the
    /// first line sent, so compile errors and runtime errors name the script's own lines.</item>
    /// <item>Compile time and run time are reported apart (F-031). Exceptions are unwrapped from
    /// TargetInvocationException to the script's own exception: type, message and line (F-033).</item>
    /// <item>Errors carry stable codes in English (F-034): FMC-CODE-COMPILE, FMC-CODE-RUNTIME, FMC-CODE-ROLLED-BACK,
    /// FMC-CODE-CANCELLED, FMC-CODE-NO-DOCUMENT, FMC-CODE-USINGS, FMC-CODE-PARAMS, FMC-CODE-TOO-LARGE, FMC-CODE-BUSY,
    /// FMC-CODE-TIMEOUT.</item>
    /// <item>Optional <c>usings</c> (F-035); the helper types in RevitMCPCommandSet.Bridge are always available.</item>
    /// <item>transactionMode "auto" wraps the script in one transaction with the default failures preprocessor
    /// (warnings deleted and returned, errors roll back with their text: F-032).</item>
    /// </list>
    /// </summary>
    public class ExecuteCodeEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const string TransactionModeAuto = "auto";
        public const string TransactionModeNone = "none";
        private const string ScriptPath = "script.cs";

        /// <summary>Always there: the old template's namespaces, rooms and structure, and the Formcraft helpers.</summary>
        public static readonly string[] DefaultUsings =
        {
            "System", "System.Linq", "System.Collections.Generic", "System.Text",
            "Autodesk.Revit.DB", "Autodesk.Revit.DB.Architecture", "Autodesk.Revit.DB.Structure", "Autodesk.Revit.UI",
            "RevitMCPCommandSet.Bridge",
        };

        private static readonly Regex UsingPattern = new Regex(
            @"^(static\s+)?([A-Za-z_][A-Za-z0-9_]*\s*=\s*)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$", RegexOptions.CultureInvariant);

        private string _code;
        private object[] _executionParameters;
        private string _transactionMode = TransactionModeAuto;
        private string[] _usings = Array.Empty<string>();
        private JObject _parameters = new JObject();
        private readonly ConcurrentDictionary<string, ExecutionResultInfo> _results = new ConcurrentDictionary<string, ExecutionResultInfo>();
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private volatile bool _busy;

        /// <summary>True from the moment a script is handed over until Revit has run it.</summary>
        public bool Busy => _busy;

        /// <summary>The job id of the script handed over last.</summary>
        public string Job { get; private set; } = "";

        public void SetExecutionParameters(string code, object[] parameters, string transactionMode, string[] usings, string job, JObject allParameters)
        {
            _code = code;
            _executionParameters = parameters ?? Array.Empty<object>();
            _transactionMode = transactionMode == TransactionModeNone ? TransactionModeNone : TransactionModeAuto;
            _usings = usings ?? Array.Empty<string>();
            _parameters = allParameters ?? new JObject();
            Job = job ?? "";
            _parameters[FmcAiJob.JobParameter] = Job; // FmcTarget.Resolve continues the same job
            _busy = true;
            _resetEvent.Reset();
        }

        /// <summary>The finished result of a job (once).</summary>
        public ExecutionResultInfo TakeResult(string job) => _results.TryRemove(job ?? "", out var r) ? r : null;

        // Never resets here: SetExecutionParameters does, so a script that finishes before the wait starts is not missed.
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            string job = Job;
            var info = new ExecutionResultInfo { Job = job, TransactionMode = _transactionMode };
            var watch = Stopwatch.StartNew();
            try
            {
                FmcAiJob.Enter(app, job);
                Document doc;
                FmcTarget target;
                try
                {
                    // The call's document (title or path) when it names one, else the active one (F-025, #110): the
                    // live-model lock checked that same document before the server sent the script.
                    target = FmcTarget.Resolve(app, _parameters, mayOpen: false);
                    doc = target.Doc;
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex) { throw new ScriptFailure("FMC-CODE-NO-DOCUMENT", ex.Message); }

                using (target)
                {
                    info.Document = doc.Title;
                    CompiledScript script = Compile(_code, _usings, info);
                    FmcAiJob.ThrowIfCancelled();

                    var run = Stopwatch.StartNew();
                    object result;
                    try
                    {
                        if (_transactionMode == TransactionModeNone)
                        {
                            result = script.Invoke(doc, _executionParameters);
                            info.Transaction = "none (the script manages its own)";
                        }
                        else
                        {
                            using (var transaction = new Transaction(doc, "FMC: AI script"))
                            {
                                FmcAiJob.Failures.Attach(transaction);
                                transaction.Start();
                                result = script.Invoke(doc, _executionParameters);
                                if (FmcAiJob.CancelRequested(job))
                                {
                                    transaction.RollBack();
                                    throw new ScriptFailure("FMC-CODE-CANCELLED", $"Job {job} was cancelled while the script ran; its transaction was rolled back, nothing was changed.");
                                }
                                TransactionStatus status = transaction.Commit();
                                info.Transaction = status.ToString();
                                if (status != TransactionStatus.Committed)
                                    throw new ScriptFailure("FMC-CODE-ROLLED-BACK",
                                        "Revit rolled the script's transaction back, so nothing was changed: " +
                                        (FmcAiJob.Failures.Errors.Count > 0 ? string.Join(" | ", FmcAiJob.Failures.Errors) : $"status {status}."));
                            }
                        }
                    }
                    finally
                    {
                        info.RunMs = run.ElapsedMilliseconds;
                    }

                    info.Result = Serialize(result, info);
                    info.Success = true;
                }
            }
            catch (ScriptFailure f)
            {
                info.SetError(f.Code, f.Message, f.Detail);
            }
            catch (OperationCanceledException ex)
            {
                info.SetError("FMC-CODE-CANCELLED", ex.Message.Replace("FMC-JOB-CANCELLED: ", ""), null);
            }
            catch (Exception ex)
            {
                info.SetError("FMC-CODE-INTERNAL", $"{ex.GetType().Name}: {ex.Message}", null);
            }
            finally
            {
                info.TotalMs = watch.ElapsedMilliseconds;
                info.Warnings = new List<string>(FmcAiJob.Failures.Warnings);
                info.Failures = new List<string>(FmcAiJob.Failures.Errors);
                info.Dialogs = new JArray(FmcAiJob.Dialogs);
                FmcAiJob.Exit();
                _results[job] = info;
                _busy = false;
                _resetEvent.Set();
            }
        }

        // ---------------------------------------------------------------- compile and run

        private sealed class CompiledScript
        {
            public MethodInfo Method;
            public Assembly Assembly;

            public object Invoke(Document doc, object[] parameters)
            {
                try
                {
                    return Method.Invoke(null, new object[] { doc, parameters });
                }
                catch (Exception ex)
                {
                    Exception inner = Unwrap(ex);
                    if (inner is OperationCanceledException oce && (oce.Message ?? "").StartsWith("FMC-JOB-CANCELLED"))
                        throw new ScriptFailure("FMC-CODE-CANCELLED", oce.Message.Replace("FMC-JOB-CANCELLED: ", ""));
                    if (inner is ScriptFailure sf) throw sf;
                    int? line = ScriptLine(inner, Assembly);
                    var detail = new JObject
                    {
                        ["type"] = inner.GetType().FullName,
                        ["message"] = inner.Message,
                        ["line"] = line.HasValue ? (JToken)line.Value : JValue.CreateNull(),
                        ["stack"] = ScriptStack(inner, Assembly),
                    };
                    throw new ScriptFailure("FMC-CODE-RUNTIME",
                        $"{inner.GetType().Name}{(line.HasValue ? $" at line {line.Value}" : "")}: {inner.Message}", detail);
                }
            }
        }

        private static CompiledScript Compile(string code, string[] extraUsings, ExecutionResultInfo info)
        {
            var watch = Stopwatch.StartNew();
            try
            {
                var usings = new List<string>(DefaultUsings);
                foreach (string raw in extraUsings)
                {
                    string u = NormaliseUsing(raw);
                    if (u == null)
                        throw new ScriptFailure("FMC-CODE-USINGS", $"Not a namespace for 'usings': \"{raw}\". Use names like \"System.IO\", \"static System.Math\" or \"Arch = Autodesk.Revit.DB.Architecture\".");
                    if (!usings.Contains(u)) usings.Add(u);
                }

                var source = new StringBuilder();
                foreach (string u in usings) source.Append("using ").Append(u).Append(";\n");
                source.Append("namespace AIGeneratedCode\n{\n    public static class CodeExecutor\n    {\n");
                source.Append("        public static object Execute(Document document, object[] parameters)\n        {\n");
                source.Append("#line 1 \"").Append(ScriptPath).Append("\"\n");
                source.Append(code).Append('\n');
                source.Append("#line default\n        }\n    }\n}\n");

                SyntaxTree tree = CSharpSyntaxTree.ParseText(SourceText.From(source.ToString(), Encoding.UTF8),
                    new CSharpParseOptions(LanguageVersion.Latest), path: "template.cs");
                CSharpCompilation compilation = CSharpCompilation.Create(
                    "FmcScript_" + Guid.NewGuid().ToString("N"),
                    new[] { tree },
                    References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Debug));

                using (var ms = new MemoryStream())
                {
                    EmitResult emitted = compilation.Emit(ms, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.Embedded));
                    if (!emitted.Success)
                    {
                        var errors = new JArray();
                        foreach (Diagnostic d in emitted.Diagnostics.Where(x => x.Severity == DiagnosticSeverity.Error).Take(20))
                        {
                            FileLinePositionSpan span = d.Location.GetMappedLineSpan();
                            bool inScript = span.Path == ScriptPath;
                            errors.Add(new JObject
                            {
                                ["id"] = d.Id,
                                ["line"] = inScript ? (JToken)(span.StartLinePosition.Line + 1) : JValue.CreateNull(),
                                ["column"] = inScript ? (JToken)(span.StartLinePosition.Character + 1) : JValue.CreateNull(),
                                ["where"] = inScript ? "script" : "template (usings or the method around the script)",
                                ["message"] = d.GetMessage(),
                            });
                        }
                        string first = errors.Count > 0
                            ? $"{(errors[0]["line"].Type == JTokenType.Null ? "template" : "line " + errors[0]["line"])}: {errors[0]["id"]} {errors[0]["message"]}"
                            : "unknown error";
                        string hint = errors.Any(e => (string)e["id"] == "CS0161")
                            ? " The script must end with a return (return null; when there is nothing to return)." : "";
                        throw new ScriptFailure("FMC-CODE-COMPILE",
                            $"The script didn't compile ({errors.Count} error{(errors.Count == 1 ? "" : "s")}); first: {first}.{hint}",
                            new JObject { ["errors"] = errors });
                    }

                    ms.Seek(0, SeekOrigin.Begin);
                    Assembly assembly = Load(ms);
                    MethodInfo method = assembly.GetType("AIGeneratedCode.CodeExecutor")?.GetMethod("Execute");
                    if (method == null) throw new ScriptFailure("FMC-CODE-INTERNAL", "The compiled script has no Execute method.");
                    return new CompiledScript { Method = method, Assembly = assembly };
                }
            }
            finally
            {
                info.CompileMs = watch.ElapsedMilliseconds;
            }
        }

        /// <summary>"System.IO", "using System.IO;", "static System.Math", "A = B.C" → the part after "using"; null when invalid.</summary>
        public static string NormaliseUsing(string raw)
        {
            string u = (raw ?? "").Trim();
            if (u.StartsWith("using ", StringComparison.Ordinal)) u = u.Substring(6).Trim();
            u = u.TrimEnd(';').Trim();
            u = Regex.Replace(u, @"\s+", " ");
            return u.Length > 0 && UsingPattern.IsMatch(u) ? u : null;
        }

        private static List<MetadataReference> _references;
        private static int _referenceCount = -1;
        private static readonly object _referenceLock = new object();

        /// <summary>Every assembly loaded in Revit (cached until a new one loads): Revit's API, .NET, the add-in, the helpers.</summary>
        private static List<MetadataReference> References()
        {
            lock (_referenceLock)
            {
                Assembly[] loaded = AppDomain.CurrentDomain.GetAssemblies();
                if (_references != null && loaded.Length == _referenceCount) return _references;
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var list = new List<MetadataReference>();
                foreach (Assembly a in loaded)
                {
                    try
                    {
                        if (a.IsDynamic || string.IsNullOrEmpty(a.Location) || !seen.Add(a.Location)) continue;
                        if (a.GetName().Name.StartsWith("FmcScript_", StringComparison.Ordinal)) continue;
                        list.Add(MetadataReference.CreateFromFile(a.Location));
                    }
                    catch (Exception) { /* an assembly that can't be read is left out */ }
                }
                _references = list;
                _referenceCount = loaded.Length;
                return list;
            }
        }

        private static Assembly Load(MemoryStream ms)
        {
#if NET
            // Into the command set's own load context, so the script sees the same RevitMCPCommandSet.Bridge (one job, one
            // failures list) as this handler.
            var context = System.Runtime.Loader.AssemblyLoadContext.GetLoadContext(typeof(ExecuteCodeEventHandler).Assembly)
                          ?? System.Runtime.Loader.AssemblyLoadContext.Default;
            return context.LoadFromStream(ms);
#else
            return Assembly.Load(ms.ToArray());
#endif
        }

        private static Exception Unwrap(Exception ex)
        {
            while ((ex is TargetInvocationException || ex is AggregateException || ex is TypeInitializationException) && ex.InnerException != null)
                ex = ex.InnerException;
            return ex;
        }

        /// <summary>The script line (1 = the first line sent) where the exception was thrown or passed through the script.</summary>
        private static int? ScriptLine(Exception ex, Assembly script)
        {
            try
            {
                foreach (StackFrame frame in new StackTrace(ex, true).GetFrames() ?? Array.Empty<StackFrame>())
                {
                    if (frame.GetMethod()?.DeclaringType?.Assembly == script && frame.GetFileLineNumber() > 0)
                        return frame.GetFileLineNumber();
                }
            }
            catch (Exception) { }
            return null;
        }

        /// <summary>The first frames of the stack, script frames with their line, Revit's own frames by method name.</summary>
        private static JArray ScriptStack(Exception ex, Assembly script)
        {
            var frames = new JArray();
            try
            {
                foreach (StackFrame frame in (new StackTrace(ex, true).GetFrames() ?? Array.Empty<StackFrame>()).Take(8))
                {
                    MethodBase m = frame.GetMethod();
                    bool mine = m?.DeclaringType?.Assembly == script;
                    frames.Add(mine && frame.GetFileLineNumber() > 0
                        ? $"script line {frame.GetFileLineNumber()}"
                        : $"{m?.DeclaringType?.FullName}.{m?.Name}");
                }
            }
            catch (Exception) { }
            return frames;
        }

        private static string Serialize(object result, ExecutionResultInfo info)
        {
            try
            {
                return JsonConvert.SerializeObject(result, new JsonSerializerSettings
                {
                    ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
                    MaxDepth = 16,
                });
            }
            catch (Exception ex)
            {
                info.Note = $"The result couldn't be turned into JSON ({ex.GetType().Name}); its text is returned. Return numbers, strings, lists or anonymous objects.";
                return JsonConvert.SerializeObject(result?.ToString());
            }
        }

        public string GetName() => "FMC: AI script";
    }

    /// <summary>A failure with its stable code, raised inside the handler.</summary>
    public sealed class ScriptFailure : Exception
    {
        public string Code { get; }
        public JObject Detail { get; }
        public ScriptFailure(string code, string message, JObject detail = null) : base(message) { Code = code; Detail = detail; }
    }

    /// <summary>send_code_to_revit's answer.</summary>
    public class ExecutionResultInfo
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        /// <summary>The script's return value as JSON text.</summary>
        [JsonProperty("result")]
        public string Result { get; set; }

        /// <summary>Stable error code (FMC-CODE-*), empty on success.</summary>
        [JsonProperty("errorCode")]
        public string ErrorCode { get; set; } = string.Empty;

        /// <summary>"[FMC-CODE-…] what happened", in English; empty on success.</summary>
        [JsonProperty("errorMessage")]
        public string ErrorMessage { get; set; } = string.Empty;

        /// <summary>Compile errors (errors[]: id, line, column, message) or the runtime exception (type, message, line, stack).</summary>
        [JsonProperty("error", NullValueHandling = NullValueHandling.Ignore)]
        public JObject Error { get; set; }

        [JsonProperty("job")]
        public string Job { get; set; } = string.Empty;

        [JsonProperty("document", NullValueHandling = NullValueHandling.Ignore)]
        public string Document { get; set; }

        [JsonProperty("transactionMode")]
        public string TransactionMode { get; set; } = string.Empty;

        /// <summary>The transaction's end: Committed, RolledBack, or none.</summary>
        [JsonProperty("transaction", NullValueHandling = NullValueHandling.Ignore)]
        public string Transaction { get; set; }

        [JsonProperty("compileMs")]
        public long CompileMs { get; set; }

        [JsonProperty("runMs")]
        public long RunMs { get; set; }

        [JsonProperty("totalMs")]
        public long TotalMs { get; set; }

        /// <summary>Revit warnings the default preprocessor deleted.</summary>
        [JsonProperty("warnings")]
        public List<string> Warnings { get; set; } = new List<string>();

        /// <summary>Revit errors that rolled a transaction back.</summary>
        [JsonProperty("failures")]
        public List<string> Failures { get; set; } = new List<string>();

        /// <summary>Dialogs Revit showed during the job and what was answered.</summary>
        [JsonProperty("dialogs")]
        public JArray Dialogs { get; set; } = new JArray();

        [JsonProperty("note", NullValueHandling = NullValueHandling.Ignore)]
        public string Note { get; set; }

        public void SetError(string code, string message, JObject detail)
        {
            Success = false;
            ErrorCode = code;
            ErrorMessage = $"[{code}] {message}";
            Error = detail;
        }

        public static ExecutionResultInfo Fail(string job, string code, string message)
        {
            var r = new ExecutionResultInfo { Job = job ?? "" };
            r.SetError(code, message, null);
            return r;
        }
    }
}
