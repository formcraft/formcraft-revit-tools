/**
 * Person-only, single-use, expiring approvals for graph runs (FC-1 pattern, DT-57, DT-65).
 * The AI may only request one. Only the pane's CLI (graph_approve, graph_refuse) decides; no MCP tool does.
 * A run claims the approval (status "used") before Revit or DynamoCLI starts, so a timeout never leaves it open.
 * Store: %LOCALAPPDATA%\Formcraft\graph_approvals\<id>.json (FMC_GRAPH_APPROVALS overrides it for tests).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GraphApprovalKind = "graph_run" | "graph_python" | "graph_offline" | "script_python";
export type GraphApprovalStatus = "pending" | "approved" | "refused" | "used" | "expired";

export interface GraphApproval {
  id: string;
  kind: GraphApprovalKind;
  status: GraphApprovalStatus;
  plan_hash: string;
  graph: string;
  graph_sha256: string;
  inputs_hash: string;
  scan_hash: string;
  allowlist_version: string;
  mode: string;
  document: { title: string; path: string; state: string };
  python: boolean;
  findings: number;
  reason: string;
  requested_by: string;
  created_at: string;
  expires_at: string;
  decided_by?: string;
  decided_at?: string;
  used_at?: string;
}

export interface ApprovalRequest {
  kind: GraphApprovalKind;
  plan: {
    plan_hash: string; graph: string; graph_sha256: string; inputs_hash: string; scan_hash: string;
    allowlist_version: string; mode: string; document: { title: string; path: string; state: string }; python: boolean;
  };
  findings?: number;
  reason?: string;
  /** Ignored since v1.3: who asked is never taken from the caller. See `surface`. */
  requested_by?: string;
  /** v1.3: "pane" only from the pane CLI's graph_request (the same trusted surface as graph_approve); anything else is "mcp". */
  surface?: RequestSurface;
  ttl_minutes?: number;
}

export type RequestSurface = "mcp" | "pane";

/** The OS user the pane runs as (never a caller-supplied string). Empty when it is missing, odd, or looks automated. */
export function paneUser(env: NodeJS.ProcessEnv = process.env): string {
  let user = "";
  try { user = os.userInfo().username; } catch { user = ""; }
  user = (user || env.USERNAME || env.USER || "").trim();
  return /^[A-Za-z0-9._@ $-]{1,64}$/.test(user) && !/^auto/i.test(user) ? user : "";
}

/** requested_by for a request: "person:<OS user>" only from the pane surface, "ai" for every MCP or AI caller. */
export function requesterFor(surface: RequestSurface | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (surface === "pane") {
    const user = paneUser(env);
    if (user) return `person:${user}`;
  }
  return "ai";
}

export type ClaimResult = { ok: true; approval: GraphApproval } | { ok: false; code: string; message: string };

export function approvalsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FMC_GRAPH_APPROVALS?.trim()) return env.FMC_GRAPH_APPROVALS.trim();
  const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Formcraft", "graph_approvals");
}

function cleanId(id: string): string {
  return /^[0-9a-f]{16}$/.test(id) ? id : "";
}

function fileOf(id: string, env: NodeJS.ProcessEnv): string {
  return path.join(approvalsDir(env), `${id}.json`);
}

function write(item: GraphApproval, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(approvalsDir(env), { recursive: true });
  const file = fileOf(item.id, env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(item, null, 2));
  fs.renameSync(tmp, file);
}

function expired(item: GraphApproval, now: Date): boolean {
  return Date.parse(item.expires_at) <= now.getTime();
}

/** A pending approval for exactly this plan. Asking again for the same pending plan returns the same record. */
export function requestGraphApproval(req: ApprovalRequest, env: NodeJS.ProcessEnv = process.env, now = new Date()): GraphApproval {
  const ttl = Math.max(1, Math.min(30, req.ttl_minutes ?? 30));
  const requestedBy = requesterFor(req.surface, env);
  for (const old of listGraphApprovals({ status: "pending" }, env, now)) {
    if (old.plan_hash === req.plan.plan_hash && old.kind === req.kind) {
      appendGraphRunLog({ event: "approval_requested", id: old.id, kind: old.kind, plan_hash: old.plan_hash, requested_by: requestedBy, recorded_requested_by: old.requested_by, reused: true }, env, now);
      return old;
    }
  }
  const item: GraphApproval = {
    id: crypto.randomBytes(8).toString("hex"),
    kind: req.kind,
    status: "pending",
    plan_hash: req.plan.plan_hash,
    graph: req.plan.graph,
    graph_sha256: req.plan.graph_sha256,
    inputs_hash: req.plan.inputs_hash,
    scan_hash: req.plan.scan_hash,
    allowlist_version: req.plan.allowlist_version,
    mode: req.plan.mode,
    document: { ...req.plan.document },
    python: req.plan.python,
    findings: req.findings ?? 0,
    reason: (req.reason ?? "").slice(0, 500),
    requested_by: requestedBy,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 60_000).toISOString(),
  };
  write(item, env);
  appendGraphRunLog({ event: "approval_requested", id: item.id, kind: item.kind, plan_hash: item.plan_hash, graph: item.graph, mode: item.mode, requested_by: item.requested_by }, env, now);
  return item;
}

export function readGraphApproval(id: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): GraphApproval | null {
  const key = cleanId(id.trim());
  if (!key) return null;
  try {
    const item = JSON.parse(fs.readFileSync(fileOf(key, env), "utf8")) as GraphApproval;
    if ((item.status === "pending" || item.status === "approved") && expired(item, now)) return { ...item, status: "expired" };
    return item;
  } catch {
    return null;
  }
}

export function listGraphApprovals(filter: { status?: GraphApprovalStatus } = {}, env: NodeJS.ProcessEnv = process.env, now = new Date()): GraphApproval[] {
  let names: string[] = [];
  try { names = fs.readdirSync(approvalsDir(env)).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)); } catch { return []; }
  return names
    .map((f) => readGraphApproval(f.slice(0, 16), env, now))
    .filter((x): x is GraphApproval => !!x && (!filter.status || x.status === filter.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * The pane's decision (a person). Never offered as an MCP tool. `by` is the Windows user the pane runs as.
 * Only a pending, unexpired record can be decided.
 */
export function decideGraphApproval(id: string, decision: "approved" | "refused", by: string, env: NodeJS.ProcessEnv = process.env, now = new Date()):
  { ok: true; approval: GraphApproval } | { ok: false; code: string; message: string } {
  const item = readGraphApproval(id, env, now);
  if (!item) return { ok: false, code: "FMC-GRAPH-APPROVAL-NOT-FOUND", message: `[FMC-GRAPH-APPROVAL-NOT-FOUND] No graph approval ${id}.` };
  if (item.status !== "pending") return { ok: false, code: "FMC-GRAPH-APPROVAL-DECIDED", message: `[FMC-GRAPH-APPROVAL-DECIDED] Graph approval ${id} is ${item.status}.` };
  const who = by.trim();
  if (!who || /^auto/i.test(who)) return { ok: false, code: "FMC-GRAPH-APPROVAL-AUTO", message: "[FMC-GRAPH-APPROVAL-AUTO] A graph approval needs a named person." };
  const next: GraphApproval = { ...item, status: decision, decided_by: who.slice(0, 100), decided_at: now.toISOString() };
  write(next, env);
  appendGraphRunLog({ event: `approval_${decision}`, id: next.id, kind: next.kind, plan_hash: next.plan_hash, requested_by: next.requested_by, decided_by: next.decided_by }, env, now);
  return { ok: true, approval: next };
}

/**
 * Takes the approval for one run of exactly this plan. Marked used before anything runs.
 * Refuses when missing, pending, refused, used, expired, decided by "auto…", or bound to another plan.
 */
export function claimGraphApproval(id: string, planHash: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): ClaimResult {
  const no = (code: string, message: string): ClaimResult => ({ ok: false, code, message: `[${code}] ${message}` });
  const item = readGraphApproval(id, env, now);
  if (!item) return no("FMC-GRAPH-APPROVAL-NOT-FOUND", `No graph approval ${id || "(none)"}.`);
  if (item.status === "pending") return no("FMC-GRAPH-APPROVAL-PENDING", `Graph approval ${id} still waits for a person in the pane.`);
  if (item.status === "refused") return no("FMC-GRAPH-APPROVAL-REFUSED", `A person refused graph approval ${id}.`);
  if (item.status === "used") return no("FMC-GRAPH-APPROVAL-USED", `Graph approval ${id} was already used once. Ask for a new one.`);
  if (item.status === "expired") return no("FMC-GRAPH-APPROVAL-EXPIRED", `Graph approval ${id} expired at ${item.expires_at}. Ask for a new one.`);
  if (!item.decided_by || /^auto/i.test(item.decided_by)) return no("FMC-GRAPH-APPROVAL-AUTO", `Graph approval ${id} was not given by a person.`);
  if (item.plan_hash !== planHash) {
    return no("FMC-GRAPH-APPROVAL-MISMATCH", `Graph approval ${id} is for plan ${item.plan_hash.slice(0, 12)}…, but this run is plan ${planHash.slice(0, 12)}…. The graph, its inputs, the mode, the model on disk, the scan or the allowlist changed.`);
  }
  const used: GraphApproval = { ...item, status: "used", used_at: now.toISOString() };
  // Single use across processes: an exclusive marker file; a second claimer loses even if it read "approved".
  const marker = `${fileOf(item.id, env)}.used`;
  try { fs.writeFileSync(marker, now.toISOString(), { flag: "wx" }); }
  catch { return no("FMC-GRAPH-APPROVAL-USED", `Graph approval ${id} was already used once. Ask for a new one.`); }
  write(used, env);
  return { ok: true, approval: used };
}

/** One line per gated run: never model content, never a token. */
export function appendGraphRunLog(row: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, now = new Date()): void {
  try {
    const dir = path.dirname(approvalsDir(env));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "graph_runs.jsonl"), JSON.stringify({ at: now.toISOString(), ...row }) + "\n");
  } catch { /* logging never blocks the work */ }
}
