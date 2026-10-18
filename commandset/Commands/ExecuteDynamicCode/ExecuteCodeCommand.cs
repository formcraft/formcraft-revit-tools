using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Bridge;

namespace RevitMCPCommandSet.Commands.ExecuteDynamicCode
{
    /// <summary>
    /// send_code_to_revit: compiles and runs a C# snippet on Revit's API thread (docs/BRIDGE.md).
    /// <para>Every outcome comes back as a result with a stable error code (FMC-CODE-*), in English (F-034). The command
    /// waits as long as the script runs (up to <see cref="MaxWaitMs"/>); the MCP server answers "still running" with
    /// the job id before its client's 60 s cutoff and keeps the final result for fmc_job (F-030).</para>
    /// </summary>
    public class ExecuteCodeCommand : ExternalEventCommandBase
    {
        /// <summary>Longest a script may hold Revit's API thread before this command stops waiting: 12 h by default (F-064: a
        /// batch of families runs for hours and its answer was lost at the old 30 min), FMC_SEND_CODE_MAX_MS overrides.</summary>
        public static readonly int MaxWaitMs = int.TryParse(Environment.GetEnvironmentVariable("FMC_SEND_CODE_MAX_MS"), out int v) && v > 0 ? v : 12 * 60 * 60 * 1000;

        /// <summary>Largest script accepted, in characters (documented in docs/BRIDGE.md; the server checks it too).</summary>
        public const int MaxCodeChars = 1_000_000;

        private static readonly object _lock = new object();
        private ExecuteCodeEventHandler _handler => (ExecuteCodeEventHandler)Handler;

        public override string CommandName => "send_code_to_revit";

        public ExecuteCodeCommand(UIApplication uiApp)
            : base(new ExecuteCodeEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            parameters = parameters ?? new JObject();
            string job = FmcAiJob.JobOf(parameters);
            if (string.IsNullOrEmpty(job)) job = requestId ?? "";

            string code = parameters.Value<string>("code");
            if (string.IsNullOrWhiteSpace(code))
                return ExecutionResultInfo.Fail(job, "FMC-CODE-PARAMS", "No code: send the C# body in 'code'.");
            if (code.Length > MaxCodeChars)
                return ExecutionResultInfo.Fail(job, "FMC-CODE-TOO-LARGE",
                    $"The script has {code.Length:N0} characters; the limit is {MaxCodeChars:N0}. Split it into steps.");

            object[] executionParameters = (parameters["parameters"] as JArray)?.ToObject<object[]>() ?? Array.Empty<object>();
            string transactionMode = parameters.Value<string>("transactionMode") ?? ExecuteCodeEventHandler.TransactionModeAuto;
            string[] usings = (parameters["usings"] as JArray)?.ToObject<string[]>() ?? Array.Empty<string>();

            lock (_lock)
            {
                // One script at a time: a second one must not replace a script that is still waiting or running.
                if (_handler.Busy)
                    return ExecutionResultInfo.Fail(job, "FMC-CODE-BUSY",
                        $"Another script (job {_handler.Job}) is still waiting or running in Revit. Ask fmc_job status {_handler.Job}; " +
                        "send this one again once it has finished. Nothing was run.");

                _handler.SetExecutionParameters(code, executionParameters, transactionMode, usings, job, parameters);
            }

            // Not under the lock: a second call while this one waits gets FMC-CODE-BUSY at once instead of queueing.
            if (RaiseAndWaitForCompletion(MaxWaitMs))
                return _handler.TakeResult(job) ?? ExecutionResultInfo.Fail(job, "FMC-CODE-INTERNAL", "The script finished but its result was lost; ask fmc_job status " + job + ".");

            return ExecutionResultInfo.Fail(job, "FMC-CODE-TIMEOUT",
                $"Revit didn't finish the script in {MaxWaitMs / 60000} min: it is still waiting for Revit's API thread (a dialog " +
                "waiting for a person, or a long loop). It may still finish: ask fmc_job status " + job + ".");
        }
    }
}
