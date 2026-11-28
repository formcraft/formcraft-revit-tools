/**
 * BSF-3 safe family load / reload / overwrite (Emlyn, live call 28 Nov 2026 13:24 EAT; FAMILY_COVERAGE_REVIEW item 1).
 * One rule for revit_file load_family and export_family, modify_model load_into_project and save_family, new_family,
 * fmc_doc save and the fmc_legend chain load:
 *
 *  (a) never overwrite by default: an existing file, or a family already in the project, without overwrite: true is
 *      refused with FMC-FAM-EXISTS (and the preview);
 *  (b) a preview first: the project's types of that family with their instance counts, and the type changes where
 *      cheap (the add-in's fmc_family_preview);
 *  (c) archive before replace: the old .rfa (the file, or the project's family exported by the add-in) goes to an
 *      _Archive folder inside the project's jail before anything is replaced; a failed archive replaces nothing;
 *  (d) one approval per overwrite, single use, 30 minutes, bound to the target, the fingerprint of what is replaced and
 *      the archive path it carries. A person approves in the pane (familyload_pane.ts). A blanket approval that a person
 *      wrote into fmc_guard.json (family_overwrite_blanket, Emlyn 12:59 EAT) approves the record itself: it removes the
 *      click only; the record, the binding, the archive and the path rule stay. Testing auto_approve does NOT approve.
 *      Deletes, removes and purges are not covered by any of this: they still need a person.
 *  (e) every path is a jail path (fmc/jail.ts): inside the open project's folder; the kit and standards are read-only;
 *      kit staging writes are refused behind kit_staging_writes (off by default; Q4 is open).
 *
 * Pattern: F134 familyapproval.ts (family-generator-bot b1d08b8), read only, re-written for project families.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formcraftDir } from "./aiuse_io.js";
import type { GuardConfig } from "./policy.js";
import { jailCheck, type JailKind, type JailRoots } from "./jail.js";

const win = path.win32;

export const FAMILY_LOAD = {
  EXISTS: "FMC-FAM-EXISTS",
  WAITING: "FMC-FAM-WAITING",
  APPROVAL: "FMC-FAM-APPROVAL",
  ARCHIVE: "FMC-FAM-ARCHIVE",
  PATH: "FMC-FAM-PATH",
  PREVIEW: "FMC-FAM-PREVIEW",
} as const;
export type FamilyLoadCode = (typeof FAMILY_LOAD)[keyof typeof FAMILY_LOAD];

export const FAMILY_OVERWRITE_TTL_MS = 30 * 60 * 1000;

/** file: an .rfa on disk is replaced (save_family, export_family, new_family, fmc_doc save). reload: a family already in a project. */
export type OverwriteKind = "file" | "reload";

export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string): Buffer;
  writeFileSync(p: string, data: string | Buffer): void;
  statSync(p: string): { size: number; mtimeMs: number; isDirectory(): boolean };
  mkdirSync(p: string, o: { recursive: true }): unknown;
  copyFileSync(from: string, to: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
}
export const realFs: FsLike = {
  existsSync: (p) => fs.existsSync(p), readFileSync: (p) => fs.readFileSync(p), writeFileSync: (p, d) => fs.writeFileSync(p, d),
  statSync: (p) => fs.statSync(p), mkdirSync: (p, o) => fs.mkdirSync(p, o), copyFileSync: (a, b) => fs.copyFileSync(a, b),
  renameSync: (a, b) => fs.renameSync(a, b), unlinkSync: (p) => fs.unlinkSync(p),
};

export type FamilyOverwriteStatus = "pending" | "approved" | "rejected" | "used";

export interface FamilyOverwriteRecord {
  id: string;
  kind: "family_load_overwrite";
  op: string;
  overwrite: OverwriteKind;
  status: FamilyOverwriteStatus;
  family: string;
  /** The project document (its path) the family is loaded into, or "" for a file overwrite outside a load. */
  project: string;
  /** file: the .rfa replaced. reload: "<project path>#<family name>". */
  target: string;
  /** What is replaced: the file's sha256, or the hash of the project family's preview and the incoming source. */
  fingerprint: string;
  /** Where the old family goes first: always inside the project's jail. */
  archive: string;
  /** The preview shown in the pane: types, instance counts, type changes. */
  preview?: unknown;
  source?: string;
  created_at: string;
  expires_at: string;
  requested_by: string;
  approved_by?: string;
  approved_at?: string;
  blanket?: boolean;
  used_at?: string;
}

export interface FamilyLoadDeps { fs?: FsLike; store?: string; now?: () => Date; caller?: string }

export function familyLoadStore(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(formcraftDir(env), "approvals", "family_load.json");
}
const d0 = (d: FamilyLoadDeps) => ({ fs: d.fs ?? realFs, store: d.store ?? familyLoadStore(), now: d.now ?? (() => new Date()), caller: d.caller ?? "mcp" });

export function readFamilyOverwrites(d: FamilyLoadDeps = {}): FamilyOverwriteRecord[] {
  const { fs: f, store } = d0(d);
  try {
    if (!f.existsSync(store)) return [];
    const raw = JSON.parse(f.readFileSync(store).toString("utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(raw?.records) ? raw.records.filter((r: FamilyOverwriteRecord) => r && r.kind === "family_load_overwrite") : [];
  } catch { return []; }
}

function writeFamilyOverwrites(records: FamilyOverwriteRecord[], d: FamilyLoadDeps): void {
  const { fs: f, store } = d0(d);
  f.mkdirSync(win.dirname(store), { recursive: true });
  const tmp = `${store}.${process.pid}.tmp`;
  f.writeFileSync(tmp, JSON.stringify({ kind: "family_load_overwrite", records }, null, 2));
  f.renameSync(tmp, store);
}

export const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");
export const sameTarget = (a: string, b: string) =>
  win.normalize(a).replace(/\\+$/, "").toLowerCase() === win.normalize(b).replace(/\\+$/, "").toLowerCase();

/**
 * The blanket approval a person wrote into fmc_guard.json (Emlyn 12:59 EAT: loading and overwriting families in the
 * project): { "family_overwrite_blanket": { "approved_by": "...", "approved_at": "..." } }. The AI can't write the guard
 * file (shared state, protected), so a record approved this way still traces to a person. Anything else: no blanket.
 */
export function familyBlanket(cfg: GuardConfig): { by: string; at: string } | null {
  const b = (cfg as { family_overwrite_blanket?: { approved_by?: unknown; approved_at?: unknown } }).family_overwrite_blanket;
  const by = typeof b?.approved_by === "string" ? b.approved_by.trim() : "";
  const at = typeof b?.approved_at === "string" ? b.approved_at.trim() : "";
  return by && at && !/^(auto|ai|mcp|claude|bot)/i.test(by) ? { by, at } : null;
}

const stamp = (t: Date) => t.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 120) || "family";

/**
 * The archive folder for a project: <project folder>\_Archive\Families when the project has a folder root (the folder
 * above 01_WIP, or the central's folder), else the document's own backup folder (<stem>_backup\_Archive\Families).
 * Always checked as a jail write; "" when the project has no folder the jail allows (unsaved, cloud).
 */
export function archiveFolderFor(projectPath: string, roots: JailRoots, cfg: GuardConfig): string {
  if (!projectPath) return "";
  const dir = win.dirname(projectPath);
  const stem = win.basename(projectPath).replace(/\.[^.]+$/, "");
  const candidates = [
    ...roots.docRoots.filter((r) => r.kind === "folder").map((r) => win.join(r.path, "_Archive", "Families")),
    win.join(dir, "_Archive", "Families"),
    win.join(dir, `${stem}_backup`, "_Archive", "Families"),
  ];
  for (const c of candidates) if (jailCheck("write", c, roots, cfg).ok) return c;
  return "";
}

/** The archive file for one overwrite: <folder>\<yyyyMMdd-HHmmss>_<family>.rfa (never an existing file). */
export function archivePathFor(folder: string, family: string, now: Date, f: FsLike = realFs): string {
  let p = win.join(folder, `${stamp(now)}_${safeName(family)}.rfa`);
  for (let i = 2; f.existsSync(p) && i < 100; i++) p = win.join(folder, `${stamp(now)}_${safeName(family)}_${i}.rfa`);
  return p;
}

export interface OverwriteAsk {
  op: string;
  overwrite: OverwriteKind;
  family: string;
  project: string;
  target: string;
  fingerprint: string;
  /** The archive folder (archiveFolderFor); the record carries the file inside it. */
  archiveFolder: string;
  wantOverwrite: boolean;
  approvalId?: string;
  preview?: unknown;
  source?: string;
  cfg: GuardConfig;
  roots: JailRoots;
}

export type OverwriteGate =
  | { ok: true; overwrite: false }
  | { ok: true; overwrite: true; record: FamilyOverwriteRecord; archive: string }
  | { ok: false; code: FamilyLoadCode; message: string; approval_id?: string; archive?: string; expires_at?: string; preview?: unknown };

/**
 * The gate. existing: is there something to replace right now (the file exists, or the preview found the family in the
 * project). It never archives and never claims: the caller archives (archiveFile, or the add-in's export), then
 * claimFamilyOverwrite, then writes. A dry run never calls it with wantOverwrite and consumes nothing.
 */
export function requireFamilyOverwrite(a: OverwriteAsk, existing: boolean, d: FamilyLoadDeps = {}): OverwriteGate {
  if (!existing) return { ok: true, overwrite: false };
  const what = a.overwrite === "file" ? a.target : `${a.family} in ${a.project}`;
  if (!a.wantOverwrite)
    return { ok: false, code: FAMILY_LOAD.EXISTS, preview: a.preview,
      message: `[${FAMILY_LOAD.EXISTS}] ${what} already exists: nothing was replaced. Replacing it is an overwrite: look at the preview, ` +
        "then call again with overwrite: true (one approval per overwrite; the old family is archived inside the project first)." };
  if (!a.archiveFolder || !jailCheck("write", a.archiveFolder, a.roots, a.cfg).ok)
    return { ok: false, code: FAMILY_LOAD.ARCHIVE, preview: a.preview,
      message: `[${FAMILY_LOAD.ARCHIVE}] No archive folder inside the project's jail for ${a.project || a.target}: an overwrite needs one, so nothing was replaced.` };
  const { now, caller } = d0(d);
  const at = now();
  const records = readFamilyOverwrites(d);
  const live = (r: FamilyOverwriteRecord) => Date.parse(r.expires_at) > at.getTime();
  const bound = (r: FamilyOverwriteRecord) => r.op === a.op && r.overwrite === a.overwrite && sameTarget(r.target, a.target) && r.fingerprint === a.fingerprint;
  const id = (a.approvalId ?? "").trim();
  let rec: FamilyOverwriteRecord | undefined;
  if (id) {
    rec = records.find((r) => r.id === id);
    const no = (why: string): OverwriteGate => ({ ok: false, code: FAMILY_LOAD.APPROVAL, approval_id: id, preview: a.preview, message: `[${FAMILY_LOAD.APPROVAL}] ${why}: nothing was replaced.` });
    if (!rec) return no(`No family overwrite approval ${id}`);
    if (rec.status === "used") return no(`Approval ${id} was already used (one approval per overwrite)`);
    if (rec.status === "rejected") return no(`Approval ${id} was rejected in the pane`);
    if (!live(rec)) return no(`Approval ${id} expired at ${rec.expires_at}`);
    if (!bound(rec)) return no(`Approval ${id} is for another overwrite (${rec.op} ${rec.target}), or what it replaces changed since (run the preview again)`);
  } else {
    rec = records.find((r) => r.status !== "used" && r.status !== "rejected" && live(r) && bound(r));
  }
  if (!rec) {
    rec = {
      id: "fl-" + crypto.randomBytes(6).toString("hex"), kind: "family_load_overwrite", op: a.op, overwrite: a.overwrite, status: "pending",
      family: a.family, project: a.project, target: a.target, fingerprint: a.fingerprint,
      archive: archivePathFor(a.archiveFolder, a.family, at, d.fs ?? realFs),
      ...(a.preview !== undefined ? { preview: a.preview } : {}), ...(a.source ? { source: a.source } : {}),
      created_at: at.toISOString(), expires_at: new Date(at.getTime() + FAMILY_OVERWRITE_TTL_MS).toISOString(), requested_by: caller,
    };
    records.push(rec);
  }
  const blanket = familyBlanket(a.cfg);
  if (rec.status === "pending" && blanket) {
    rec.status = "approved"; rec.blanket = true; rec.approved_by = `blanket: ${blanket.by} (${blanket.at})`; rec.approved_at = at.toISOString();
  }
  writeFamilyOverwrites(records, d);
  // the archive must still be a jail write (the record carries it; a changed guard file must not open a hole)
  if (!jailCheck("write", rec.archive, a.roots, a.cfg).ok)
    return { ok: false, code: FAMILY_LOAD.ARCHIVE, approval_id: rec.id, message: `[${FAMILY_LOAD.ARCHIVE}] ${rec.archive} is no longer inside the project's jail: nothing was replaced.` };
  if (rec.status !== "approved")
    return { ok: false, code: FAMILY_LOAD.WAITING, approval_id: rec.id, archive: rec.archive, expires_at: rec.expires_at, preview: a.preview,
      message: `[${FAMILY_LOAD.WAITING}] Overwriting ${what} waits for a person: approve ${rec.id} in the pane (Families › Approvals) before ` +
        `${rec.expires_at}, then call again with approval_id ${rec.id}. The old family will be archived to ${rec.archive} first. Nothing was replaced.` };
  return { ok: true, overwrite: true, record: rec, archive: rec.archive };
}

/** Single use: approved → used, once, after the archive exists (file) or right before the add-in exports and loads (reload). */
export function claimFamilyOverwrite(id: string, d: FamilyLoadDeps = {}): FamilyOverwriteRecord {
  const { now } = d0(d);
  const records = readFamilyOverwrites(d);
  const rec = records.find((r) => r.id === id);
  if (!rec || rec.status !== "approved") throw new Error(`approval ${id} is not approved any more`);
  rec.status = "used"; rec.used_at = now().toISOString();
  writeFamilyOverwrites(records, d);
  return rec;
}

/** The pane's (a person's) decision. Not an MCP tool: cli.ts family_load_approve / family_load_reject call it. */
export function setFamilyOverwriteStatus(id: string, status: "approved" | "rejected", by: string, d: FamilyLoadDeps = {}): FamilyOverwriteRecord {
  const { now } = d0(d);
  if (!by.trim()) throw new Error("a person's name is needed");
  const records = readFamilyOverwrites(d);
  const rec = records.find((r) => r.id === id);
  if (!rec) throw new Error(`no family overwrite approval ${id}`);
  if (rec.status !== "pending") throw new Error(`approval ${id} is ${rec.status}`);
  rec.status = status; rec.approved_by = by.trim(); rec.approved_at = now().toISOString();
  writeFamilyOverwrites(records, d);
  return rec;
}

/**
 * Archive-before-overwrite for a file: copy to <archive>.partial, check size and sha256, rename to the archive name.
 * The original is not touched (the overwrite replaces it afterwards). A failure removes the partial copy.
 */
export function archiveFile(target: string, archive: string, expectSha: string, f: FsLike = realFs): { ok: true; sha256: string } | { ok: false; reason: string } {
  const partial = archive + ".partial";
  try {
    if (f.existsSync(archive)) return { ok: false, reason: `${archive} already exists` };
    f.mkdirSync(win.dirname(archive), { recursive: true });
    const bytes = f.readFileSync(target);
    const want = sha256(bytes);
    if (expectSha && want !== expectSha) return { ok: false, reason: `${target} changed since the approval (sha256 ${want.slice(0, 12)}…)` };
    f.copyFileSync(target, partial);
    if (f.statSync(partial).size !== bytes.length || sha256(f.readFileSync(partial)) !== want) throw new Error(`the archive copy of ${target} doesn't match it`);
    f.renameSync(partial, archive);
    return { ok: true, sha256: want };
  } catch (e) {
    try { if (f.existsSync(partial)) f.unlinkSync(partial); } catch { /* best effort */ }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The fingerprint of a project family about to be reloaded: what is there now (types, counts) and what comes in. */
export function reloadFingerprint(preview: { types?: Array<{ name: string; instances?: number }>; instances_total?: number } | null | undefined, source: string): string {
  const types = (preview?.types ?? []).map((t) => `${t.name}:${t.instances ?? 0}`).sort();
  return "rl-" + sha256(JSON.stringify({ types, total: preview?.instances_total ?? 0, source: source.toLowerCase() })).slice(0, 24);
}

/** A file overwrite's fingerprint: the existing file's sha256 ("" when it's gone). */
export function fileFingerprint(target: string, f: FsLike = realFs): string {
  try { return f.existsSync(target) ? sha256(f.readFileSync(target)) : ""; } catch { return ""; }
}

/**
 * (e) Every family op's path through the jail: write = inside the open project's folder (never the kit, standards,
 * shared state, protected_roots, a forbidden project, or kit staging while kit_staging_writes is off); read/open = also
 * the kit and standards (read_only_roots). Family files only: .rfa (and .rft for a template read).
 */
export function familyPathGate(op: string, kind: JailKind, raw: unknown, roots: JailRoots, cfg: GuardConfig | Record<string, unknown>):
  { ok: true; resolved: string } | { ok: false; code: string; message: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: false, code: FAMILY_LOAD.PATH, message: `[${FAMILY_LOAD.PATH}] ${op}: a path is needed` };
  if (!/\.(rfa|rft)$/i.test(s) && kind !== "list")
    return { ok: false, code: FAMILY_LOAD.PATH, message: `[${FAMILY_LOAD.PATH}] ${op}: ${s} is not a family file (.rfa, or .rft for a template)` };
  const v = jailCheck(kind, s, roots, cfg as GuardConfig, { param: op });
  return v.ok ? { ok: true, resolved: v.resolved ?? s } : { ok: false, code: v.code ?? FAMILY_LOAD.PATH, message: v.message };
}
