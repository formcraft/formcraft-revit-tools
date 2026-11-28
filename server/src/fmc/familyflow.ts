/**
 * BSF-3: the tools' side of the safe family load / reload / overwrite (fmc/familyload.ts is the pure gate). These are the
 * entry points revit_file, modify_model, new_family, fmc_doc and fmc_legend call, and what a wrapper (fmc_fam_load) calls.
 *
 * Contract for a caller:
 *  1. familyJail(project?) — the open project's jail (family documents are not projects; name the project when several
 *     are open).
 *  2. A file write: fileWriteGate(op, path, { overwrite, approval_id, family }) → { ok, resolved, archive_path?, approval_id? }.
 *     A reload: reloadGate(op, { project, family, source?, incoming_types?, overwrite, approval_id }) → { ok, archive_path?, preview }.
 *  3. On ok, send the add-in command with path = resolved, overwrite = (archive_path ? true : false) and archive_path.
 *     The add-in refuses an overwrite without a valid archive_path (FmcFamilySafe), so the server gate can't be skipped.
 *  4. On !ok, return familyRefusal(...) as the tool's reply: FMC-FAM-EXISTS (with the preview), FMC-FAM-WAITING (approval id,
 *     archive path, preview: a person approves in the pane, or the blanket in fmc_guard.json does), FMC-FAM-APPROVAL,
 *     FMC-FAM-ARCHIVE, FMC-FAM-PATH, or a FMC-JAIL-* code.
 * The approval is claimed (single use) after the file archive is verified, or right before Revit runs a reload (which
 * exports the old family first): a timeout never leaves it open for a replay.
 */
import fs from "node:fs";
import path from "node:path";
import { readInstances } from "./connect.js";
import { documentTarget } from "./target.js";
import { liveLockVerdict, loadConfig, type GuardConfig } from "./policy.js";
import { callJail, revitCentral, type CallJail } from "./jailctx.js";
import {
  FAMILY_LOAD, archiveFile, archiveFolderFor, claimFamilyOverwrite, familyPathGate, fileFingerprint, reloadFingerprint,
  requireFamilyOverwrite, type FamilyLoadDeps,
} from "./familyload.js";

const win = path.win32;

/** The jail of the open project (title or path), else the only open project. Family documents never count as projects. */
export async function familyJail(project?: string, opts: { central?: (doc: string) => Promise<string | undefined> } = {}): Promise<CallJail> {
  let open: Array<{ title: string; path: string; workshared?: boolean; family?: boolean }> = [];
  try { open = readInstances().flatMap((i) => i.documents ?? []).filter((d) => !d.family); } catch { open = []; }
  return callJail({ open, named: project?.trim() || undefined, central: opts.central ?? revitCentral });
}

export type FamilyGateOk = { ok: true; resolved: string; archive_path?: string; approval_id?: string; preview?: unknown };
export type FamilyGateNo = { ok: false; code: string; message: string; approval_id?: string; archive?: string; expires_at?: string; preview?: unknown };

/** The tool reply for a refusal: one JSON shape for every family op. */
export function familyRefusal(tool: string, g: FamilyGateNo) {
  const next = g.code === FAMILY_LOAD.WAITING
    ? [`A person approves ${g.approval_id} in the pane (Families › Approvals); then call ${tool} again with approval_id ${g.approval_id}.`]
    : g.code === FAMILY_LOAD.EXISTS ? [`Look at the preview; to replace it call ${tool} again with overwrite: true (one approval per overwrite; the old family is archived first).`]
      : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ refused: true, tool, code: g.code, message: g.message,
      ...(g.approval_id ? { approval_id: g.approval_id } : {}), ...(g.archive ? { archive: g.archive } : {}),
      ...(g.expires_at ? { expires_at: g.expires_at } : {}), ...(g.preview !== undefined ? { preview: g.preview } : {}),
      ...(next ? { next } : {}) }, null, 2) }],
    isError: true,
  };
}

/** A family file read (load source, template): inside the project's folder or the kit/standards (read_only_roots). */
export function familyReadGate(op: string, raw: unknown, j: CallJail): FamilyGateOk | FamilyGateNo {
  if (j.problem && !j.roots.docRoots.length && !j.roots.readOnly.length) return { ok: false, code: FAMILY_LOAD.PATH, message: `[${FAMILY_LOAD.PATH}] ${op}: ${j.problem}` };
  const p = familyPathGate(op, "read", raw, j.roots, j.cfg);
  return p.ok ? { ok: true, resolved: p.resolved } : { ok: false, code: p.code, message: p.message };
}

/**
 * A family file write (save_family path, export_family, new_family, fmc_doc save): a jail write; an existing file is an
 * overwrite: refused without overwrite: true (FMC-FAM-EXISTS), else one approval, then the old file is archived
 * (verified) inside the project, then the approval is claimed. dry_run: the checks only, nothing archived or claimed.
 */
export function fileWriteGate(op: string, raw: unknown, a: { overwrite?: boolean; approval_id?: string; family?: string; dry_run?: boolean },
  j: CallJail, d: FamilyLoadDeps = {}): FamilyGateOk | FamilyGateNo {
  const p = familyPathGate(op, "write", raw, j.roots, j.cfg);
  if (!p.ok) return { ok: false, code: p.code, message: p.message };
  const target = p.resolved;
  const existing = (d.fs ?? fs).existsSync(target);
  const family = a.family || win.basename(target).replace(/\.rfa$/i, "");
  if (a.dry_run) return existing && !a.overwrite
    ? { ok: false, code: FAMILY_LOAD.EXISTS, message: `[${FAMILY_LOAD.EXISTS}] ${target} already exists: a real run needs overwrite: true and an approval (the old file is archived first).` }
    : { ok: true, resolved: target };
  const g = requireFamilyOverwrite({ op, overwrite: "file", family, project: j.roots.document, target, fingerprint: fileFingerprint(target, d.fs),
    archiveFolder: archiveFolderFor(j.roots.document, j.roots, j.cfg), wantOverwrite: a.overwrite === true, approvalId: a.approval_id, cfg: j.cfg, roots: j.roots }, existing, d);
  if (!g.ok) return { ok: false, code: g.code, message: g.message, approval_id: g.approval_id, archive: g.archive, expires_at: g.expires_at };
  if (!g.overwrite) return { ok: true, resolved: target };
  const copy = archiveFile(target, g.archive, g.record.fingerprint, d.fs);
  if (!copy.ok) return { ok: false, code: FAMILY_LOAD.ARCHIVE, approval_id: g.record.id,
    message: `[${FAMILY_LOAD.ARCHIVE}] The archive before the overwrite failed (${copy.reason}): nothing was replaced and approval ${g.record.id} is still unused.` };
  try { claimFamilyOverwrite(g.record.id, d); }
  catch (e) {
    return { ok: false, code: FAMILY_LOAD.APPROVAL, approval_id: g.record.id, message: `[${FAMILY_LOAD.APPROVAL}] ${e instanceof Error ? e.message : String(e)}: nothing was replaced.` };
  }
  return { ok: true, resolved: target, archive_path: g.archive, approval_id: g.record.id };
}

export interface ReloadAsk {
  /** The project the family goes into (its path or title; "" = the only open project). */
  project?: string;
  family: string;
  /** The incoming .rfa (load_family), or the family document's path/title (load_into_project). */
  source?: string;
  incoming_types?: string[];
  overwrite?: boolean;
  approval_id?: string;
  dry_run?: boolean;
}

/** The preview from Revit (read only): fmc_revit_file family_preview on the project. */
export type PreviewFn = (project: string, family: string, incomingTypes?: string[]) => Promise<{ exists?: boolean; types?: Array<{ name: string; instances?: number }>; instances_total?: number } | null>;

export async function revitFamilyPreview(project: string, family: string, incomingTypes?: string[]) {
  const { withRevitConnection } = await import("../utils/ConnectionManager.js");
  return withRevitConnection((c) => c.sendRaw("fmc_revit_file", { action: "family_preview", document: project, family, ...(incomingTypes ? { incoming_types: incomingTypes } : {}) }, 30000)) as Promise<never>;
}

/**
 * A reload (load_family, load_into_project, the wrapper's load): the preview first. Not in the project → load as new.
 * In the project without overwrite → FMC-FAM-EXISTS with the preview. With overwrite → one approval carrying the archive
 * path; claimed here, right before the caller sends the load (the add-in exports the old family to archive_path first).
 */
export async function reloadGate(op: string, a: ReloadAsk, j: CallJail, preview: PreviewFn = revitFamilyPreview, d: FamilyLoadDeps = {}): Promise<FamilyGateOk | FamilyGateNo> {
  const project = j.roots.document;
  if (!project) return { ok: false, code: FAMILY_LOAD.PATH, message: `[${FAMILY_LOAD.PATH}] ${op}: ${j.problem || "no saved project to load into"}` };
  let pv: Awaited<ReturnType<PreviewFn>>;
  try { pv = await preview(project, a.family, a.incoming_types); }
  catch (e) { return { ok: false, code: FAMILY_LOAD.PREVIEW, message: `[${FAMILY_LOAD.PREVIEW}] ${op}: the preview failed (${e instanceof Error ? e.message : String(e)}), so nothing was loaded.` }; }
  if (!pv?.exists) return { ok: true, resolved: project, preview: pv ?? undefined };
  if (a.dry_run) return a.overwrite ? { ok: true, resolved: project, preview: pv } : { ok: false, code: FAMILY_LOAD.EXISTS, preview: pv,
    message: `[${FAMILY_LOAD.EXISTS}] ${a.family} is already in ${project}: a real run needs overwrite: true and an approval (the old family is archived first).` };
  const source = a.source ?? "";
  const sourceId = /\.rfa$/i.test(source) ? `${source}|${fileFingerprint(source, d.fs)}` : source;
  const g = requireFamilyOverwrite({ op, overwrite: "reload", family: a.family, project, target: `${project}#${a.family}`, fingerprint: reloadFingerprint(pv, sourceId),
    archiveFolder: archiveFolderFor(project, j.roots, j.cfg), wantOverwrite: a.overwrite === true, approvalId: a.approval_id, preview: pv, source, cfg: j.cfg, roots: j.roots }, true, d);
  if (!g.ok) return { ok: false, code: g.code, message: g.message, approval_id: g.approval_id, archive: g.archive, expires_at: g.expires_at, preview: g.preview };
  if (!g.overwrite) return { ok: true, resolved: project, preview: pv };
  try { claimFamilyOverwrite(g.record.id, d); }
  catch (e) { return { ok: false, code: FAMILY_LOAD.APPROVAL, approval_id: g.record.id, message: `[${FAMILY_LOAD.APPROVAL}] ${e instanceof Error ? e.message : String(e)}: nothing was loaded.` }; }
  return { ok: true, resolved: project, archive_path: g.archive, approval_id: g.record.id, preview: pv };
}

export const FAMILY_LIVELOCK = "FMC-FAM-LIVELOCK";

/** The family document a modify_model batch runs in: the named one, else the active family, else the only open family. */
export function currentFamilyDocument(named = documentTarget.getStore()): { title: string; path: string } | null {
  let docs: Array<{ title: string; path: string; family?: boolean; active?: boolean }> = [];
  try { docs = readInstances().flatMap((i) => i.documents ?? []).filter((d) => d.family); } catch { docs = []; }
  const n = (named ?? "").trim().toLowerCase();
  return (n ? docs.find((d) => d.title.toLowerCase() === n || d.path.toLowerCase() === n || d.title.toLowerCase() === n + ".rfa") : undefined)
    ?? docs.find((d) => d.active) ?? (docs.length === 1 ? docs[0] : null);
}

/**
 * The live-model lock on the project a family is loaded into. modify_model's batch is locked on the family document it
 * runs in, so load_into_project reached a live project unchecked (BSF-3 finding). This checks the project itself;
 * a refusal points to revit_file load_family on the project, which goes through the project's own lock and AI gate.
 */
export async function liveLockForProject(project: string, docInfo: (doc: string) => Promise<any>, cfg: GuardConfig): Promise<FamilyGateOk | FamilyGateNo> {
  if (!cfg.live_model_lock) return { ok: true, resolved: project };
  let info: any;
  try { info = await docInfo(project); }
  catch (e) { return { ok: false, code: FAMILY_LIVELOCK, message: `[${FAMILY_LIVELOCK}] load_into_project: could not read ${project} for the live-model lock (${e instanceof Error ? e.message : String(e)}): nothing was loaded.` }; }
  const v = liveLockVerdict(info?.active, cfg);
  return v.ok ? { ok: true, resolved: project }
    : { ok: false, code: FAMILY_LIVELOCK, message: `[${FAMILY_LIVELOCK}] load_into_project into ${project}: the live-model lock refuses it (${v.reasons.join(" ")}). ` +
      "Save the family (save_family), then load it with revit_file load_family on that project: it goes through the project's lock and approvals." };
}

export interface ModelOpsDeps {
  jail?: (project?: string) => Promise<CallJail>;
  preview?: PreviewFn;
  docInfo?: (doc: string) => Promise<any>;
  familyDoc?: () => { title: string; path: string } | null;
  cfg?: GuardConfig;
  fl?: FamilyLoadDeps;
}

async function revitDocInfo(doc: string) {
  const { withRevitConnection } = await import("../utils/ConnectionManager.js");
  return withRevitConnection((c) => c.sendRaw("fmc_document_info", { document: doc }, 15000));
}

const stemOf = (t: string) => t.replace(/\.rfa$/i, "");

/**
 * modify_model: save_family (with a path) and load_into_project through the gates, in place. A caller's archive_path is
 * never trusted: it is removed, and set only from an approved, archived overwrite (overwrite is true only then).
 * Returns the first refusal, or null when the batch may go to Revit.
 */
export async function gateModelFamilyOps(ops: Array<Record<string, unknown>>, dryRun: boolean, deps: ModelOpsDeps = {}): Promise<FamilyGateNo | null> {
  const jailOf = deps.jail ?? ((p?: string) => familyJail(p));
  for (const op of ops) {
    if (op.op !== "save_family" && op.op !== "load_into_project") continue;
    delete op.archive_path;
    const wantOverwrite = op.overwrite === true;
    const approval = typeof op.approval_id === "string" ? op.approval_id : undefined;
    delete op.approval_id;
    op.overwrite = false;
    const project = typeof op.project === "string" ? op.project : undefined;
    if (op.op === "save_family") {
      if (typeof op.path !== "string" || !op.path.trim()) continue; // in place: the family's own file (Revit's .000N backups)
      const j = await jailOf(project);
      const g = fileWriteGate("save_family", op.path, { overwrite: wantOverwrite, approval_id: approval, dry_run: dryRun }, j, deps.fl);
      if (!g.ok) return g;
      op.path = g.resolved;
      if (g.archive_path) { op.overwrite = true; op.archive_path = g.archive_path; }
      continue;
    }
    const j = await jailOf(project);
    const lock = await liveLockForProject(j.roots.document, deps.docInfo ?? revitDocInfo, deps.cfg ?? loadConfig().config);
    if (!lock.ok) return lock;
    const fam = (deps.familyDoc ?? (() => currentFamilyDocument()))();
    if (!fam) return { ok: false, code: FAMILY_LOAD.PATH, message: `[${FAMILY_LOAD.PATH}] load_into_project: no family document open to load` };
    const g = await reloadGate("load_into_project", { family: stemOf(fam.title), source: fam.path || fam.title, overwrite: wantOverwrite, approval_id: approval, dry_run: dryRun },
      j, deps.preview, deps.fl);
    if (!g.ok) return g;
    if (g.archive_path) { op.overwrite = true; op.archive_path = g.archive_path; }
    if (!project && j.roots.document) op.project = j.roots.document;
  }
  return null;
}

/**
 * revit_file load_family / export_family through the gates. Returns the parameters to send (path resolved, overwrite
 * true only with an archive, archive_path from the approval), or the refusal.
 */
export async function revitFileFamilyGate(args: { action: string; path?: string; family?: string; overwrite?: boolean; approval_id?: string; dry_run?: boolean },
  deps: { jail?: (project?: string) => Promise<CallJail>; preview?: PreviewFn; fl?: FamilyLoadDeps } = {}):
  Promise<{ ok: true; params: Record<string, unknown> } | FamilyGateNo> {
  const j = await (deps.jail ?? ((p?: string) => familyJail(p)))(documentTarget.getStore());
  if (args.action === "load_family") {
    const r = familyReadGate("load_family", args.path, j);
    if (!r.ok) return r;
    const family = win.basename(r.resolved).replace(/\.rfa$/i, "");
    const g = await reloadGate("load_family", { family, source: r.resolved, overwrite: args.overwrite === true, approval_id: args.approval_id }, j, deps.preview, deps.fl);
    if (!g.ok) return g;
    return { ok: true, params: { path: r.resolved, overwrite: !!g.archive_path, ...(g.archive_path ? { archive_path: g.archive_path } : {}) } };
  }
  const g = fileWriteGate("export_family", args.path, { overwrite: args.overwrite === true, approval_id: args.approval_id, family: args.family }, j, deps.fl);
  if (!g.ok) return g;
  return { ok: true, params: { path: g.resolved, overwrite: !!g.archive_path, ...(g.archive_path ? { archive_path: g.archive_path } : {}) } };
}
