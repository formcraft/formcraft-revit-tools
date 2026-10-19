import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { JobStillRunning } from "../utils/SocketClient.js";

/** Largest script accepted (characters). The add-in checks the same limit; docs/BRIDGE.md. */
export const MAX_CODE_CHARS = 1_000_000;

const USING = /^(using\s+)?(static\s+)?([A-Za-z_]\w*\s*=\s*)?[A-Za-z_]\w*(\.[A-Za-z_]\w*)*\s*;?$/;

const transactionModeSchema = z
  .enum(["auto", "none"])
  .default("auto")
  .describe(
    "'auto' (default) wraps the script in one transaction with the default failures handling: Revit warnings are " +
      "deleted and listed in the result, an error rolls everything back and is reported. 'none' when the script opens " +
      "its own transactions (use FmcScript.Run(document, name, () => {...}) for the same handling)."
  );

export const SEND_CODE_DESCRIPTION =
  "Send C# code to Revit. The code is the body of `object Execute(Document document, object[] parameters)`: end it " +
    "with `return <value>;` (`return null;` when there is nothing to return). Namespaces always in scope: System, " +
    "System.Linq, System.Collections.Generic, System.Text, Autodesk.Revit.DB (+ .Architecture, .Structure), " +
    "Autodesk.Revit.UI and RevitMCPCommandSet.Bridge; add more with `usings`. Helpers: FmcScript.Mm(mm) → feet, " +
    "FmcScript.ToMm(feet), FmcScript.PointMm(x, y, z), FmcScript.Run(document, name, action) (a transaction with the " +
    "default failures handling, for transactionMode 'none'), FmcScript.ThrowIfCancelled(), and FmcFailures (an " +
    "IFailuresPreprocessor: warnings deleted and listed, errors roll back), e.g. for StairsEditScope.Commit(new FmcFailures()). " +
    `Scripts up to ${MAX_CODE_CHARS.toLocaleString("en")} characters. The result gives compile and run times apart; ` +
    "errors carry a code (FMC-CODE-COMPILE with line and column, FMC-CODE-RUNTIME with the exception's type, message and " +
    "script line, FMC-CODE-ROLLED-BACK with Revit's errors). A script still running after about 50 s answers " +
    "[FMC-JOB-RUNNING] with a job id: it has not failed; follow it with fmc_job, never send it again. Give a short `purpose`: " +
    "repeated scripts are what Formcraft turns into tools next.";

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
};

type SendCodeArgs = { code: string; parameters?: string[]; usings?: string[]; transactionMode?: "auto" | "none"; purpose?: string };

/** The add-in's answer as text: the result, or the error with its code, and the times. */
export function formatCodeResult(response: any): { text: string; isError: boolean } {
  if (!response || typeof response !== "object") return { text: `Code execution finished.\nResult: ${JSON.stringify(response)}`, isError: false };
  const times = `compile ${response.compileMs ?? "?"} ms, run ${response.runMs ?? "?"} ms`;
  const extra = {
    job: response.job, document: response.document, transaction: response.transaction,
    warnings: response.warnings?.length ? response.warnings : undefined,
    failures: response.failures?.length ? response.failures : undefined,
    dialogs: response.dialogs?.length ? response.dialogs : undefined,
    note: response.note,
  };
  if (response.success === false) {
    return {
      isError: true,
      text: `Code execution failed ${response.errorMessage || `[${response.errorCode || "FMC-CODE-INTERNAL"}]`} (${times})\n` +
        JSON.stringify({ errorCode: response.errorCode, error: response.error, ...extra }, null, 2),
    };
  }
  let result: unknown = response.result;
  if (typeof result === "string") { try { result = JSON.parse(result); } catch { /* keep the text */ } }
  return { isError: false, text: `Code execution successful (${times})\n` + JSON.stringify({ result, ...extra }, null, 2) };
}

export async function runSendCode(args: SendCodeArgs) {
  const params = {
    code: args.code,
    parameters: args.parameters || [],
    usings: args.usings || [],
    transactionMode: args.transactionMode ?? "auto",
  };
  try {
    const response = await withRevitConnection(async (revitClient) => revitClient.sendCommand("send_code_to_revit", params));
    const { text, isError } = formatCodeResult(response);
    return { content: [{ type: "text" as const, text }], isError };
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
