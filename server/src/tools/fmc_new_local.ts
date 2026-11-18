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
  CentralFile, NEW_LOCAL_CAVEAT, NewLocalInput, OpenDoc, newLocalProbeScript, planNewLocal,
} from "../fmc/newlocal.js";

export const FMC_NEW_LOCAL_DESCRIPTION =
  "Make a fresh workshared local from a central and open it, replacing an open local. Unsaved changes in that local " +
  "are discarded. The old file and its Revit backup folder are copied aside and never deleted; an existing backup is " +
  "kept and the next copy is named -2, -3, and so on. The caller does not supply code: the server sends one fixed " +
  "script through send_code_to_revit. document is required (the active document is never assumed). dry_run defaults to " +
  "true and closes nothing. A real run needs access=full with General On, the same approval as other writes, and in " +
  "testing mode with auto-approve it runs and is listed as auto-approved. " +
  NEW_LOCAL_CAVEAT;

export const FMC_NEW_LOCAL_SHAPE = {
  document: z.string().min(1).describe("Title of the open local to replace. Required. The active document is never assumed."),
  central: z.string().min(1).describe("Full path of the central .rvt."),
  local: z.string().min(1).describe("Full path of the new local .rvt. This is the open local's file: it is copied aside, then CreateNewLocal overwrites this path."),
  switch_to: z.string().min(1).optional().describe("Title of another open document to activate first when the local is on screen. Default: any other open project document."),
  backup_suffix: z.string().min(1).max(64).optional().describe("Suffix on the copied file name. Default .bak-YYYYMMDD. An existing backup is not overwritten."),
  dry_run: z.boolean().optional().default(true).describe("Validate and report the plan. Nothing is closed. Default true."),
};

const NO_MODEL = /No open document|is not a local|is not a central|cannot take the screen|No other document is open|switch_to /;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseBody(response: unknown): Record<string, unknown> | null {
  const row = asRecord(response);
  let result: unknown = row && "result" in row ? row.result : response;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { return null; }
  }
  return asRecord(result);
}

function docsFromProbe(body: Record<string, unknown>): OpenDoc[] {
  const list = Array.isArray(body.docs) ? body.docs : [];
  const docs: OpenDoc[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    docs.push({
      title: String(row.title ?? ""),
      path: String(row.path ?? ""),
      isFamily: row.family === true,
      isWorkshared: false,
      isActive: row.active === true,
    });
  }
  const title = String(body.docTitle ?? "");
  const found = docs.find((d) => d.title === title) ?? docs.find((d) => d.path && d.path.toLowerCase() === String(body.docPath ?? "").toLowerCase());
  if (found && body.docFound === true) {
    found.isFamily = body.docFamily === true;
    found.isWorkshared = body.docWorkshared === true;
    found.isDetached = body.docDetached === true;
    found.isActive = body.docActive === true;
    found.centralPath = String(body.docCentral ?? "");
    found.path = String(body.docPath ?? found.path);
    found.title = title || found.title;
  }
  return docs;
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
    const body = parseBody(response);
    if (!body) return reply({ refused: true, reasons: ["Revit did not return the central check."], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
    centralFile = {
      exists: body.exists === true,
      isWorkshared: body.isWorkshared === true,
      isCentral: body.isCentral === true,
      centralPath: String(body.centralPath ?? ""),
    };
    docs = docsFromProbe(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ refused: true, reasons: [message], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
  }

  const plan = planNewLocal(args, { cfg: config, exists, docs, centralFile, holder, caller, queueRunning });
  if (!plan.ok) return reply({ refused: true, reasons: plan.reasons, caveat: plan.caveat, dry_run: dry }, true);
  if (dry) {
    return reply({
      dry_run: true, closes: false, document: plan.document, central: plan.central, local: plan.local,
      active: plan.active, switch_to: plan.switch_to, backup: plan.backup,
      backup_folder_from: plan.backup_folder_from || undefined, backup_folder_to: plan.backup_folder_to || undefined,
      steps: plan.steps, caveat: plan.caveat, next: "Run again with dry_run=false",
    });
  }

  try {
    const response = await withRevitConnection((client) => client.sendCommand("fmc_new_local", {
      document: plan.document,
      central: plan.central,
      local: plan.local,
      switch_to: plan.switch_to,
      backup: plan.backup,
      _script_document: plan.script_document,
      code: plan.script,
      parameters: [],
      usings: [],
      transactionMode: "none",
      purpose: "Fresh workshared local",
      dry_run: false,
    }));
    const row = asRecord(response);
    if (row?.success === false) {
      return reply({
        ok: false, refused: false,
        message: row.errorMessage || row.error || "The new local was not made.",
        caveat: NEW_LOCAL_CAVEAT,
      }, true);
    }
    const body = parseBody(response);
    if (!body || body.ok === false) {
      return reply({ ok: false, ...body, caveat: NEW_LOCAL_CAVEAT }, true);
    }
    return reply({
      title: body.title, path: body.path, isWorkshared: body.isWorkshared, isLocal: body.isLocal,
      central: body.central, worksets: body.worksets, backup: body.backup, elapsed_ms: body.elapsed_ms,
      opened_how: body.opened_how, caveat: NEW_LOCAL_CAVEAT,
    });
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
