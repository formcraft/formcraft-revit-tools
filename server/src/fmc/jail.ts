/**
 * Project-folder gate, core (Emlyn, 28 Nov 2026 13:12 EAT via Plugin Bot; plan:
 * agent-tools\plugin-bot\project_folder_gate_implementation_plan.md).
 *
 * Every path a tool argument names is resolved here, on the server, before any IO:
 *  - %VAR% expanded, `..` folded, forward slashes turned round;
 *  - the deepest part that exists is resolved with realpath (junctions, symlinks, subst drives and 8.3 short names);
 *  - admin shares of this PC (\\localhost\C$\...) become the drive path; other UNC paths stay UNC;
 *  - \\?\, \\.\, \??\, alternate data streams, NUL, device names, wildcards and segments ending in a dot or space
 *    are refused outright;
 * then compared by whole lower-case segments, so D:\Proj2 is not inside D:\Proj.
 *
 * Roots (never from the caller):
 *  - the call's document: workshared = the central's folder + that document's local file, its <name>_backup folder and
 *    its .NNNN backups; a saved non-workshared model = the project folder above 01_WIP, else only the file and its
 *    backups (the wider "model's folder" rule is a proposal only, plan §1); unsaved = no root (all file IO refused,
 *    Q2 recommendation);
 *  - read_only_roots (fmc_guard.json, kit and standards): read, list and open only; writes always refused;
 *  - shared state, %LOCALAPPDATA%\Formcraft and %APPDATA%\Formcraft (approval records, leases, settings, token, the
 *    cross-project call log): the AI may read it, never change it through a tool argument;
 *  - the server's own install folder (bundled data): read only.
 * Writes are also refused for the forbidden-project floor (A-0001, HEBERT HOSTELS, plus forbidden_projects, the same
 * normalisation as RV-6 on feat/safety-round) and under protected_roots named in the guard file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardConfig } from "./policy.js";

/** %NAME% expanded from env (same rule as policy.expandEnv; kept here so the jail has no import cycle). */
function expandEnv(p: string, env: NodeJS.ProcessEnv): string {
  return p.replace(/%([^%]+)%/g, (m, name: string) => env[name] ?? env[name.toUpperCase()] ?? m);
}

const win = path.win32;

export type JailKind = "read" | "list" | "open" | "write";

export const JAIL = {
  OUTSIDE: "FMC-JAIL-OUTSIDE",
  READONLY: "FMC-JAIL-READONLY",
  SHARED: "FMC-JAIL-SHARED",
  BADPATH: "FMC-JAIL-BADPATH",
  NOROOT: "FMC-JAIL-NOROOT",
  FORBIDDEN: "FMC-JAIL-FORBIDDEN",
  PROTECTED: "FMC-JAIL-PROTECTED",
  KITSTAGING: "FMC-JAIL-KITSTAGING",
} as const;
export type JailCode = typeof JAIL[keyof typeof JAIL];

/** The filesystem calls the jail itself needs. Tests pass a fake one. */
export interface JailFs {
  exists(p: string): boolean;
  /** The final path (junctions, symlinks, subst, 8.3 resolved). Throws when it can't. */
  realpath(p: string): string;
}

export const realJailFs: JailFs = {
  exists: (p) => { try { fs.lstatSync(p); return true; } catch { return false; } },
  realpath: (p) => fs.realpathSync.native(p),
};

export interface JailDoc {
  title?: string;
  path: string;
  isWorkshared?: boolean;
  /** The central's path (fmc_document_info centralPath). Without it a workshared local gets no central folder. */
  centralPath?: string;
  isFamily?: boolean;
}

/** One root: a folder (everything inside) or a single file (that file only). */
export interface JailRoot { path: string; kind: "folder" | "file" | "pattern"; why: string; pattern?: RegExp }

export interface JailRoots {
  document: string;
  docRoots: JailRoot[];
  readOnly: JailRoot[];
  shared: JailRoot[];
  bundled: JailRoot[];
  protectedRoots: JailRoot[];
  notes: string[];
}

export interface JailVerdict {
  ok: boolean;
  code?: JailCode;
  message: string;
  /** The canonical path compared (only when it could be resolved). */
  resolved?: string;
  /** The root that let it in. */
  root?: string;
}

// ---------- canonical paths ----------

const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const WILDCARD = /[*?<>"|]/;

export interface Canonical { ok: boolean; path: string; key: string; problem?: string }

function bad(problem: string): Canonical { return { ok: false, path: "", key: "", problem }; }

/** Strip \\?\ and \\?\UNC\ that realpath.native can hand back. */
function stripLong(p: string): string {
  if (/^\\\\\?\\UNC\\/i.test(p)) return "\\\\" + p.slice(8);
  if (/^\\\\\?\\[a-zA-Z]:/.test(p)) return p.slice(4);
  return p;
}

/** \\localhost\c$\x, \\127.0.0.1\c$\x, \\<this pc>\c$\x and \\.\c$ forms are the local drive. */
function adminShareToDrive(p: string, hostNames: string[]): string {
  const m = /^\\\\([^\\]+)\\([a-zA-Z])\$(\\.*)?$/.exec(p);
  if (!m) return p;
  if (!hostNames.includes(m[1].toLowerCase())) return p;
  return `${m[2].toUpperCase()}:${m[3] ?? "\\"}`;
}

function localHostNames(env: NodeJS.ProcessEnv): string[] {
  const names = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"];
  try { names.push(os.hostname().toLowerCase()); } catch { /* no host name */ }
  if (env.COMPUTERNAME) names.push(env.COMPUTERNAME.toLowerCase());
  return [...new Set(names)];
}

/** Lower-case segments, drive or UNC host+share first. */
export function segmentsOf(p: string): string[] {
  return p.toLowerCase().split("\\").filter(Boolean);
}

/**
 * The one canonical form of a path, or a problem. Pure apart from `jfs`. Never trusts a relative path: there is no
 * working folder a tool argument may count from.
 */
export function canonical(raw: unknown, jfs: JailFs = realJailFs, env: NodeJS.ProcessEnv = process.env): Canonical {
  if (typeof raw !== "string") return bad("the path is not text");
  if (!raw.trim()) return bad("the path is empty");
  if (raw.includes("\0")) return bad("the path holds a NUL character");
  if (raw.length > 32000) return bad("the path is too long");
  // Leading blanks only: Windows drops trailing dots and spaces itself, so a trailing one is refused below, not trimmed.
  let p = raw.replace(/^\s+/, "").replace(/\//g, "\\");
  if (/^\\\\[?.]\\/.test(p) || /^\\\?\?\\/.test(p)) return bad("device and \\\\?\\ paths are refused");
  if (/%[^%\\]+%/.test(p)) {
    p = expandEnv(p, env);
    if (/%[^%\\]+%/.test(p)) return bad("the path names an environment variable that is not set");
    p = p.replace(/\//g, "\\");
    if (/^\\\\[?.]\\/.test(p) || /^\\\?\?\\/.test(p)) return bad("device and \\\\?\\ paths are refused");
  }
  const drive = /^[a-zA-Z]:\\/.test(p);
  const unc = /^\\\\[^\\]+\\[^\\]+/.test(p);
  if (!drive && !unc) return bad("the path must be a full path (a drive letter or \\\\server\\share)");
  // Alternate data stream or a stray drive colon: any ':' after the drive's own.
  if (p.slice(drive ? 2 : 0).includes(":")) return bad("alternate data streams (':' in the path) are refused");
  const parts = p.split("\\");
  for (const seg of parts.slice(drive ? 1 : 2)) {
    if (!seg || seg === "." || seg === "..") continue;
    if (WILDCARD.test(seg)) return bad(`wildcards are refused (${seg})`);
    if (DEVICE.test(seg)) return bad(`device names are refused (${seg})`);
    if (/[. ]$/.test(seg)) return bad(`a folder or file name ending in a dot or space is refused (${seg})`);
  }
  p = win.resolve(p);
  p = adminShareToDrive(p, localHostNames(env));
  // Follow the deepest part that exists through realpath; the rest is appended as written.
  const segs = p.split("\\");
  const head = /^[a-zA-Z]:$/.test(segs[0]) ? 1 : 4; // "C:" | "", "", host, share
  let cut = segs.length;
  let real = "";
  while (cut >= head) {
    const probe = segs.slice(0, cut).join("\\") + (cut === head && head === 1 ? "\\" : "");
    if (jfs.exists(probe)) {
      try { real = stripLong(jfs.realpath(probe)); }
      catch { return bad(`the path could not be resolved (${probe})`); }
      break;
    }
    cut--;
  }
  const tail = segs.slice(cut);
  // A short name (8.3) can only be resolved when it exists. Refuse one in the part that doesn't exist yet.
  if (tail.some((seg) => /~\d/.test(seg))) return bad("an 8.3 short name in a part of the path that does not exist is refused");
  let full = real ? win.join(real, ...tail) : p;
  full = adminShareToDrive(stripLong(full), localHostNames(env)).replace(/\\+$/, "");
  if (/^[a-zA-Z]:$/.test(full)) full += "\\";
  return { ok: true, path: full, key: segmentsOf(full).join("\\") };
}

/** True when `child` is `root` or inside it, by whole segments (case-insensitive). */
export function insideKey(childKey: string, rootKey: string): boolean {
  if (!rootKey) return false;
  return childKey === rootKey || childKey.startsWith(rootKey + "\\");
}

// ---------- the forbidden-project floor (RV-6, feat/safety-round bfa3ee3 / da5ff63) ----------

/** Same floor as RV-6. On merge with feat/safety-round this should call policy.forbiddenProject. */
export const JAIL_FORBIDDEN_FLOOR: readonly string[] = ["A-0001", "HEBERT HOSTELS"];

function normaliseProjectText(text: string): string {
  return text.toUpperCase().replace(/[\s_\-.~]+/g, " ").trim();
}

/** The forbidden project a path names, or null (RV-6 rules: segment start; a name without digits at any word start). */
export function jailForbiddenProject(text: string, cfg?: (Partial<GuardConfig> & { forbidden_projects?: unknown }) | null): string | null {
  const extra = Array.isArray((cfg as { forbidden_projects?: unknown })?.forbidden_projects)
    ? ((cfg as { forbidden_projects: unknown[] }).forbidden_projects).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const names = [...new Set([...JAIL_FORBIDDEN_FLOOR, ...extra.map((x) => x.trim())])]
    .map((n) => ({ name: n, norm: normaliseProjectText(n), code: /\d/.test(n) }));
  for (const seg of (text ?? "").split(/[\\/]+/)) {
    const s = normaliseProjectText(seg.replace(/\.(rvt|rfa|rte|rft)$/i, ""));
    if (!s) continue;
    for (const n of names) {
      if (!n.norm) continue;
      if (s.startsWith(n.norm)) return n.name;
      if (!n.code && (" " + s).includes(" " + n.norm)) return n.name;
    }
  }
  return null;
}

// ---------- roots ----------

function folderRoot(p: string, why: string, jfs: JailFs, env: NodeJS.ProcessEnv): JailRoot | null {
  const c = canonical(p, jfs, env);
  return c.ok ? { path: c.path, kind: "folder", why } : null;
}

function fileRoot(p: string, why: string, jfs: JailFs, env: NodeJS.ProcessEnv): JailRoot | null {
  const c = canonical(p, jfs, env);
  return c.ok ? { path: c.path, kind: "file", why } : null;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** A file's Revit backups beside it (<stem>.0001.rvt) and its <stem>_backup folder. */
function backupRoots(file: string, jfs: JailFs, env: NodeJS.ProcessEnv): JailRoot[] {
  const c = canonical(file, jfs, env);
  if (!c.ok) return [];
  const dir = win.dirname(c.path);
  const ext = win.extname(c.path);
  const stem = win.basename(c.path, ext);
  const out: JailRoot[] = [];
  const folder = folderRoot(win.join(dir, `${stem}_backup`), "the document's backup folder", jfs, env);
  if (folder) out.push(folder);
  out.push({ path: win.join(dir, `${stem}.NNNN${ext}`), kind: "pattern", why: "the document's .NNNN backups",
    pattern: new RegExp(`^${escapeRe(segmentsOf(dir).join("\\"))}\\\\${escapeRe(stem.toLowerCase())}\\.\\d{4}${escapeRe(ext.toLowerCase())}$`) });
  return out;
}

/** The folder above 01_WIP, or "". */
export function projectRootOf(file: string): string {
  const segs = win.normalize(file).split("\\");
  const i = segs.findIndex((s) => s.toUpperCase() === "01_WIP");
  return i > 0 ? segs.slice(0, i).join("\\") : "";
}

/** The shared-state folders: %LOCALAPPDATA%\Formcraft and %APPDATA%\Formcraft. */
export function sharedStateFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA || win.join(os.homedir(), "AppData", "Local");
  const roaming = env.APPDATA || win.join(os.homedir(), "AppData", "Roaming");
  return [win.join(local, "Formcraft"), win.join(roaming, "Formcraft")];
}

/** The server's install folder (build\..), where bundled data and scenarios live. */
export function serverInstallFolder(): string {
  try { return win.resolve(win.dirname(fileURLToPath(import.meta.url)), "..", ".."); } catch { return ""; }
}

/** The jail of one document. The caller never supplies any of it. */
export function jailRoots(doc: JailDoc | null | undefined, cfg: Partial<GuardConfig>, opts: { jfs?: JailFs; env?: NodeJS.ProcessEnv; bundled?: string[] } = {}): JailRoots {
  const jfs = opts.jfs ?? realJailFs;
  const env = opts.env ?? process.env;
  const notes: string[] = [];
  const docRoots: JailRoot[] = [];
  const file = doc?.path?.trim() ?? "";
  if (!doc) notes.push("no document: only read_only_roots, shared state (read) and bundled data are open");
  else if (!file) notes.push(`${doc.title || "the document"} is not saved: it has no project folder, so no file IO is allowed for it (Q2)`);
  else if (doc.isWorkshared) {
    const central = doc.centralPath?.trim() ?? "";
    const c = canonical(file, jfs, env);
    const cc = central ? canonical(central, jfs, env) : null;
    const isCentral = !!(c.ok && cc?.ok && c.key === cc.key);
    if (cc?.ok) {
      const r = folderRoot(win.dirname(cc.path), "the central's folder", jfs, env);
      if (r) docRoots.push(r);
    } else notes.push("the central's path is not known: only the local and its backups are open");
    if (!isCentral) {
      const r = fileRoot(file, "the document's local file", jfs, env);
      if (r) docRoots.push(r);
      docRoots.push(...backupRoots(file, jfs, env));
    }
  } else {
    const project = projectRootOf(file);
    if (project) {
      const r = folderRoot(project, "the project folder above 01_WIP", jfs, env);
      if (r) docRoots.push(r);
    } else {
      notes.push("no 01_WIP above this model: only the file and its backups are open (the 'model's folder' rule is not approved)");
      const r = fileRoot(file, "the document's file", jfs, env);
      if (r) docRoots.push(r);
      docRoots.push(...backupRoots(file, jfs, env));
    }
  }
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const readOnly = list((cfg as { read_only_roots?: unknown }).read_only_roots)
    .map((p) => folderRoot(p, "read_only_roots", jfs, env)).filter((r): r is JailRoot => !!r);
  if (!readOnly.length) notes.push("read_only_roots is not set in fmc_guard.json: kit and standards files outside the project are refused");
  const shared = sharedStateFolders(env).map((p) => folderRoot(p, "shared state (read only for the AI)", jfs, env)).filter((r): r is JailRoot => !!r);
  const bundled = (opts.bundled ?? [serverInstallFolder()]).filter(Boolean)
    .map((p) => folderRoot(p, "the server's bundled data (read only)", jfs, env)).filter((r): r is JailRoot => !!r);
  const protectedRoots = list(cfg.protected_roots).map((p) => folderRoot(p, "protected_roots", jfs, env)).filter((r): r is JailRoot => !!r);
  return { document: doc ? (doc.path || doc.title || "") : "", docRoots, readOnly, shared, bundled, protectedRoots, notes };
}

function hit(key: string, roots: JailRoot[]): JailRoot | undefined {
  return roots.find((r) => {
    if (r.kind === "pattern") return !!r.pattern && r.pattern.test(key);
    const rk = segmentsOf(r.path).join("\\");
    return r.kind === "file" ? key === rk : insideKey(key, rk);
  });
}

function shown(roots: JailRoot[]): string {
  return roots.length ? roots.map((r) => r.path).join("; ") : "(none)";
}

/**
 * May a tool `kind` this path for the call's document? Fail closed: an unreadable path, no root, or anything outside
 * is refused with a code that names the path and the roots.
 */
export function jailCheck(kind: JailKind, raw: unknown, roots: JailRoots, cfg: Partial<GuardConfig> = {}, opts: { jfs?: JailFs; env?: NodeJS.ProcessEnv; param?: string } = {}): JailVerdict {
  const label = opts.param ? `${opts.param}: ` : "";
  const c = canonical(raw, opts.jfs ?? realJailFs, opts.env ?? process.env);
  if (!c.ok) return { ok: false, code: JAIL.BADPATH, message: `[${JAIL.BADPATH}] ${label}${c.problem}: ${String(raw ?? "")}` };
  const key = c.key;
  if (kind === "write") {
    const forbidden = jailForbiddenProject(c.path, cfg) ?? jailForbiddenProject(String(raw), cfg);
    if (forbidden) return { ok: false, code: JAIL.FORBIDDEN, resolved: c.path, message: `[${JAIL.FORBIDDEN}] ${label}${c.path} is in a forbidden project (${forbidden}): never written.` };
    const sh = hit(key, roots.shared);
    if (sh) return { ok: false, code: JAIL.SHARED, resolved: c.path, root: sh.path, message: `[${JAIL.SHARED}] ${label}${c.path} is Formcraft shared state (${sh.path}): the AI may read it, never change it.` };
    const ro = hit(key, roots.readOnly) ?? hit(key, roots.bundled);
    // Kit staging (<read-only root>\_Staging\...): refused while kit_staging_writes is off (the default; Q4 is open).
    // A person turns it on in fmc_guard.json; then only that subfolder of a read_only_roots entry is writable.
    if (ro && roots.readOnly.includes(ro)) {
      const below = segmentsOf(c.path).slice(segmentsOf(ro.path).length);
      if (below.length > 1 && below[0].toLowerCase() === "_staging") {
        if ((cfg as { kit_staging_writes?: unknown }).kit_staging_writes === true) return { ok: true, resolved: c.path, root: ro.path, message: "" };
        return { ok: false, code: JAIL.KITSTAGING, resolved: c.path, root: ro.path,
          message: `[${JAIL.KITSTAGING}] ${label}${c.path} is kit staging: kit staging writes are off (kit_staging_writes in fmc_guard.json is false by default; Q4 is open). Nothing was written.` };
      }
    }
    if (ro) return { ok: false, code: JAIL.READONLY, resolved: c.path, root: ro.path, message: `[${JAIL.READONLY}] ${label}${c.path} is under a read-only root (${ro.path}): writes there are always refused.` };
    const pr = hit(key, roots.protectedRoots);
    if (pr) return { ok: false, code: JAIL.PROTECTED, resolved: c.path, root: pr.path, message: `[${JAIL.PROTECTED}] ${label}${c.path} is under protected_roots (${pr.path}): writes are refused.` };
    if (!roots.docRoots.length) return { ok: false, code: JAIL.NOROOT, resolved: c.path, message: `[${JAIL.NOROOT}] ${label}no project folder for ${roots.document || "this call"}${roots.notes.length ? ` (${roots.notes[0]})` : ""}: ${c.path} is refused.` };
    const dr = hit(key, roots.docRoots);
    if (dr) return { ok: true, resolved: c.path, root: dr.path, message: "" };
    return { ok: false, code: JAIL.OUTSIDE, resolved: c.path, message: `[${JAIL.OUTSIDE}] ${label}${c.path} is outside the project folder of ${roots.document || "this call"} (${shown(roots.docRoots)}).` };
  }
  const inside = hit(key, roots.docRoots) ?? hit(key, roots.readOnly) ?? hit(key, roots.shared) ?? hit(key, roots.bundled);
  if (inside) return { ok: true, resolved: c.path, root: inside.path, message: "" };
  return { ok: false, code: roots.docRoots.length ? JAIL.OUTSIDE : JAIL.NOROOT, resolved: c.path,
    message: `[${roots.docRoots.length ? JAIL.OUTSIDE : JAIL.NOROOT}] ${label}${c.path} is outside the project folder of ${roots.document || "this call"} ` +
      `(${shown(roots.docRoots)}) and outside read_only_roots (${shown(roots.readOnly)}).` };
}

// ---------- IO through the jail (checked again right before the call, so a swap after the first check is caught) ----------

export class JailError extends Error {
  code: JailCode;
  constructor(v: JailVerdict) { super(v.message); this.code = v.code ?? JAIL.OUTSIDE; this.name = "JailError"; }
}

function must(kind: JailKind, p: string, roots: JailRoots, cfg: Partial<GuardConfig>, param?: string): string {
  const v = jailCheck(kind, p, roots, cfg, { param });
  if (!v.ok) throw new JailError(v);
  return v.resolved!;
}

export const jail = {
  check: jailCheck,
  readText(p: string, roots: JailRoots, cfg: Partial<GuardConfig>, param?: string): string {
    return fs.readFileSync(must("read", p, roots, cfg, param), "utf8");
  },
  list(p: string, roots: JailRoots, cfg: Partial<GuardConfig>, param?: string): string[] {
    return fs.readdirSync(must("list", p, roots, cfg, param));
  },
  writeText(p: string, text: string, roots: JailRoots, cfg: Partial<GuardConfig>, param?: string): string {
    const full = must("write", p, roots, cfg, param);
    fs.mkdirSync(win.dirname(full), { recursive: true });
    must("write", full, roots, cfg, param);
    fs.writeFileSync(full, text);
    return full;
  },
  copy(from: string, toDir: string, roots: JailRoots, cfg: Partial<GuardConfig>, param?: string): string {
    const src = must("read", from, roots, cfg);
    const dir = must("write", toDir, roots, cfg, param);
    fs.mkdirSync(dir, { recursive: true });
    const dest = must("write", win.join(dir, win.basename(src)), roots, cfg, param);
    fs.copyFileSync(src, dest);
    return dest;
  },
};

// ---------- the call's document ----------

export interface OpenDoc { title: string; path: string; workshared?: boolean; family?: boolean; active?: boolean }

function sameDoc(d: OpenDoc, name: string): boolean {
  const n = name.trim().toLowerCase().replace(/\//g, "\\");
  if (!n) return false;
  const p = (d.path ?? "").toLowerCase();
  const t = (d.title ?? "").toLowerCase();
  return p === n || t === n || t.replace(/\.(rvt|rfa)$/, "") === n.replace(/\.(rvt|rfa)$/, "") ||
    (!!p && win.basename(p) === n) || (!!p && win.basename(p).replace(/\.(rvt|rfa)$/, "") === n.replace(/\.(rvt|rfa)$/, ""));
}

/**
 * The document a call's jail comes from: the named one (documentTarget), else the only open document, else the active
 * one when exactly one is active. Two or more and none named: null, so only the shared roots apply.
 */
export function jailDocumentOf(open: OpenDoc[], named: string | undefined): { doc: JailDoc | null; problem?: string } {
  if (named && named.trim()) {
    const hits = open.filter((d) => sameDoc(d, named));
    if (hits.length === 1) return { doc: { title: hits[0].title, path: hits[0].path, isWorkshared: hits[0].workshared === true, isFamily: hits[0].family === true } };
    if (!hits.length) return { doc: null, problem: `${named} is not open: no project folder for this call` };
    return { doc: null, problem: `${named} matches ${hits.length} open documents: name it by its full path` };
  }
  const docs = open.filter((d) => d && (d.title || d.path));
  if (docs.length === 1) return { doc: { title: docs[0].title, path: docs[0].path, isWorkshared: docs[0].workshared === true, isFamily: docs[0].family === true } };
  if (!docs.length) return { doc: null, problem: "no document is open: no project folder for this call" };
  return { doc: null, problem: `${docs.length} documents are open and the call names none: name the document so its project folder is the jail` };
}
