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
  CentralFile, NEW_LOCAL_CAVEAT, NewLocalInput, OpenDoc, codeResult, newLocalProbeScript, planNewLocal, runNewLocalSteps, switchCandidates,
} from "../fmc/newlocal.js";

export const FMC_NEW_LOCAL_DESCRIPTION =
  "Make a fresh workshared local from a central and open it, replacing an open local. Unsaved changes in that local " +
  "are discarded. The old file and its Revit backup folder are renamed aside (never copied, never deleted); an existing backup is " +
  "kept and the next name is -2, -3, and so on. If the local is already closed, the switch and close are skipped. The caller does not supply code. The switch, the close, and the " +
  "final activate go through the native file command fmc_revit_file. CreateNewLocal and the background open are one fixed " +
  "script. document is required (the active document is never assumed). dry_run defaults to true, lists those calls, and " +
  "closes nothing. A real run needs access=full with General On, the same approval as other writes, and in testing mode " +
  "with auto-approve it runs and is listed as auto-approved. " +
  "The dry run shows old_local (modified, unsynced, size_mb; the backup holds the last saved state only), the switch_to candidates and how the host was chosen (default: an open project that is not workshared and not modified). " +
  NEW_LOCAL_CAVEAT;

export const FMC_NEW_LOCAL_SHAPE = {
  document: z.string().min(1).describe("Title of the open local to replace. Required. The active document is never assumed."),
  central: z.string().min(1).describe("Full path of the central .rvt."),
  local: z.string().min(1).describe("Full path of the new local .rvt. The old file at this path is renamed (moved) aside, then CreateNewLocal writes it again. Required when the document is not open: its path cannot be read from Revit."),
  switch_to: z.string().min(1).optional().describe("Title of another open document to activate first when the local is on screen. Default: any other open project document. In resume mode the script binds to this document."),
  backup_suffix: z.string().min(1).max(64).optional().describe("Suffix on the renamed file. Default .bak-YYYYMMDD. The old local is moved, not copied. An existing backup is not overwritten."),
  dry_run: z.boolean().optional().default(true).describe("Validate and report the plan. Nothing is closed. Default true."),
  sync_first: z.boolean().optional().default(false).describe("Sync the old local with central before anything is closed (fmc_revit_file sync, approved like any sync). A failed sync stops the run."),
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
      ...(typeof row.isModified === "boolean" ? { isModified: row.isModified } : {}),
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

/** Research 60: what the probe read about the old local. unsynced is null when unknown (not saved, or not workshared). */
export function oldLocalState(body: Record<string, unknown>): { modified: boolean | null; unsynced: boolean | null } {
  return {
    modified: typeof body.docModified === "boolean" ? body.docModified : null,
    unsynced: body.docUnsynced === "yes" ? true : body.docUnsynced === "no" ? false : null,
  };
}

function sizeMb(file: string, exists: (p: string) => boolean): number | null {
  try { return exists(file) ? Math.round(fs.statSync(file).size / 1048576 * 10) / 10 : null; } catch { return null; }
}

export interface RevitIo {
  sendRaw(command: string, params: Record<string, unknown>): Promise<unknown>;
  sendCommand(command: string, params: Record<string, unknown>): Promise<unknown>;
  exists?: (p: string) => boolean;
}

/**
 * The document-info key for the dry run. A missing local is a resume: Info does not need that file.
 * The central is on disk, and the open-document list comes back either way. Never the closed title.
 */
export function documentInfoKey(local: string, central: string, fileExists: (p: string) => boolean): string {
  return fileExists(local) ? local : central;
}

/** An open document the script may bind to. Never the closed local's title. */
export function bindTitle(docs: OpenDoc[], closedTitle: string, localPath: string, requested?: string): string {
  const closed = closedTitle.trim().toLowerCase();
  const open = docs.filter((d) => d.title.trim().toLowerCase() !== closed && !(d.path && localPath && d.path.toLowerCase() === localPath.toLowerCase()));
  const host = open.find((d) => requested && (d.title.toLowerCase() === requested.trim().toLowerCase() || (d.path && d.path.toLowerCase() === requested.trim().toLowerCase())))
    ?? open.find((d) => !d.isFamily && !d.isLinked && d.path);
  if (!host) throw new Error(`No other open project document can take the script. ${closedTitle} is not used.`);
  if (host.title.trim().toLowerCase() === closed) throw new Error(`Refusing to bind a Revit command to the closed document ${closedTitle}.`);
  return host.title;
}

export async function runFmcNewLocal(args: NewLocalInput, io?: RevitIo) {
  const { config } = loadConfig();
  const exists = io?.exists ?? ((p: string) => { try { return fs.existsSync(p); } catch { return false; } });
  const sendRaw = (command: string, params: Record<string, unknown>) => io
    ? io.sendRaw(command, params)
    : withRevitConnection((client) => client.sendRaw(command, params));
  const sendCommand = (command: string, params: Record<string, unknown>) => io
    ? io.sendCommand(command, params)
    : withRevitConnection((client) => client.sendCommand(command, params));
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
  let oldState: { modified: boolean | null; unsynced: boolean | null } = { modified: null, unsynced: null };
  try {
    // A path that exists. A missing local is described nowhere; the central still lists the open documents.
    const info = asRecord(await sendRaw("fmc_document_info", { document: documentInfoKey(args.local, args.central, exists) }));
    docs = info ? docsFromInfo(info) : [];
    const closed = !docs.some((d) => d.title.toLowerCase() === args.document.trim().toLowerCase() || (d.path && d.path.toLowerCase() === args.local.trim().toLowerCase()));
    const probeDocument = closed ? bindTitle(docs, args.document, args.local, args.switch_to) : args.document;
    const response = await sendRaw("send_code_to_revit", {
      code: newLocalProbeScript(args.central, args.local),
      parameters: [],
      usings: [],
      transactionMode: "read_only",
      document: probeDocument,
      purpose: "Read central and local before fmc_new_local",
    });
    const row = asRecord(response);
    if (row?.success === false) {
      const message = String(row.errorMessage || row.error || "Could not read the open document.");
      return reply({ refused: true, reasons: [message], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
    }
    const body = codeResult(response);
    if (!body) return reply({ refused: true, reasons: ["Revit did not return the central check."], caveat: NEW_LOCAL_CAVEAT, dry_run: dry }, true);
    centralFile = applyCentral(docs, body);
    oldState = oldLocalState(body);
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
      steps: args.sync_first ? [`0. fmc_revit_file {action:"sync", document:"${plan.document}"} first; a failed sync stops here`, ...plan.steps] : plan.steps,
      calls: plan.calls, caveat: plan.caveat,
      old_local: { ...oldState, size_mb: sizeMb(plan.local, exists), backup_contains: "last saved state: unsaved and unsynced work is not in the backup" },
      ...(oldState.modified || oldState.unsynced ? { warning: `${plan.document} has ${[oldState.modified ? "unsaved" : "", oldState.unsynced ? "unsynced" : ""].filter(Boolean).join(" and ")} changes: they are lost unless you sync first (sync_first true).` } : {}),
      sync_first: args.sync_first === true,
      switch_candidates: switchCandidates(docs.filter((d) => d.title.toLowerCase() !== plan.document.toLowerCase())).map((d) => d.title),
      switch_chosen_by: (args.switch_to ?? "").trim() ? "given" : "default: not workshared, then unmodified",
      next: "Run again with dry_run=false",
    });
  }

  if (args.sync_first && !plan.resume) {
    try {
      const synced = asRecord(await sendCommand("fmc_revit_file", { action: "sync", document: plan.document }));
      if (!synced || synced.ok === false || synced.refused === true || synced.success === false) {
        return reply({ refused: true, step: "sync_first", reasons: [String(synced?.message ?? synced?.error ?? "The sync did not finish.") + " Nothing was closed."], result: synced, caveat: NEW_LOCAL_CAVEAT }, true);
      }
    } catch (error) {
      if (error instanceof JobStillRunning) return reply({ status: "running", step: "sync_first", job: error.job, message: "The sync is still running; nothing was closed. Run fmc_new_local again when it finishes.", caveat: NEW_LOCAL_CAVEAT });
      return reply({ refused: true, step: "sync_first", reasons: [(error instanceof Error ? error.message : String(error)) + " Nothing was closed."], caveat: NEW_LOCAL_CAVEAT }, true);
    }
  }
  try {
    const ran = await runNewLocalSteps(plan, sendCommand);
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
