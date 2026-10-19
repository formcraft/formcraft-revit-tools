/**
 * The hub's exchange layer (docs/PLAN_ENGINEERING_HUB.md, X0): how the apps talk to each other.
 *
 * - The identity map: one Formcraft id per element, mapped to its id in each app (Revit UniqueId or element id, a Robot
 *   run's bar, a Navisworks item, a Rhino object). A Navisworks clash finds its Revit element; Robot's forces find their
 *   column; a changed Rhino part finds every family that uses it.
 * - Exchange packages: every hand-over between apps is a folder with a manifest (what, from, to, when, checksums).
 *   Nothing is overwritten, so every exchange can be traced.
 *
 * Both live in the project's 01_WIP\_Exchange (or <reports>\Exchange when no project is named). Pure file work: no app.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppId } from "./apps.js";

const win = path.win32;

/** Where a project's exchange lives: <project>\01_WIP\_Exchange, or the reports folder's Exchange without a project. */
export function exchangeRoot(projectFolder: string | undefined, reportsDir: string): string {
  const p = (projectFolder ?? "").trim();
  return p ? win.join(p, "01_WIP", "_Exchange") : win.join(reportsDir, "Exchange");
}

// ---- identity map ------------------------------------------------------------------------------------------------------

export interface AppRef { id: string; file?: string; at: string }
export interface IdentityEntry { fmc: string; kind?: string; name?: string; apps: Partial<Record<AppId, AppRef>> }
export interface IdentityMap { version: 1; entries: Record<string, IdentityEntry> }

export function identityFile(root: string) { return win.join(root, "FMC_Identity.json"); }

export function loadIdentity(root: string): IdentityMap {
  try {
    const j = JSON.parse(fs.readFileSync(identityFile(root), "utf8").replace(/^﻿/, ""));
    if (j && j.version === 1 && j.entries && typeof j.entries === "object") return j;
  } catch { /* a new project */ }
  return { version: 1, entries: {} };
}

/** Written whole to a temporary file first, then moved over the old one, so a crash never leaves half a map. */
export function saveIdentity(root: string, map: IdentityMap) {
  fs.mkdirSync(root, { recursive: true });
  const file = identityFile(root), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, file);
}

export function newFmcId(): string { return `FMC-${crypto.randomBytes(5).toString("hex")}`; }

/** The Formcraft id an app's element is known by, or null. */
export function findFmc(map: IdentityMap, app: AppId, appId: string): string | null {
  for (const e of Object.values(map.entries)) if (e.apps[app]?.id === appId) return e.fmc;
  return null;
}

/**
 * Records that an app's element is a Formcraft element: the one it is already known as, the one given (fmc), or a new
 * one. Returns its Formcraft id. Linking twice changes nothing but the time.
 */
export function link(map: IdentityMap, app: AppId, appId: string, opts: { fmc?: string; kind?: string; name?: string; file?: string; at?: string } = {}): string {
  const at = opts.at ?? new Date().toISOString();
  const known = findFmc(map, app, appId);
  const fmc = opts.fmc ?? known ?? newFmcId();
  if (known && opts.fmc && known !== opts.fmc) delete map.entries[known].apps[app]; // it moved to another element
  const e = map.entries[fmc] ?? (map.entries[fmc] = { fmc, apps: {} });
  if (opts.kind) e.kind = opts.kind;
  if (opts.name) e.name = opts.name;
  e.apps[app] = { id: appId, ...(opts.file ? { file: opts.file } : {}), at };
  return fmc;
}

/** The same element in another app: Revit 412088 → Robot bar "FEA-…#17", or null when it has none there. */
export function counterpart(map: IdentityMap, from: AppId, fromId: string, to: AppId): AppRef | null {
  const fmc = findFmc(map, from, fromId);
  return fmc ? map.entries[fmc].apps[to] ?? null : null;
}

export function identityStats(map: IdentityMap) {
  const entries = Object.values(map.entries);
  const byApp: Record<string, number> = {};
  for (const e of entries) for (const a of Object.keys(e.apps)) byApp[a] = (byApp[a] ?? 0) + 1;
  return { elements: entries.length, in_two_or_more_apps: entries.filter((e) => Object.keys(e.apps).length > 1).length, by_app: byApp };
}

// ---- exchange packages -------------------------------------------------------------------------------------------------

export interface PackageFile { name: string; sha256: string; bytes: number }
export interface PackageManifest {
  id: string; from: AppId | "hub"; to: AppId | "hub"; what: string; created: string;
  files: PackageFile[]; source?: Record<string, unknown>; flow?: string; notes?: string[];
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "exchange";

/**
 * A file's name inside a package: a plain name, or a relative path in sub-folders ("data/FMC_Rooms.csv") written with
 * forward slashes. Anything that could leave the package (an absolute path, "..", a drive) keeps only its base name.
 */
export function packageName(name: string): string {
  const parts = name.split(/[\\/]+/).filter((s) => s.length > 0);
  const safe = !win.isAbsolute(name) && !/^[A-Za-z]:/.test(name) && parts.length > 0 && parts.every((s) => s !== "." && s !== "..");
  return safe ? parts.join("/") : win.basename(name);
}

/**
 * A new package folder; never an existing one (a second package in the same second gets a suffix). files may be a
 * function of the package's folder, for files that name where they live (a Power BI model pointing at its own data).
 */
export function writePackage(root: string, p: { from: PackageManifest["from"]; to: PackageManifest["to"]; what: string;
  files: Array<{ name: string; text: string }> | ((dir: string) => Array<{ name: string; text: string }>); source?: Record<string, unknown>; flow?: string; notes?: string[]; now?: Date }): { dir: string; manifest: PackageManifest } {
  const base = `${stamp(p.now ?? new Date())}_${p.from}-${p.to}_${slug(p.what)}`;
  let dir = win.join(root, "Packages", base);
  for (let k = 2; fs.existsSync(dir); k++) dir = win.join(root, "Packages", `${base}_${k}`);
  fs.mkdirSync(dir, { recursive: true });
  const list = typeof p.files === "function" ? p.files(dir) : p.files;
  const files: PackageFile[] = list.map((f) => {
    const name = packageName(f.name);
    fs.mkdirSync(win.dirname(win.join(dir, name)), { recursive: true });
    fs.writeFileSync(win.join(dir, name), f.text);
    const buf = Buffer.from(f.text, "utf8");
    return { name, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  });
  const manifest: PackageManifest = { id: win.basename(dir), from: p.from, to: p.to, what: p.what, created: new Date().toISOString(), files,
    ...(p.source ? { source: p.source } : {}), ...(p.flow ? { flow: p.flow } : {}), ...(p.notes?.length ? { notes: p.notes } : {}) };
  fs.writeFileSync(win.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

/** The packages in a project's exchange, newest first, optionally only from or to one app. */
export function listPackages(root: string, filter: { app?: string } = {}): PackageManifest[] {
  const dir = win.join(root, "Packages");
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: PackageManifest[] = [];
  for (const n of names) {
    try {
      const m = JSON.parse(fs.readFileSync(win.join(dir, n, "manifest.json"), "utf8")) as PackageManifest;
      if (!filter.app || m.from === filter.app || m.to === filter.app) out.push(m);
    } catch { /* not a package */ }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** A package's files still match their checksums (nothing changed them after the hand-over). */
export function verifyPackage(root: string, id: string): { ok: boolean; changed: string[] } {
  const dir = win.join(root, "Packages", id);
  const m = JSON.parse(fs.readFileSync(win.join(dir, "manifest.json"), "utf8")) as PackageManifest;
  const changed = m.files.filter((f) => {
    try { return crypto.createHash("sha256").update(fs.readFileSync(win.join(dir, f.name))).digest("hex") !== f.sha256; } catch { return true; }
  }).map((f) => f.name);
  return { ok: changed.length === 0, changed };
}
