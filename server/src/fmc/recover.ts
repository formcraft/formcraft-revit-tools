/**
 * Crash recovery for Revit. Plan is pure. Apply closes only instances this plan marked crashed or hung.
 * A responsive instance (process alive, responding, plugin port open, heartbeat fresh, no WerFault) is never closed.
 *
 * Needs the add-in: the instance file and its heartbeat, the port the plugin leases, fmc_document_info, and
 * re-registering the instance (the add-in writes instances/<pid>.json when it connects). Restarting Revit.exe
 * and closing a dead process do not need the add-in.
 */
import { createHash } from "node:crypto";

export const DEFAULT_HEARTBEAT_S = 90;
export const REVIT_EXE = "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe";

export const HEBERT_ROLES = ["architecture", "structural", "electrical", "plumbing", "site"] as const;

export type InstanceHealth = "healthy" | "crashed" | "hung";

export interface ObservedProcess {
  pid: number;
  name: string;
  commandLine?: string;
  /** False when Windows reports the process is not responding. */
  responding?: boolean;
}

export interface ObservedDocument {
  title: string;
  path: string;
  workshared?: boolean;
  family?: boolean;
}

export interface ObservedInstance {
  pid: number;
  port: number;
  revit?: string;
  /** Plugin instance file mtime, ISO. The add-in writes this. */
  updated?: string;
  documents: ObservedDocument[];
}

export interface JobHint { pid?: number; port?: number; state: string; command?: string }
export interface SyncHint { title?: string; path?: string; last_sync?: string | null; next_sync?: string | null }
export interface RecoveryDocument { role?: string; title?: string; path: string; workshared?: boolean }

export interface ClassifiedInstance {
  pid: number;
  port: number;
  health: InstanceHealth;
  close: boolean;
  reasons: string[];
  documents: DocumentReport[];
}

export interface DocumentReport {
  title: string;
  path: string;
  workshared: boolean;
  family: boolean;
  last_sync: string | null;
  last_save: string | null;
  unsynced: boolean;
  unsaved: boolean;
  unsaved_known: boolean;
  protected_original: boolean;
  open_as: "file" | "new_local_from_central";
  risk: string;
}

export interface RecoveryPlan {
  action: "plan";
  ok: true;
  confirm: string;
  unsaved: boolean;
  heartbeat_s: number;
  needs_addin: string[];
  instances: ClassifiedInstance[];
  reopen: DocumentReport[];
  would_close: number[];
  healthy_left_alone: number[];
  risk: string;
  revit_exe: string;
}

export interface RecoveryInput {
  now: number;
  heartbeatS: number;
  processes: ObservedProcess[];
  instances: ObservedInstance[];
  portOpen: (port: number) => boolean;
  fileMtime: (path: string) => string | null;
  jobs: JobHint[];
  syncs: SyncHint[];
  protectedRoots: string[];
  documents: RecoveryDocument[];
  revitExe?: string;
}

const NEEDS_ADDIN = [
  "The plugin heartbeat is the instance file's updated time. Without the add-in a silent Revit is not called hung.",
  "The plugin leases the port (8080-8089). Verification that the port is leased needs the add-in.",
  "fmc_document_info checks the opened title and path. That command is the add-in.",
  "Re-registering the instance is the add-in writing instances/<pid>.json when it connects.",
];

export function recoverySettings(raw: { heartbeat_s?: number; documents?: RecoveryDocument[] } | undefined): { heartbeatS: number; documents: RecoveryDocument[] } {
  const n = Math.floor(Number(raw?.heartbeat_s ?? DEFAULT_HEARTBEAT_S));
  const heartbeatS = Number.isFinite(n) && n > 0 ? n : DEFAULT_HEARTBEAT_S;
  const documents = (raw?.documents ?? []).filter((d) => d && typeof d.path === "string" && d.path.trim());
  return { heartbeatS, documents };
}

function norm(p: string): string {
  return p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function underRoot(path: string, roots: string[]): boolean {
  const file = norm(path);
  if (!file) return false;
  return roots.some((root) => {
    const base = norm(root);
    return !!base && (file === base || file.startsWith(base + "\\"));
  });
}

function werFaultFor(pid: number, processes: ObservedProcess[]): boolean {
  return processes.some((p) => /werfault/i.test(p.name) && (p.commandLine ?? "").includes(String(pid)));
}

function processOf(pid: number, processes: ObservedProcess[]): ObservedProcess | undefined {
  return processes.find((p) => p.pid === pid && /revit/i.test(p.name));
}

export function classifyInstance(inst: ObservedInstance, input: Pick<RecoveryInput, "now" | "heartbeatS" | "processes" | "portOpen">): { health: InstanceHealth; close: boolean; reasons: string[] } {
  const proc = processOf(inst.pid, input.processes);
  const fault = werFaultFor(inst.pid, input.processes);
  const reasons: string[] = [];
  if (!proc) {
    reasons.push("process is gone");
    if (fault) reasons.push("WerFault is present for this pid");
    return { health: "crashed", close: false, reasons };
  }
  if (fault) {
    reasons.push("WerFault is present for this pid");
    return { health: "crashed", close: true, reasons };
  }
  if (proc.responding === false) {
    reasons.push("process is not responding");
    return { health: "hung", close: true, reasons };
  }
  const open = input.portOpen(inst.port);
  const updated = inst.updated ? Date.parse(inst.updated) : NaN;
  const stale = !Number.isFinite(updated) || input.now - updated > input.heartbeatS * 1000;
  if (stale && !open) {
    reasons.push(`no plugin heartbeat for more than ${input.heartbeatS}s and the port is not accepting`);
    return { health: "hung", close: true, reasons };
  }
  if (stale) reasons.push(`plugin heartbeat is older than ${input.heartbeatS}s; the process is responding and the port is open, so it is left alone`);
  if (!open) reasons.push("the plugin port is not accepting; the process is responding, so it is left alone");
  return { health: "healthy", close: false, reasons };
}

function syncFor(doc: ObservedDocument, syncs: SyncHint[]): SyncHint | undefined {
  const path = norm(doc.path);
  const title = doc.title.trim().toLowerCase();
  return syncs.find((s) => (s.path && norm(s.path) === path) || (s.title && s.title.trim().toLowerCase() === title));
}

function reportDocument(doc: ObservedDocument, input: RecoveryInput, ids: { pid: number; port: number }): DocumentReport {
  const sync = syncFor(doc, input.syncs);
  const running = input.jobs.some((j) => (j.pid === ids.pid || (j.port != null && j.port === ids.port)) && (j.state === "running" || j.state === "queued"));
  const unsynced = !!(doc.workshared && sync?.next_sync);
  const unsaved = running;
  const lastSave = input.fileMtime(doc.path);
  const protectedOriginal = underRoot(doc.path, input.protectedRoots);
  const known = unsynced || unsaved;
  return {
    title: doc.title,
    path: doc.path,
    workshared: doc.workshared === true,
    family: doc.family === true,
    last_sync: sync?.last_sync ?? null,
    last_save: lastSave,
    unsynced,
    unsaved,
    unsaved_known: known,
    protected_original: protectedOriginal,
    open_as: doc.workshared ? "new_local_from_central" : "file",
    risk: known
      ? "Unsaved or unsynced work may be lost. Apply needs force_unsaved=true."
      : "Unsaved work may be lost: the add-in does not record IsModified. Last save is the file time when it could be read.",
  };
}

function reopenFrom(instances: ClassifiedInstance[], configured: RecoveryDocument[], input: RecoveryInput): DocumentReport[] {
  if (configured.length) {
    return configured.map((doc) => reportDocument({
      title: doc.title ?? doc.role ?? "",
      path: doc.path,
      workshared: doc.workshared === true,
      family: false,
    }, input, { pid: 0, port: 0 }));
  }
  const seen = new Set<string>();
  const out: DocumentReport[] = [];
  for (const inst of instances) {
    if (inst.health === "healthy") continue;
    for (const doc of inst.documents) {
      const key = norm(doc.path) || doc.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(doc);
    }
  }
  return out;
}

export function confirmToken(closePids: number[], documents: { path: string }[], unsaved: boolean): string {
  const body = JSON.stringify({
    close: [...closePids].sort((a, b) => a - b),
    documents: documents.map((d) => norm(d.path)).sort(),
    unsaved,
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export function buildRecoveryPlan(input: RecoveryInput): RecoveryPlan {
  const instances = input.instances.map((inst) => {
    const kind = classifyInstance(inst, input);
    const documents = inst.documents.map((doc) => reportDocument(doc, input, { pid: inst.pid, port: inst.port }));
    return { pid: inst.pid, port: inst.port, ...kind, documents };
  });
  const reopen = reopenFrom(instances, input.documents, input);
  const unsaved = instances.some((i) => i.documents.some((d) => d.unsaved_known)) || reopen.some((d) => d.unsaved_known);
  const would_close = instances.filter((i) => i.close).map((i) => i.pid);
  const plan: RecoveryPlan = {
    action: "plan",
    ok: true,
    confirm: "",
    unsaved,
    heartbeat_s: input.heartbeatS,
    needs_addin: NEEDS_ADDIN,
    instances,
    reopen,
    would_close,
    healthy_left_alone: instances.filter((i) => i.health === "healthy").map((i) => i.pid),
    risk: unsaved
      ? "Unsaved or unsynced changes were found. Apply needs force_unsaved=true. Unsaved work may be lost."
      : "No unsaved change was found in the job log or the batch sync record. Unsaved work may still be lost if it was never recorded.",
    revit_exe: input.revitExe || REVIT_EXE,
  };
  plan.confirm = confirmToken(would_close, reopen, unsaved);
  return plan;
}

export function applyRefusal(plan: RecoveryPlan, args: { confirm?: string; force_unsaved?: boolean }): string | null {
  if (plan.instances.some((i) => i.close && i.health === "healthy")) {
    return "[FMC-RECOVER] Refusing: a healthy instance would be closed. Nothing was closed.";
  }
  if (!args.confirm || args.confirm !== plan.confirm) {
    return "[FMC-RECOVER] Apply needs the confirm token from plan. Nothing was closed.";
  }
  if (plan.unsaved && args.force_unsaved !== true) {
    return "[FMC-RECOVER] Unsaved or unsynced changes were found. Apply again with force_unsaved=true. Nothing was closed.";
  }
  if (!plan.would_close.length && !plan.reopen.length) {
    return "[FMC-RECOVER] Nothing to recover. No crashed or hung instance, and no documents to reopen.";
  }
  return null;
}

export interface RecoveryActions {
  log(line: string): void;
  alive(pid: number): boolean;
  closeGraceful(pid: number): Promise<string>;
  kill(pid: number): Promise<string>;
  startRevit(exe: string, files: string[]): Promise<string>;
  verify?(doc: DocumentReport): Promise<{ ok: boolean; title?: string; path?: string; port?: number; detail: string }>;
  requeue?(): { requeued: unknown[] };
  resume?(): string[];
}

export interface ApplyResult {
  ok: boolean;
  action: "apply";
  message?: string;
  closed: Array<{ pid: number; graceful: string; killed?: string }>;
  started: string;
  verified: Array<{ title: string; path: string; ok: boolean; port?: number; detail: string }>;
  requeued: unknown[];
  resumed: string[];
  needs_addin: string[];
  writes_originals: false;
}

/** Close only the crashed and hung pids in the plan, then start Revit 2025 with the reopen list. */
export async function applyRecovery(plan: RecoveryPlan, args: { confirm?: string; force_unsaved?: boolean }, actions: RecoveryActions): Promise<ApplyResult> {
  const refusal = applyRefusal(plan, args);
  actions.log(`[FMC-RECOVER] apply ${refusal ? "refused" : "starting"}: close ${plan.would_close.join(",") || "none"}; reopen ${plan.reopen.length}`);
  if (refusal) {
    return { ok: false, action: "apply", message: refusal, closed: [], started: "", verified: [], requeued: [], resumed: [], needs_addin: plan.needs_addin, writes_originals: false };
  }
  const closed: ApplyResult["closed"] = [];
  for (const pid of plan.would_close) {
    if (!actions.alive(pid)) {
      closed.push({ pid, graceful: "already gone" });
      actions.log(`[FMC-RECOVER] pid ${pid} is already gone`);
      continue;
    }
    const graceful = await actions.closeGraceful(pid);
    let killed: string | undefined;
    if (actions.alive(pid)) killed = await actions.kill(pid);
    closed.push({ pid, graceful, ...(killed ? { killed } : {}) });
    actions.log(`[FMC-RECOVER] pid ${pid} graceful: ${graceful}${killed ? `; kill: ${killed}` : ""}`);
  }
  const files = plan.reopen.map((d) => d.path).filter(Boolean);
  const started = files.length ? await actions.startRevit(plan.revit_exe, files) : "no files to reopen";
  actions.log(`[FMC-RECOVER] start ${plan.revit_exe}: ${started}. Workshared files are opened as a new local by Revit. This step does not write originals.`);
  const verified: ApplyResult["verified"] = [];
  for (const doc of plan.reopen) {
    if (!actions.verify) {
      verified.push({ title: doc.title, path: doc.path, ok: false, detail: "Verification needs the add-in (fmc_document_info and the leased port)." });
      continue;
    }
    const row = await actions.verify(doc);
    verified.push({ title: row.title || doc.title, path: row.path || doc.path, ok: row.ok, port: row.port, detail: row.detail });
    actions.log(`[FMC-RECOVER] verify ${doc.path}: ${row.detail}`);
  }
  const requeued = actions.requeue ? actions.requeue().requeued : [];
  const resumed = verified.every((v) => v.ok) && actions.resume ? actions.resume() : [];
  actions.log(`[FMC-RECOVER] requeued ${requeued.length}; resumed ${resumed.length}`);
  return { ok: true, action: "apply", closed, started, verified, requeued, resumed, needs_addin: plan.needs_addin, writes_originals: false };
}
