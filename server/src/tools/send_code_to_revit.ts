import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { JobStillRunning } from "../utils/SocketClient.js";
import { resolvedDocumentFrom } from "../fmc/docresolve.js";
import { CODE_GATE, CodeCall, boundParams, codeApproval, codeDetails, codeGate } from "../fmc/codegate.js";
import { batchKey } from "../fmc/aiuse.js";
import { claimApproval, enqueue, loadAiConfig, readItem } from "../fmc/aiuse_io.js";
import { documentsMatch, leaseHeldDocuments } from "../fmc/batchline.js";
import { readInstances } from "../fmc/connect.js";
import { jailDocumentOf } from "../fmc/jail.js";
import { loadConfig } from "../fmc/policy.js";
import { batchLease, documentTarget } from "../fmc/target.js";

/** Largest script accepted (characters). The add-in checks the same limit; docs/BRIDGE.md. */
export const MAX_CODE_CHARS = 1_000_000;

const USING = /^(using\s+)?(static\s+)?([A-Za-z_]\w*\s*=\s*)?[A-Za-z_]\w*(\.[A-Za-z_]\w*)*\s*;?$/;

const transactionModeSchema = z
  .enum(["auto", "none", "read_only"])
  .default("auto")
  .describe(
    "'auto' (default) wraps the script in one transaction with the default failures handling: Revit warnings are " +
      "deleted and listed in the result, an error rolls everything back and is reported. 'none' when the script opens " +
      "its own transactions (use FmcScript.Run(document, name, () => {...}) for the same handling). 'read_only' (owner 26 Oct) " +
      "runs it in a transaction that is always rolled back: the model can't change, so it needs no approval; use it to read."
  );

export const SEND_CODE_DESCRIPTION =
  "Permission first (owner 28 Nov): every call needs reason (\"no_tool\" when no tool does the job, or \"tool_error\" with " +
    "failing_tool, the tool that failed), this session's batch_lease on the document, and a person's approval of this exact code " +
    "in the Formcraft pane. The first call queues it and answers FMC-CODE-APPROVAL-NEEDED with an id and tools to try instead: " +
    "call fmc_ai wait with that id, and when it says approved send the same call again; it runs once. Access full and testing " +
    "auto-approve do not skip this; read_only mode needs it too (code can write files). " +
    "Send C# code to Revit. The code is the body of `object Execute(Document document, object[] parameters)`. " +
    "`document` and `doc` are the call's resolved document, not whichever model is active. End it " +
    "with `return <value>;` (`return null;` when there is nothing to return). Namespaces always in scope: System, " +
    "System.Linq, System.Collections.Generic, System.Text, Autodesk.Revit.DB (+ .Architecture, .Structure), " +
    "Autodesk.Revit.UI and RevitMCPCommandSet.Bridge; add more with `usings`. Helpers: FmcScript.Mm(mm) → feet, " +
    "FmcScript.ToMm(feet), FmcScript.PointMm(x, y, z), FmcScript.Run(document, name, action) (a transaction with the " +
    "default failures handling, for transactionMode 'none'), FmcScript.Tx(document, name, dryRun, () => {...}) (commits, " +
    "rolls back on any exception, a dry run rolls back; returns the body's value), FmcScript.CopyOptionsUseDestinationTypes() " +
    "(no Duplicate Types dialog), FmcScript.ThrowIfCancelled(), and FmcFailures (an " +
    "IFailuresPreprocessor: warnings deleted and listed, errors roll back), e.g. for StairsEditScope.Commit(new FmcFailures()). " +
    "Every new Transaction / SubTransaction / TransactionGroup must be in a using (else refused: FMC-CODE-TX-USING with the " +
    "line); one left open is rolled back and reported (FMC-CODE-TX-LEAK). Before writing code, check fmc_scripts " +
    "addon_list: a saved add-on may already do the job. " +
    `Scripts up to ${MAX_CODE_CHARS.toLocaleString("en")} characters. The result gives compile and run times apart; ` +
    "errors carry a code (FMC-CODE-COMPILE with line and column, FMC-CODE-RUNTIME with the exception's type, message and " +
    "script line, FMC-CODE-ROLLED-BACK with Revit's errors). A script still running after about 50 s answers " +
    "[FMC-JOB-RUNNING] with a job id: it has not failed; follow it with fmc_job, never send it again. Give a short `purpose`: " +
    "repeated scripts are what Formcraft turns into tools next. A script that calls itself, or a while(true) or for(;;) with no " +
    "break, return or throw, is refused before it runs: a stack overflow cannot be caught and crashes Revit. " +
    "Soft cap: do not walk every parameter of every element. A FilteredElementCollector with no OfCategory or OfClass, " +
    "then Parameters, GetOrderedParameters or ParametersMap reading StorageType or AsValueString, is refused " +
    "(FMC-SEND-CODE-UNSCOPED). That walk crashed Revit 2025.4 with an uncatchable AccessViolationException. " +
    "Scope by category or class and read named parameters (LookupParameter or get_Parameter(BuiltInParameter)), in batches. " +
    "allow_full_scan true is the only override.";

export const SEND_CODE_SHAPE = {
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_CHARS)
    .describe("The C# body of Execute(Document document, object[] parameters); line 1 is the first line sent."),
  parameters: z.array(z.string()).optional().describe("Optional values passed to the script as parameters[]"),
  usings: z
    .array(z.string().regex(USING, "a namespace, e.g. System.IO, static System.Math or Arch = Autodesk.Revit.DB.Architecture"))
    .max(40)
    .optional()
    .describe("Extra namespaces for the script, e.g. [\"System.IO\", \"Autodesk.Revit.DB.Mechanical\"]"),
  transactionMode: transactionModeSchema,
  purpose: z
    .string()
    .max(300)
    .optional()
    .describe("A few words on what the code is for, e.g. \"export sheet PNGs\" or \"LED strips on room walls\". Recorded in the local call " +
      "ledger (never the code) so repeated scripts can be moved into a plugin tool (fmc_balance backlog)."),
  allow_full_scan: z
    .boolean()
    .optional()
    .describe("Override FMC-SEND-CODE-UNSCOPED. A full parameter scan of every element crashed Revit 2025.4. Leave this false and scope the collector."),
  reason: z
    .enum(["no_tool", "tool_error"])
    .optional()
    .describe("Required. \"no_tool\": no Formcraft tool does this. \"tool_error\": a tool that should do it failed; name it in failing_tool."),
  failing_tool: z.string().max(80).optional().describe("With reason tool_error: the tool that failed, e.g. modify_model."),
  failing_error: z.string().max(500).optional().describe("With reason tool_error: the error it gave (shown to the person on the approval card)."),
};

type SendCodeArgs = { code: string; parameters?: string[]; usings?: string[]; transactionMode?: "auto" | "none" | "read_only"; purpose?: string; allow_full_scan?: boolean;
  reason?: "no_tool" | "tool_error"; failing_tool?: string; failing_error?: string };

/**
 * The permission-first gate (fmc/codegate.ts) with its IO: the call's document, this session's lease, the approval
 * queue. An approved, matching call is claimed (used once) here, before Revit is called.
 */
export function sendCodeGate(args: SendCodeArgs, env: NodeJS.ProcessEnv = process.env) {
  const call: CodeCall = { ...args };
  const { config } = loadConfig();
  const ai = loadAiConfig(config, env);
  let open: Array<{ title: string; path: string; workshared?: boolean; family?: boolean }> = [];
  try { open = readInstances(env).flatMap((i) => i.documents ?? []); } catch { open = []; }
  const { doc, problem } = jailDocumentOf(open, documentTarget.getStore());
  const document = doc ? (doc.path || doc.title) : "";
  const lease = batchLease.getStore();
  const bound = boundParams(call);
  const queued = document ? readItem(batchKey("send_code_to_revit", bound, document), env) : null;
  const r = codeGate({ call, document, documentProblem: problem, lease, leaseDocuments: leaseHeldDocuments(lease), leaseCovers: documentsMatch, ai, queued });
  if (r.ok) {
    if (!claimApproval(r.approvalId, env))
      return { ok: false as const, code: CODE_GATE.USED, message: `[${CODE_GATE.USED}] Approval ${r.approvalId} has already been used once. Nothing was sent.` };
    return r;
  }
  if (r.enqueue) {
    const item = enqueue("send_code_to_revit", bound, document, doc?.title || document, "code", 1, env, new Date(), codeDetails(call, document));
    return { ...r, approval: item.id, message: r.message.split("(new)").join(item.id) };
  }
  return r;
}

/**
 * A script result that is already an object, or a JSON string of an object or array, parsed once.
 * Anything else stays out of output_json. The text reply is unchanged apart from this extra field.
 */
export function outputJson(result: unknown): unknown | undefined {
  let value = result;
  // The add-in JSON-encodes the script's return value, so a script that returns a JSON string arrives
  // double-encoded ("\"{...}\""). Unwrap up to three string layers before giving up.
  for (let depth = 0; depth < 3 && typeof value === "string"; depth++) {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\"")) return undefined;
    try { value = JSON.parse(text); } catch { return undefined; }
  }
  if (value !== null && typeof value === "object") return value;
  return undefined;
}

/** The add-in's answer as text: the result, or the error with its code, and the times. */
export function formatCodeResult(response: any): { text: string; isError: boolean; output_json?: unknown } {
  if (!response || typeof response !== "object") return { text: `Code execution finished.\nResult: ${JSON.stringify(response)}`, isError: false };
  const times = `compile ${response.compileMs ?? "?"} ms, run ${response.runMs ?? "?"} ms`;
  const resolved = resolvedDocumentFrom(response.resolved_document) ?? resolvedDocumentFrom(response.document);
  const extra = {
    job: response.job, document: response.document, ...(resolved ? { resolved_document: resolved } : {}), transaction: response.transaction,
    undo_id: response.undoId || undefined,
    warnings: response.warnings?.length ? response.warnings : undefined,
    failures: response.failures?.length ? response.failures : undefined,
    dialogs: response.dialogs?.length ? response.dialogs : undefined,
    txLeak: response.txLeak?.length ? response.txLeak : undefined,
    documentBlocked: response.documentBlocked || undefined,
    note: response.note,
    created_ids: response.createdIds?.length ? response.createdIds : undefined,
    // Ogala night report: compile times grew to 74-133 s before an OutOfMemoryException; and a script that touched far
    // more than it named
    advice: [
      (response.compileMs ?? 0) > 30000 ? "Compiling took over 30 s: Revit is short of memory. Save with fmc_save_project and ask the person to restart Revit before more scripts." : "",
      (response.modifiedCount ?? 0) > 300 || (response.deletedIds?.length ?? 0) > 50 ? `This script changed ${response.modifiedCount ?? 0} and deleted ${response.deletedIds?.length ?? 0} elements: check that was meant (see_view, model_check).` : "",
      /open transaction/i.test(String(response.errorMessage ?? "")) && /save/i.test(String(response.errorMessage ?? "") + String(response.error ?? "")) ? "Scripts can't save the model: use revit_file save." : "",
    ].filter(Boolean),
    deleted_ids: response.deletedIds?.length ? response.deletedIds : undefined,
    modified: response.modifiedCount || undefined,
  };
  if (!extra.advice.length) delete (extra as { advice?: string[] }).advice;
  if (response.success === false) {
    return {
      isError: true,
      text: `Code execution failed ${response.errorMessage || `[${response.errorCode || "FMC-CODE-INTERNAL"}]`} (${times})\n` +
        JSON.stringify({ errorCode: response.errorCode, error: response.error, ...extra }, null, 2),
    };
  }
  let result: unknown = response.result;
  for (let depth = 0; depth < 3 && typeof result === "string"; depth++) {
    const text = result.trim();
    if (depth > 0 && !text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\"")) break;
    try { result = JSON.parse(text); } catch { break; }
  }
  const output_json = outputJson(response.result);
  return { isError: false, text: `Code execution successful (${times})\n` + JSON.stringify({ result, ...(output_json === undefined ? {} : { output_json }), ...extra }, null, 2), output_json };
}

export async function runSendCode(args: SendCodeArgs) {
  const gate = sendCodeGate(args);
  if (!gate.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ refused: true, code: gate.code, message: gate.message,
        ...("approval" in gate && gate.approval ? { approval: gate.approval, next: [`fmc_ai wait ${gate.approval}`] } : {}),
        ...("alternatives" in gate && gate.alternatives ? { try_instead: gate.alternatives } : {}) }, null, 2) }],
      isError: true,
    };
  }
  const params = {
    code: args.code,
    parameters: args.parameters || [],
    usings: args.usings || [],
    transactionMode: args.transactionMode ?? "auto",
    ...(args.allow_full_scan ? { allow_full_scan: true } : {}),
  };
  try {
    const response = await codeApproval.run({ id: gate.approvalId, by: gate.by }, () =>
      withRevitConnection(async (revitClient) => revitClient.sendCommand("send_code_to_revit", params)));
    const { text, isError, output_json } = formatCodeResult(response);
    return { content: [{ type: "text" as const, text }], isError, ...(output_json === undefined ? {} : { output_json }) };
  } catch (error) {
    if (error instanceof JobStillRunning) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "running", job: error.job, message: error.message,
          next: [`fmc_job status ${error.job}`, `fmc_job result ${error.job}`] }, null, 2) }],
        isError: false,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Code execution failed: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function registerSendCodeToRevitTool(server: McpServer) {
  server.tool("send_code_to_revit", SEND_CODE_DESCRIPTION, SEND_CODE_SHAPE, async (args) => runSendCode(args));
}
