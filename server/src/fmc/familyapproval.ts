/**
 * F134 (GB-1, GB-2, RC-3; FINAL APPROVED 2026-11-28 12:10 EAT): the family_overwrite gate for fmc_recipe build,
 * fmc_recipe batch and so fmc_generate_bind.
 *
 * - First build (the staging .rfa is absent): no approval, no archive. overwrite: true on a missing file is a no-op.
 * - Overwrite (the .rfa exists): overwrite: true and a single-use family_overwrite record bound to the target path,
 *   the existing file's sha256 (size and mtime recorded too) and the plan (the recipe hash). Expiry 30 minutes.
 *   Then archive-before-overwrite (copy, verify size and sha256, rename into <folder>\_Archive\<stamp>_<name>),
 *   then the record is claimed (used), then the originals leave staging, then the build. Every mode, testing too.
 * - Testing mode (ai_modeller.mode "testing" with auto_approve true) may approve the record itself: that skips only
 *   the person's click; the record, binding, single use and archive stay. auto_approve in any other mode does nothing.
 * - A failed archive refuses, leaves the originals in place and does not claim the record (a retry may use it).
 *
 * The status of a record is set only by the pane (familyapproval_pane.ts setStatus), never by an MCP tool, and
 * claimApproval is internal to requireFamilyApproval: no tool argument (confirm, plan_id, overwrite, ...) can approve.
 * protected_roots: only the named originals folders in fmc_guard.json are refused (an empty list refuses nothing).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { archivePlan, isInside, type GuardConfig, type Verdict } from "./policy.js";
import { protectedRoots } from "./opencopy.js";
import { formcraftDir, loadAiConfig } from "./aiuse_io.js";

const win = path.win32;

export const FAMILY_OVERWRITE = "family_overwrite" as const;
/** O2 (recommended default, followed): an approval lasts 30 minutes. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** The file calls the gate makes; real fs by default, an in-memory one in tests. */
export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string): Buffer;
  writeFileSync(p: string, data: string | Buffer): void;
  statSync(p: string): { size: number; mtimeMs: number; isDirectory(): boolean };
  readdirSync(p: string): string[];
  mkdirSync(p: string, o: { recursive: true }): unknown;
  copyFileSync(from: string, to: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
}

export const realFs: FsLike = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  statSync: (p) => fs.statSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  copyFileSync: (a, b) => fs.copyFileSync(a, b),
  renameSync: (a, b) => fs.renameSync(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used";

export interface FamilyApproval {
  id: string;
  kind: typeof FAMILY_OVERWRITE;
  status: ApprovalStatus;
  family: string;
  /** Binding: the staged .rfa this overwrites. */
  target: string;
  /** Binding: sha256 of the .rfa when the record was made; size and mtime recorded beside it. */
  sha256: string;
  size: number;
  mtime_ms: number;
  /** Binding: the plan (the recipe hash fmc_recipe computes from the recipe it would build). */
  plan: string;
  /** The caller's plan_id (fmc_generate_bind), shown in the pane; not part of the binding. */
  plan_label?: string;
  created_at: string;
  expires_at: string;
  requested_by: string;
  approved_by?: string;
  approved_at?: string;
  auto?: boolean;
  used_at?: string;
  archived?: string[];
}

export interface ApprovalDeps {
  fs?: FsLike;
  /** The record file (default %APPDATA%\Formcraft\approvals\family_overwrite.json). */
  store?: string;
  now?: () => Date;
  /** Who asks (the MCP client); shown in the pane. */
  caller?: string;
}

export function approvalStore(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(formcraftDir(env), "approvals", "family_overwrite.json");
}

const deps0 = (d: ApprovalDeps) => ({ fs: d.fs ?? realFs, store: d.store ?? approvalStore(), now: d.now ?? (() => new Date()), caller: d.caller ?? "mcp" });

export function readApprovals(d: ApprovalDeps = {}): FamilyApproval[] {
  const { fs: f, store } = deps0(d);
  try {
    if (!f.existsSync(store)) return [];
    const raw = JSON.parse(f.readFileSync(store).toString("utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(raw?.records) ? raw.records.filter((r: FamilyApproval) => r && r.kind === FAMILY_OVERWRITE) : [];
  } catch { return []; }
}

/** Written whole (temp file then rename) so a half-written store is never read. */
export function writeApprovals(records: FamilyApproval[], d: ApprovalDeps = {}): void {
  const { fs: f, store } = deps0(d);
  f.mkdirSync(win.dirname(store), { recursive: true });
  const tmp = `${store}.${process.pid}.tmp`;
  f.writeFileSync(tmp, JSON.stringify({ kind: FAMILY_OVERWRITE, records }, null, 2));
  f.renameSync(tmp, store);
}

export function sha256Of(f: FsLike, file: string): string {
  return crypto.createHash("sha256").update(f.readFileSync(file)).digest("hex");
}

export function samePath(a: string, b: string): boolean {
  return win.normalize(a).replace(/\\+$/, "").toLowerCase() === win.normalize(b).replace(/\\+$/, "").toLowerCase();
}

/** The plan a family_overwrite record binds: the recipe as it will be built, and its staging target. */
export function recipePlan(recipe: unknown, target: string): string {
  return "rp-" + crypto.createHash("sha256").update(JSON.stringify({ recipe, target: win.normalize(target).toLowerCase() })).digest("hex").slice(0, 24);
}

/** Testing mode with auto_approve: the server may approve a family_overwrite record itself. Nothing else may. */
export function autoApproveAllowed(cfg: GuardConfig): boolean {
  const ai = loadAiConfig(cfg);
  return ai?.mode === "testing" && ai.auto_approve === true;
}

/**
 * protected_roots: the named originals folders only. A path inside a named entry is refused (fail closed); a path that
 * is not inside one is never refused for its name (a "Fomcraft" in it means nothing). An empty list refuses nothing.
 */
export function protectedRootVerdict(target: string, cfg: GuardConfig): Verdict {
  const named = protectedRoots(cfg).filter((r) => typeof r === "string" && r.trim());
  const hit = named.find((r) => isInside(target, r));
  return hit
    ? { ok: false, reasons: [`${target} is inside a named originals folder in protected_roots (${hit}): nothing is written, saved, overwritten or archived there`] }
    : { ok: true, reasons: [] };
}

export interface ArchivedFile { from: string; to: string; sha256: string; size: number }

/** What a real overwrite would move: the .rfa, its .000N backups, <family>.recipe.json and <family>.gate.json. */
export function archiveMoves(target: string, f: FsLike, now: Date): Array<[string, string]> {
  const dir = win.dirname(target);
  let siblings: string[] = [];
  try { siblings = f.readdirSync(dir); } catch { siblings = []; }
  const moves = archivePlan(target, siblings, now).moves;
  const stampDir = win.dirname(moves[0][1]);
  const stamp = win.basename(moves[0][1]).slice(0, 16); // yyyyMMdd-HHmmss_
  for (const extra of [target.replace(/\.rfa$/i, ".recipe.json"), target.replace(/\.rfa$/i, ".gate.json")])
    if (f.existsSync(extra)) moves.push([extra, win.join(stampDir, stamp + win.basename(extra))]);
  return moves;
}

/**
 * Archive-before-overwrite, step one: copy every file into _Archive under a .partial name, check size and sha256
 * against the original, then rename the copy to its archive name. Nothing in staging changes here. On any failure the
 * copies made are removed and the originals stay as they were.
 */
export function archiveCopies(target: string, f: FsLike, now: Date, checkDest: (dest: string) => Verdict):
  { ok: true; files: ArchivedFile[] } | { ok: false; reason: string } {
  const moves = archiveMoves(target, f, now);
  const made: string[] = [];
  const undo = () => { for (const m of made.reverse()) { try { f.unlinkSync(m); } catch { /* best effort */ } } };
  try {
    const dir = win.dirname(moves[0][1]);
    const where = checkDest(moves[0][1]);
    if (!where.ok) return { ok: false, reason: where.reasons.join("; ") };
    f.mkdirSync(dir, { recursive: true });
    if (!f.statSync(dir).isDirectory()) return { ok: false, reason: `${dir} is not a folder` };
    const files: ArchivedFile[] = [];
    for (const [from, to] of moves) {
      if (f.existsSync(to)) throw new Error(`${to} already exists in the archive`);
      const want = sha256Of(f, from), size = f.statSync(from).size;
      const partial = to + ".partial";
      f.copyFileSync(from, partial);
      made.push(partial);
      if (f.statSync(partial).size !== size || sha256Of(f, partial) !== want) throw new Error(`the archive copy of ${from} doesn't match it`);
      f.renameSync(partial, to);
      made.pop();
      made.push(to);
      files.push({ from, to, sha256: want, size });
    }
    return { ok: true, files };
  } catch (e) {
    undo();
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export type GateResult =
  | { ok: true; overwrite: false }
  | { ok: true; overwrite: true; approval: FamilyApproval; archived: ArchivedFile[] }
  | { ok: false; waiting: true; code: "FMC-GB-WAITING"; approval_id: string; expires_at: string; reasons: string[] }
  | { ok: false; waiting?: false; code: "FMC-GB-EXISTS" | "FMC-GB-APPROVAL" | "FMC-GB-ARCHIVE"; reasons: string[]; approval_id?: string };

export interface GateInput {
  family: string;
  target: string;
  /** The plan the record binds (recipePlan of the recipe fmc_recipe would build). */
  plan: string;
  planLabel?: string;
  overwrite: boolean;
  approvalId?: string;
  cfg: GuardConfig;
  /** Is an archive destination writable (write_roots, protected_roots)? */
  checkDest: (dest: string) => Verdict;
}

/** The single-use claim: approved → used, once, after a verified archive and before the build. Internal on purpose. */
function claimApproval(id: string, archived: ArchivedFile[], d: ApprovalDeps): FamilyApproval {
  const { now } = deps0(d);
  const records = readApprovals(d);
  const rec = records.find((r) => r.id === id);
  if (!rec || rec.status !== "approved") throw new Error(`approval ${id} is not approved any more`);
  rec.status = "used";
  rec.used_at = now().toISOString();
  rec.archived = archived.map((a) => a.to);
  writeApprovals(records, d);
  return rec;
}

/**
 * The gate. existing: does the staged .rfa exist right now (the caller looked just before). A dry run never calls
 * this: it writes nothing, archives nothing and consumes nothing.
 */
export function requireFamilyApproval(g: GateInput, existing: boolean, d: ApprovalDeps = {}): GateResult {
  if (!existing) return { ok: true, overwrite: false };
  if (!g.overwrite)
    return { ok: false, code: "FMC-GB-EXISTS", reasons: [`${g.target} exists: replacing it is an overwrite (overwrite: true and a family_overwrite approval; the old files go to _Archive first)`] };
  const { fs: f, now, caller } = deps0(d);
  const at = now();
  const stat = f.statSync(g.target);
  const sha = sha256Of(f, g.target);
  const auto = autoApproveAllowed(g.cfg);
  const records = readApprovals(d);
  const live = (r: FamilyApproval) => Date.parse(r.expires_at) > at.getTime();
  const bound = (r: FamilyApproval) => samePath(r.target, g.target) && r.sha256 === sha && r.plan === g.plan;
  let rec: FamilyApproval | undefined;
  const id = (g.approvalId ?? "").trim();
  if (id) {
    rec = records.find((r) => r.id === id);
    const refuse = (why: string): GateResult => ({ ok: false, code: "FMC-GB-APPROVAL", approval_id: id, reasons: [why] });
    if (!rec) return refuse(`No family_overwrite approval ${id}`);
    if (rec.status === "used") return refuse(`Approval ${id} was already used (single use): a new overwrite needs a new approval`);
    if (rec.status === "rejected") return refuse(`Approval ${id} was rejected in the pane`);
    if (!live(rec)) return refuse(`Approval ${id} expired at ${rec.expires_at}`);
    if (!samePath(rec.target, g.target)) return refuse(`Approval ${id} is for ${rec.target}, not ${g.target}`);
    if (rec.sha256 !== sha) return refuse(`${g.target} changed since approval ${id} was made (sha256 ${sha.slice(0, 12)}…, approved ${rec.sha256.slice(0, 12)}…): nothing was overwritten`);
    if (rec.plan !== g.plan) return refuse(`Approval ${id} is for another plan: the recipe changed since it was made. Run the dry run again`);
  } else {
    // the same overwrite asked again: the same record, not a new one each call
    rec = records.find((r) => r.status !== "used" && r.status !== "rejected" && live(r) && bound(r));
  }
  if (!rec) {
    rec = {
      id: "fo-" + crypto.randomBytes(6).toString("hex"), kind: FAMILY_OVERWRITE, status: "pending", family: g.family, target: g.target,
      sha256: sha, size: stat.size, mtime_ms: stat.mtimeMs, plan: g.plan, ...(g.planLabel ? { plan_label: g.planLabel } : {}),
      created_at: at.toISOString(), expires_at: new Date(at.getTime() + APPROVAL_TTL_MS).toISOString(), requested_by: caller,
    };
    records.push(rec);
  }
  if (rec.status === "pending" && auto) {
    rec.status = "approved";
    rec.auto = true;
    rec.approved_by = "auto_approve (testing mode)";
    rec.approved_at = at.toISOString();
  }
  writeApprovals(records, d);
  if (rec.status !== "approved")
    return { ok: false, waiting: true, code: "FMC-GB-WAITING", approval_id: rec.id, expires_at: rec.expires_at,
      reasons: [`Overwriting ${g.target} waits for a person: approve ${rec.id} in the pane (Families › Approvals) before ${rec.expires_at}, then call again with approval_id ${rec.id}. Nothing was written.`] };
  // archive before overwrite; a failure leaves the originals and the approval as they were
  const copies = archiveCopies(g.target, f, at, g.checkDest);
  if (!copies.ok)
    return { ok: false, code: "FMC-GB-ARCHIVE", approval_id: rec.id,
      reasons: [`The archive before the overwrite failed (${copies.reason}): nothing was built, the staged files are unchanged and approval ${rec.id} is still unused`] };
  // the bytes archived are the bytes approved (the file can't change between the check and the copy unnoticed)
  const rfa = copies.files.find((a) => samePath(a.from, g.target));
  if (!rfa || rfa.sha256 !== rec.sha256) {
    for (const a of copies.files) { try { f.unlinkSync(a.to); } catch { /* best effort */ } }
    return { ok: false, code: "FMC-GB-APPROVAL", approval_id: rec.id, reasons: [`${g.target} changed while it was archived: nothing was built and approval ${rec.id} is still unused`] };
  }
  let used: FamilyApproval;
  try { used = claimApproval(rec.id, copies.files, d); }
  catch (e) {
    for (const a of copies.files) { try { f.unlinkSync(a.to); } catch { /* best effort */ } }
    return { ok: false, code: "FMC-GB-APPROVAL", approval_id: rec.id,
      reasons: [`Approval ${rec.id} couldn't be claimed (${e instanceof Error ? e.message : String(e)}): nothing was built and the staged files are unchanged`] };
  }
  // the originals leave staging only now: archived, verified and the approval used
  for (const a of copies.files) f.unlinkSync(a.from);
  return { ok: true, overwrite: true, approval: used, archived: copies.files };
}
