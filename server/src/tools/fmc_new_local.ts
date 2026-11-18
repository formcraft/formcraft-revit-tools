import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection, currentPort } from "../utils/ConnectionManager.js";
import { JobStillRunning } from "../utils/SocketClient.js";
import { loadConfig } from "../fmc/policy.js";
import { currentClient, queueFor } from "../fmc/fairqueue.js";
import { batchBoard } from "../fmc/batchline.js";
import { batchLease } from "../fmc/target.js";
import fs from "node:fs";
import {
  CentralFile, NEW_LOCAL_CAVEAT, NewLocalInput, OpenDoc, codeResult, newLocalProbeScript, planNewLocal, runNewLocalSteps,
} from "../fmc/newlocal.js";

export const FMC_NEW_LOCAL_DESCRIPTION =
  "Make a fresh workshared local from a central and open it, replacing an open local. Unsaved changes in that local " +
  "are discarded. The old file and its Revit backup folder are renamed aside (never copied, never deleted); an existing backup is " +
  "kept and the next name is -2, -3, and so on. If the local is already closed, the switch and close are skipped. The caller does not supply code. The switch, the close, and the " +
  "final activate go through the native file command fmc_revit_file. CreateNewLocal and the background open are one fixed " +
  "script. document is required (the active document is never assumed). dry_run defaults to true, lists those calls, and " +
  "closes nothing. A real run needs access=full with General On, the same approval as other writes, and in testing mode " +
  "with auto-approve it runs and is listed as auto-approved. " +
  NEW_LOCAL_CAVEAT;

export const FMC_NEW_LOCAL_SHAPE = {
  document: z.string().min(1).describe("Title of the open local to replace. Required. The active document is never assumed."),
  central: z.string().min(1).describe("Full path of the central .rvt."),
  local: z.string().min(1).describe("Full path of the new local .rvt. This is the open local's file: it is copied aside, then CreateNewLocal overwrites this path."),
  switch_to: z.string().min(1).optional().describe("Title of another open document to activate first when the local is on screen. Default: any other open project document."),
  backup_suffix: z.string().min(1).max(64).optional().describe("Suffix on the copied file name. Default .bak-YYYYMMDD. An existing backup is not overwritten."),
  dry_run: z.boolean().optional().default(true).describe("Validate and report the plan. Nothing is closed. Default true."),
};

const NO_MODEL = /No open document|is not a local|is not a central|No other open project|switch_to /;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function docsFromInfo(info: Record<string, unknown>): OpenDoc[] {
  const list = Array.isArray(info.documents) ? info.documents : [];
  const docs: OpenDoc[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    docs.push({
      title: String(row.title ?? ""),
      path: String(row.path ?? ""),
      isFamily: row.isFamily === true,
      isWorkshared: row.isWorkshared === true,
      isActive: row.isActive === true,
      isDetached: row.isDetached === true,
      isLinked: row.isLinked === true,
    });
  }
  return docs;
}

function applyCentral(docs: OpenDoc[], body: Record<string, unknown>): CentralFile {
  const title = String(body.docTitle ?? "");
  const found = docs.find((d) => d.title === title) ?? docs.find((d) => d.path && d.path.toLowerCase() === String(body.docPath ?? "").toLowerCase());
  if (found && body.docFound === true) {
    found.centralPath = String(body.docCentral ?? "");
    found.isWorkshared = body.docWorkshared === true;
    found.isDetached = body.docDetached === true;
    found.isFamily = body.docFamily === true;
    found.isActive = body.docActive === true;
    if (body.docPath) found.path = String(body.docPath);
  }
  return {
    exists: body.exists === true,
    isWorkshared: body.isWorkshared === true,
    isCentral: body.isCentral === true,
    centralPath: String(body.centralPath ?? ""),
  };
}

export async function runFmcNewLocal(args: NewLocalInput) {
  const { config } = loadConfig();
  const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
  const dry = args.dry_run !== false;
  const caller = { lease: batchLease.getStore(), client: currentClient() };
  let queueRunning: { client: string; label: string } | null = null;
  let holder: { lease: string; client: string } | null = null;
  try {
    holder = batchBoard().activeHolder(args.document);
    const port = await currentPort();
    const running = queueFor(port).snapshot().running;
    if (running) queueRunning = { client: running.client, label: running.label };
  } catch {
    holder = batchBoard().activeHolder(args.document);
  }

  const assumed: CentralFile = { exists: exists(args.central), isWorkshared: true, isCentral: true, centralPath: args.central };
  const early = planNewLocal(args, { cfg: config, exists, docs: [], centralFile: assumed, holder, caller, queueRunning });
  const hard = early.reasons.filter((r) => !NO_MODEL.test(r));
  if (hard.length) return reply({ refused: true, reasons: hard, caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);

  let centralFile: CentralFile = assumed;
  let docs: OpenDoc[] = [];
  try {
    const info = asRecord(await withRevitConnection((client) => client.sendRaw("fmc_document_info", {})));
    docs = info ? docsFromInfo(info) : [];
    const response = await withRevitConnection((client) => client.sendRaw("send_code_to_revit", {
      code: newLocalProbeScript(args.central, args.document),
      parameters: [],
      usings: [],
      transactionMode: "read_only",
      document: args.document,
      purpose: "Read central and local before fmc_new_local",
    }));
    const row = asRecord(response);
    if (row?.success === false) {
      const message = String(row.errorMessage || row.error || "Could not read the open document.");
      return reply({ refused: true, reasons: [message], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
    }
    const body = codeResult(response);
    if (!body) return reply({ refused: true, reasons: ["Revit did not return the central check."], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
    centralFile = applyCentral(docs, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ refused: true, reasons: [message], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
  }

  const plan = planNewLocal(args, { cfg: config, exists, docs, centralFile, holder, caller, queueRunning });
  if (!plan.ok) return reply({ refused: true, reasons: plan.reasons, caveat: plan.caveat, dry_run: dry }, true);
  if (dry) {
    return reply({
      dry_run: true, closes: false, resume: plan.resume, document: plan.document, central: plan.central, local: plan.local,
      active: plan.active, switch_to: plan.switch_to, switch_path: plan.switch_path, backup: plan.backup,
      backup_folder_from: plan.backup_folder_from || undefined, backup_folder_to: plan.backup_folder_to || undefined,
      steps: plan.steps, calls: plan.calls, caveat: plan.caveat, next: "Run again with dry_run=false",
    });
  }

  try {
    const ran = await withRevitConnection((client) => runNewLocalSteps(plan, (command, params) => client.sendCommand(command, params)));
    if (!ran.ok) return reply({ ...ran, caveat: NEW_LOCAL_CAVEAT }, true);
    return reply({ ...ran, caveat: NEW_LOCAL_CAVEAT });
  } catch (error) {
    if (error instanceof JobStillRunning) {
      return reply({ status: "running", job: error.job, message: error.message, caveat: NEW_LOCAL_CAVEAT });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, message, caveat: NEW_LOCAL_CAVEAT }, true);
  }
}

export function registerFmcNewLocalTool(server: McpServer) {
  server.tool("fmc_new_local", FMC_NEW_LOCAL_DESCRIPTION, FMC_NEW_LOCAL_SHAPE, (args) => runFmcNewLocal(args));
}
