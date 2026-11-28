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
