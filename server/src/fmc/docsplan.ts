/**
 * Open and close plans for fmc_docs. Revit is not called here.
 * A workshared central opens as a new local in Documents unless detach is set.
 * A save is refused under protected_roots, on save_exclude, and for HEBERT HOSTELS_USER.
 */
import path from "node:path";
import { saveBlocked } from "./savepolicy.js";
import type { GuardConfig } from "./policy.js";

const win = path.win32;

export interface OpenDocRow {
  title: string;
  path: string;
  family?: boolean;
  workshared?: boolean;
  active?: boolean;
  modified?: boolean;
  central?: boolean;
}

export function documentsFolder(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FMC_DOCUMENTS && env.FMC_DOCUMENTS.trim()) return env.FMC_DOCUMENTS.trim();
  const home = env.USERPROFILE || env.HOME || "C:\\Users\\USER";
  return win.join(home, "Documents");
}

export function localPathFor(centralPath: string, documents = documentsFolder()): string {
  const base = win.basename(centralPath, win.extname(centralPath));
  const name = /_USER$/i.test(base) ? base : `${base}_USER`;
  return win.join(documents, `${name}.rvt`);
}

export function neverSaveTitle(title: string, file = ""): boolean {
  return /hebert hostels/i.test(`${title} ${file}`);
}

export interface OpenRequest {
  path: string;
  /** Default true when the file is a workshared central. */
  as_local?: boolean;
  detach?: boolean;
  worksets?: "all" | "last";
  workshared?: boolean;
  central?: boolean;
  documents?: string;
}

export interface OpenPlan {
  ok: boolean;
  reasons: string[];
  path: string;
  as_local: boolean;
  detach: boolean;
  worksets: "all" | "last";
  local_path: string;
  open_path: string;
  dry_run: true;
}

export function planOpen(req: OpenRequest): OpenPlan {
  const file = (req.path ?? "").trim();
  const reasons: string[] = [];
  if (!file) reasons.push("open needs path.");
  if (file && !/\.rvt$/i.test(file) && !/\.rfa$/i.test(file)) reasons.push("open takes a .rvt or a .rfa.");
  const workshared = req.workshared === true || req.central === true;
  const central = req.central !== false && workshared;
  const asLocal = req.as_local !== false && central && req.detach !== true && /\.rvt$/i.test(file);
  const detach = req.detach === true && workshared;
  const worksets = req.worksets === "last" ? "last" : "all";
  const local = asLocal ? localPathFor(file, req.documents ?? documentsFolder()) : "";
  return {
    ok: reasons.length === 0,
    reasons,
    path: file,
    as_local: asLocal,
    detach,
    worksets,
    local_path: local,
    open_path: asLocal ? local : file,
    dry_run: true,
  };
}

export interface CloseRequest {
  document: string;
  save?: boolean;
  open: OpenDocRow[];
  guard?: GuardConfig;
}

export interface ClosePlan {
  ok: boolean;
  reasons: string[];
  document: string;
  save: boolean;
  title: string;
  path: string;
  dry_run: true;
}

export function planClose(req: CloseRequest): ClosePlan {
  const name = (req.document ?? "").trim();
  const reasons: string[] = [];
  const open = req.open ?? [];
  if (open.length <= 1) reasons.push("The last open document is never closed.");
  const hit = open.filter((doc) => {
    const title = (doc.title ?? "").toLowerCase();
    const file = (doc.path ?? "").toLowerCase();
    const want = name.toLowerCase();
    return want && (title === want || file === want || win.basename(file) === want);
  });
  if (!name) reasons.push("close needs document (a title or a full path).");
  else if (hit.length === 0) reasons.push(`No open document matches ${name}.`);
  else if (hit.length > 1) reasons.push(`${name} matches ${hit.length} documents. Pass the full path.`);
  const doc = hit.length === 1 ? hit[0] : { title: name, path: "", modified: false };
  const save = req.save === true;
  if (doc.modified && !save) reasons.push("The document is modified. close refuses it unless save is true. Nothing was closed.");
  if (save) {
    if (neverSaveTitle(doc.title ?? "", doc.path ?? "")) reasons.push("HEBERT HOSTELS_USER is never saved.");
    const blocked = req.guard ? saveBlocked({ title: doc.title, path: doc.path }, req.guard) : null;
    if (blocked) reasons.push(blocked);
    if (doc.workshared) reasons.push("A workshared model is not saved by a tool. Sync stays with the person.");
  }
  return { ok: reasons.length === 0, reasons, document: name, save, title: doc.title ?? "", path: doc.path ?? "", dry_run: true };
}
