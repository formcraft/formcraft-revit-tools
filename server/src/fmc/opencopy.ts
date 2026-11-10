/**
 * Open a closed model as a detached verification copy. The original file is only read. Transmission data (link unload,
 * keep or repath) is applied to the copy, and only by Revit, after this plan has accepted the copy path.
 * Nothing here saves, syncs, publishes or relinquishes.
 */
import path from "node:path";
import { DocInfo, GuardConfig, isInside } from "./policy.js";

const win = path.win32;

export type LinkMode = "keep" | "unload" | "repath";

export interface LinkRepath {
  from: string;
  to: string;
  /** Load the repathed link. Default true. The link file itself is never saved. */
  load?: boolean;
}

export interface OpenCopyLinks {
  mode: LinkMode;
  repath?: LinkRepath[];
}

export interface OpenCopyInput {
  source: string;
  copyTo: string;
  links?: OpenCopyLinks;
  detach?: "preserve" | "discard";
  audit?: boolean;
  /** "all" (default), "last", "none", or the user-workset names to open. */
  worksets?: "all" | "last" | "none" | string[];
  protectedRoots?: string[];
  copyRoots?: string[];
  /** Full paths that must never be the copy (the live originals). */
  livePaths?: string[];
  overwrite?: boolean;
}

export interface OpenCopyPlan {
  ok: boolean;
  reasons: string[];
  source: string;
  copy_to: string;
  links: OpenCopyLinks;
  detach: "preserve" | "discard";
  audit: boolean;
  worksets: "all" | "last" | "none" | string[];
  /** Always false: this plan never writes the source file. */
  writes_source: false;
  saves: false;
  syncs: false;
  relinquishes: false;
  reload_modifies: false;
}

const remembered = new Set<string>();

/** Extra protected roots named on a call, kept for later write checks in this server process. */
export function rememberProtected(roots: string[] | undefined): void {
  for (const r of roots ?? []) if (r && r.trim()) remembered.add(win.normalize(r));
}

export function rememberedProtected(): string[] {
  return [...remembered];
}

/** Test hook. */
export function clearRememberedProtected(): void {
  remembered.clear();
}

export function protectedRoots(cfg: GuardConfig, extra?: string[]): string[] {
  const fromCfg = Array.isArray(cfg.protected_roots) ? cfg.protected_roots : [];
  return [...fromCfg, ...(extra ?? []), ...remembered];
}

export function copyRoots(cfg: GuardConfig, extra?: string[]): string[] {
  const fromCfg = Array.isArray(cfg.copy_roots) ? cfg.copy_roots : [];
  return [...fromCfg, ...(extra ?? [])];
}

export function samePath(a: string, b: string): boolean {
  return win.normalize(a).toLowerCase() === win.normalize(b).toLowerCase();
}

export function underAny(target: string, roots: string[]): boolean {
  return roots.some((r) => r && isInside(target, r));
}

/** BIM 360, Autodesk Docs and Revit Server paths are not local files this tool can copy. */
export function cloudModelReason(file: string): string | null {
  const s = file.trim();
  if (/^(bim\s*360:|autodesk\s*docs:|revit\s*server:|rsn:)/i.test(s))
    return "Cloud and Revit Server models are not opened by open_copy. Copy a local .rvt first.";
  if (!/^[a-zA-Z]:[\\/]/.test(s) && !s.startsWith("\\\\"))
    return "open_copy needs a local drive path or a UNC path, not a cloud model.";
  return null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

export function planOpenCopy(input: OpenCopyInput, cfg: GuardConfig, exists: (p: string) => boolean): OpenCopyPlan {
  const source = (input.source ?? "").trim();
  const copyTo = (input.copyTo ?? "").trim();
  const links = input.links ?? { mode: "unload" as LinkMode };
  const detach = input.detach === "discard" ? "discard" : "preserve";
  const worksets = input.worksets ?? "all";
  const reasons: string[] = [];
  const blocked = cfg.blocked_segments ?? [];
  const prot = protectedRoots(cfg, input.protectedRoots);
  const copies = copyRoots(cfg, input.copyRoots);
  const live = input.livePaths ?? [];
  rememberProtected(input.protectedRoots);

  if (!source) reasons.push("source is required (the closed .rvt to read)");
  if (!copyTo) reasons.push("copy_to is required (a path outside the protected originals)");
  if (source && win.extname(source).toLowerCase() !== ".rvt") reasons.push("source must be a .rvt");
  if (copyTo && win.extname(copyTo).toLowerCase() !== ".rvt") reasons.push("copy_to must be a .rvt");
  if (source) {
    const cloud = cloudModelReason(source);
    if (cloud) reasons.push(cloud);
    else if (!exists(source)) reasons.push(`Source not found: ${source}`);
  }
  if (copyTo) {
    const cloud = cloudModelReason(copyTo);
    if (cloud) reasons.push(`copy_to: ${cloud}`);
  }
  if (source && copyTo && samePath(source, copyTo))
    reasons.push("copy_to is the source file. open_copy never modifies the original; choose a different copy path.");
  if (copyTo && underAny(copyTo, prot))
    reasons.push(`copy_to is under a protected original (${prot.filter((r) => isInside(copyTo, r)).join("; ")}). Refusing to write it.`);
  if (copyTo && live.some((p) => samePath(p, copyTo) || isInside(copyTo, p)))
    reasons.push("copy_to is a live path. Refusing to write it.");
  if (copyTo && blocked.some((s) => win.normalize(copyTo).toLowerCase().split("\\").includes(s.toLowerCase())))
    reasons.push(`copy_to is in a CDE gate folder (${blocked.join(", ")}).`);
  if (copyTo && copies.length && !underAny(copyTo, copies))
    reasons.push(`copy_to is outside copy_roots (${copies.join("; ")}).`);
  if (copyTo && exists(copyTo) && !input.overwrite)
    reasons.push(`${copyTo} already exists. Set overwrite true to replace that copy (the source is still not modified).`);
  if (links.mode !== "keep" && links.mode !== "unload" && links.mode !== "repath")
    reasons.push('links.mode must be "keep" (load read-only), "unload", or "repath".');
  if (links.mode === "repath") {
    const rows = links.repath ?? [];
    if (!rows.length) reasons.push("links.mode repath needs links.repath: [{from, to}].");
    for (const row of rows) {
      if (!row.from || !row.to) reasons.push("each repath row needs from and to");
      else if (underAny(row.to, prot) && samePath(row.from, row.to)) reasons.push(`repath to ${row.to} does not change the link`);
    }
  }
  if (Array.isArray(worksets) && worksets.some((n) => !n.trim())) reasons.push("workset names must not be empty");

  return {
    ok: reasons.length === 0,
    reasons,
    source,
    copy_to: copyTo,
    links: { mode: links.mode, repath: links.repath },
    detach,
    audit: input.audit === true,
    worksets,
    writes_source: false,
    saves: false,
    syncs: false,
    relinquishes: false,
    reload_modifies: false,
  };
}

/**
 * Whether a model-changing command may run on this document. A named protected original is always refused.
 * A detached or read-only verification copy accepts only modify_model with dry_run true (a real rollback).
 * A missing document is not treated as success: the caller still has to have a document.
 */
export function writeGuard(doc: (DocInfo & { isLocal?: boolean | null }) | null | undefined, command: string, params: Record<string, unknown> | null | undefined, cfg: GuardConfig): { ok: boolean; reasons: string[] } {
  if (!doc) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  const prot = protectedRoots(cfg, strings(params?.protected_roots));
  const live = strings(params?.live_paths);
  const path = doc.path ?? "";
  const protectedDoc = !!path && underAny(path, prot);
  const liveDoc = !!path && live.some((p) => samePath(p, path) || isInside(path, p));
  const readOnly = doc.readOnly === true || doc.isDetached === true || doc.isLinked === true;
  const dryEdit = command === "fmc_model_edit" && params?.dry_run === true;
  if (doc.isLinked) reasons.push("A linked document is never written, saved, synced, reloaded or relinquished.");
  if (protectedDoc) reasons.push(`Protected original: ${path}. Write, save, sync, reload and relinquish are refused.`);
  if (liveDoc) reasons.push(`Live path: ${path}. Write, save, sync, reload and relinquish are refused.`);
  if (readOnly && !dryEdit && !doc.isLinked && !protectedDoc && !liveDoc)
    reasons.push("This document is a read-only verification copy. modify_model with dry_run true rolls back; every other write is refused. Nothing is saved.");
  if (command === "fmc_revit_file") {
    const action = String(params?.action ?? "");
    const file = String(params?.path ?? path);
    if (["save", "sync", "relinquish", "reload_latest"].includes(action) && (readOnly || protectedDoc || liveDoc || doc.isLinked))
      reasons.push(`revit_file ${action} is refused on this document. A verification copy is never saved, synced, reloaded or relinquished.`);
    if (action === "save_as" && (readOnly || protectedDoc || liveDoc))
      reasons.push("revit_file save_as is refused on a verification copy and on a protected original. It is not the persisted-preview path.");
    if (action === "open" && file && (underAny(file, prot) || live.some((p) => samePath(p, file))))
      reasons.push(`revit_file open will not activate ${file}: it is a protected or live path. Use fmc_file open_copy.`);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** The General AI switch for one copy path. Refuses a protected or live path, and never sets the project-wide switch. */
export function planEnableCopy(file: string, cfg: GuardConfig, extraProtected: string[] = [], livePaths: string[] = []): { ok: boolean; reasons: string[]; path: string } {
  const p = (file ?? "").trim();
  const prot = protectedRoots(cfg, extraProtected);
  const copies = copyRoots(cfg);
  const reasons: string[] = [];
  if (!p) reasons.push("document is required: the copy's full path");
  else {
    if (win.extname(p).toLowerCase() !== ".rvt") reasons.push("document must be the copy's full .rvt path");
    const cloud = cloudModelReason(p);
    if (cloud) reasons.push(cloud);
    if (!prot.length) reasons.push("name protected_roots (the live originals, for example D:\\Fomcraft) so this switch cannot be turned on for them");
    if (underAny(p, prot)) reasons.push(`Refusing to enable AI on a protected original: ${p}`);
    if (livePaths.some((x) => samePath(x, p) || isInside(p, x))) reasons.push(`Refusing to enable AI on a live path: ${p}`);
    if (copies.length && !underAny(p, copies)) reasons.push(`The copy is outside copy_roots (${copies.join("; ")}).`);
  }
  if (reasons.length === 0) rememberProtected(extraProtected);
  return { ok: reasons.length === 0, reasons, path: p ? win.normalize(p) : "" };
}
