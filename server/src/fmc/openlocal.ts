/**
 * fmc_file open_local and close_local (F125): open a person's own workshared LOCAL as the active document, and close
 * one again. These plans only decide; the add-in (FmcOpenLocal.cs) checks again with Revit's own file info.
 *
 * open_local never detaches, never creates a new local, never synchronises, and refuses a central model.
 * close_local never synchronises or relinquishes. It saves only when save is true, and that save is a model write:
 * the server sends it as fmc_close_local_apply (WRITE_COMMANDS), so the live-model lock, the AI gate and the batch lease apply.
 */
import path from "node:path";
import { GuardConfig, isInside } from "./policy.js";
import { cloudModelReason, protectedRoots, samePath, underAny } from "./opencopy.js";
import { saveSkipReason } from "./savepolicy.js";

const win = path.win32;

export const FILE_CODES = {
  PATH_REQUIRED: "FMC-FILE-PATH-REQUIRED",
  NOT_FOUND: "FMC-FILE-NOT-FOUND",
  NOT_PROJECT: "FMC-FILE-NOT-PROJECT",
  CLOUD_REFUSED: "FMC-FILE-CLOUD-REFUSED",
  PROTECTED_REFUSED: "FMC-FILE-PROTECTED-REFUSED",
  CENTRAL_REFUSED: "FMC-FILE-CENTRAL-REFUSED",
  NOT_WORKSHARED: "FMC-FILE-NOT-WORKSHARED",
  WORKSETS_INVALID: "FMC-FILE-WORKSETS-INVALID",
  FAMILY_REFUSED: "FMC-FILE-FAMILY-REFUSED",
  LINKED_REFUSED: "FMC-FILE-LINKED-REFUSED",
  VERIFY_COPY: "FMC-FILE-VERIFY-COPY",
  ONLY_DOC: "FMC-FILE-ONLY-DOC",
  ACTIVE_CLOSE: "FMC-FILE-ACTIVE-CLOSE",
  SAVE_REFUSED: "FMC-FILE-SAVE-REFUSED",
  UNSAVED_CHANGES: "FMC-FILE-UNSAVED-CHANGES",
  DOC_REQUIRED: "FMC-DOC-REQUIRED",
  DOC_NOT_FOUND: "FMC-DOC-NOT-FOUND",
  DOC_AMBIGUOUS: "FMC-DOC-AMBIGUOUS",
} as const;

export type WorksetSpec = "all" | "last" | "last_viewed" | "none" | string[];
export type OpenWorksets = "all" | "last_viewed" | "none" | string[];

/** What Revit says about the file on disk (fmc_docs probe: BasicFileInfo). */
export interface FileProbe {
  exists?: boolean;
  workshared?: boolean;
  central?: boolean;
}

export interface OpenLocalInput {
  path: string;
  activate?: boolean;
  /** Left out: a workshared file opens all worksets. Naming it for a file that is not workshared is refused. */
  worksets?: WorksetSpec;
  protectedRoots?: string[];
  livePaths?: string[];
}

export interface OpenLocalPlan {
  ok: boolean;
  reasons: string[];
  codes: string[];
  action: "open_local";
  path: string;
  activate: boolean;
  worksets: OpenWorksets | null;
  workshared: boolean | null;
  detach: false;
  creates_local: false;
  syncs: false;
  saves: false;
}

function refuse(reasons: string[], codes: string[], code: string, text: string) {
  codes.push(code);
  reasons.push(`[${code}] ${text}`);
}

/** The add-in reads worksets as all, last_viewed, none or a list of names. "last" is the open_copy spelling. */
export function normaliseWorksets(spec: WorksetSpec | undefined): OpenWorksets | null {
  if (spec === undefined) return null;
  if (Array.isArray(spec)) return spec.map((n) => n.trim());
  if (spec === "last" || spec === "last_viewed") return "last_viewed";
  return spec;
}

export function planOpenLocal(input: OpenLocalInput, cfg: GuardConfig, exists: (p: string) => boolean, probe?: FileProbe | null): OpenLocalPlan {
  const target = (input.path ?? "").trim();
  const reasons: string[] = [];
  const codes: string[] = [];
  const worksets = normaliseWorksets(input.worksets);
  const prot = protectedRoots(cfg, input.protectedRoots);
  const live = input.livePaths ?? [];

  if (!target) refuse(reasons, codes, FILE_CODES.PATH_REQUIRED, "path is required: the full path of the workshared local (.rvt).");
  else {
    const cloud = cloudModelReason(target);
    if (cloud) refuse(reasons, codes, FILE_CODES.CLOUD_REFUSED, cloud.replace(/open_copy/g, "open_local").replace("Copy a local .rvt first.", "Use a local file on disk."));
    else if (win.extname(target).toLowerCase() !== ".rvt") refuse(reasons, codes, FILE_CODES.NOT_PROJECT, "path must be a project .rvt. A family, template or backup is not opened as a local.");
    else if (!exists(target)) refuse(reasons, codes, FILE_CODES.NOT_FOUND, `File not found: ${target}`);
    if (underAny(target, prot))
      refuse(reasons, codes, FILE_CODES.PROTECTED_REFUSED, `${target} is under a protected original (${prot.filter((r) => isInside(target, r)).join("; ")}). Open your local, not the original.`);
    if (live.some((p) => samePath(p, target) || isInside(target, p)))
      refuse(reasons, codes, FILE_CODES.PROTECTED_REFUSED, `${target} is a live path. Open your local, not the original.`);
  }
  if (Array.isArray(worksets) && (worksets.length === 0 || worksets.some((n) => !n))) refuse(reasons, codes, FILE_CODES.WORKSETS_INVALID, "worksets: a list needs at least one workset name, and none may be empty.");
  if (probe && probe.exists !== false) {
    if (probe.central === true)
      refuse(reasons, codes, FILE_CODES.CENTRAL_REFUSED, `${target} is a central model. open_local opens a local only; it never opens, detaches or creates a local from a central.`);
    if (probe.workshared === false && worksets !== null)
      refuse(reasons, codes, FILE_CODES.NOT_WORKSHARED, `${target} is not workshared, so worksets cannot be set. Leave worksets out.`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    codes,
    action: "open_local",
    path: target,
    activate: input.activate !== false,
    worksets,
    workshared: probe && probe.exists !== false && typeof probe.workshared === "boolean" ? probe.workshared : null,
    detach: false,
    creates_local: false,
    syncs: false,
    saves: false,
  };
}

/** One row of fmc_docs list / fmc_document_info. */
export interface OpenDocRow {
  title?: string;
  path?: string;
  family?: boolean;
  isFamily?: boolean;
  workshared?: boolean;
  isWorkshared?: boolean;
  active?: boolean;
  isActive?: boolean;
  central?: boolean;
  detached?: boolean;
  isDetached?: boolean;
  linked?: boolean;
  isLinked?: boolean;
  readOnly?: boolean;
  /** fmc_document_info: true for a person's local, false for a central or an unknown path, null when not workshared. */
  isLocal?: boolean | null;
  modified?: boolean;
  isModified?: boolean;
}

export interface CloseLocalInput {
  document: string;
  save?: boolean;
  /** Close a document that has unsaved changes without saving them (the changes are lost). */
  confirm?: boolean;
  protectedRoots?: string[];
}

export interface CloseLocalPlan {
  ok: boolean;
  reasons: string[];
  codes: string[];
  action: "close_local";
  document: string;
  title: string;
  path: string;
  save: boolean;
  is_active: boolean;
  /** The open document that is activated first when the target is the active one (Revit cannot close the active document). */
  activate_first: string;
  syncs: false;
  relinquishes: false;
}

const flag = (row: OpenDocRow, a: keyof OpenDocRow, b: keyof OpenDocRow) => row[a] === true || row[b] === true;
const isFamilyRow = (row: OpenDocRow) => flag(row, "family", "isFamily");
const isLinkedRow = (row: OpenDocRow) => flag(row, "linked", "isLinked");
const isActiveRow = (row: OpenDocRow) => flag(row, "active", "isActive");
const isDetachedRow = (row: OpenDocRow) => flag(row, "detached", "isDetached");

function matches(row: OpenDocRow, key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  if ((row.title ?? "").toLowerCase() === k) return true;
  return !!row.path && win.normalize(row.path).toLowerCase() === win.normalize(key).toLowerCase();
}

export function planCloseLocal(input: CloseLocalInput, open: OpenDocRow[], cfg: GuardConfig): CloseLocalPlan {
  const key = (input.document ?? "").trim();
  const save = input.save === true;
  const reasons: string[] = [];
  const codes: string[] = [];
  const base = { action: "close_local" as const, document: key, save, syncs: false as const, relinquishes: false as const };
  const projects = open.filter((row) => !isLinkedRow(row));
  if (!key) {
    refuse(reasons, codes, FILE_CODES.DOC_REQUIRED, "document is required: the title or full path of the local to close. Refusing to use the active document.");
    return { ...base, ok: false, reasons, codes, title: "", path: "", is_active: false, activate_first: "" };
  }
  const hits = projects.filter((row) => matches(row, key));
  if (hits.length === 0) {
    refuse(reasons, codes, FILE_CODES.DOC_NOT_FOUND, `No open document has title or path "${key}". Refusing to use the active document.`);
    return { ...base, ok: false, reasons, codes, title: "", path: "", is_active: false, activate_first: "" };
  }
  if (hits.length > 1) {
    refuse(reasons, codes, FILE_CODES.DOC_AMBIGUOUS, `"${key}" matches ${hits.length} open documents. Pass the full path.`);
    return { ...base, ok: false, reasons, codes, title: "", path: "", is_active: false, activate_first: "" };
  }
  const doc = hits[0];
  const title = doc.title ?? "";
  const file = doc.path ?? "";
  const active = isActiveRow(doc);
  let activateFirst = "";
  if (isFamilyRow(doc)) refuse(reasons, codes, FILE_CODES.FAMILY_REFUSED, `${title} is a family document. close_local closes project locals; use close for a family.`);
  if (doc.readOnly === true && !isLinkedRow(doc))
    refuse(reasons, codes, FILE_CODES.VERIFY_COPY, `${title} is a read-only verification copy. Close it with close_copy.`);
  if (doc.central === true || (flag(doc, "workshared", "isWorkshared") && doc.isLocal === false && !isDetachedRow(doc)))
    refuse(reasons, codes, FILE_CODES.CENTRAL_REFUSED, `${title} is the central model, not a local. close_local does not close it.`);
  if (projects.length <= 1)
    refuse(reasons, codes, FILE_CODES.ONLY_DOC, `${title} is the only open document. Revit cannot close the active document and there is nothing to switch to, so it was not closed.`);
  else if (active) {
    const others = projects.filter((row) => row !== doc && !isFamilyRow(row) && !!row.path);
    const ordered = [...others.filter((row) => row.readOnly !== true), ...others.filter((row) => row.readOnly === true)];
    const pick = ordered[0];
    if (!pick) refuse(reasons, codes, FILE_CODES.ACTIVE_CLOSE, `${title} is the active document and no other open project has a saved path to switch to. Revit cannot close the active document.`);
    else activateFirst = pick.path ?? "";
  }
  if (!save && flag(doc, "modified", "isModified") && input.confirm !== true)
    refuse(reasons, codes, FILE_CODES.UNSAVED_CHANGES, title + " has unsaved changes and save is false, so closing would discard them. Save it in Revit, or run again with confirm=true to discard them.");
  if (save) {
    const why: string[] = [];
    if (!file) why.push("it has never been saved (no path)");
    if (/hebert hostels/i.test(`${title} ${file}`)) why.push("HEBERT HOSTELS is never saved");
    if (isDetachedRow(doc) || doc.readOnly === true) why.push("it is detached or a verification copy");
    if (file && underAny(file, protectedRoots(cfg, input.protectedRoots))) why.push("it is under a protected original");
    if (saveSkipReason({ title, path: file }, cfg)) why.push("the guard excludes it from saving (save_exclude, sync_exclude or protected_paths)");
    if (why.length) refuse(reasons, codes, FILE_CODES.SAVE_REFUSED, `save=true refused: ${why.join("; ")}. close_local never syncs or relinquishes either way.`);
  }
  return { ...base, ok: reasons.length === 0, reasons, codes, title, path: file, is_active: active, activate_first: activateFirst };
}
