/**
 * fmc_graph_guard.packages (DT-26): compare the packages a graph needs with the installed pkg.json files in the
 * user, ProgramData and built-in Dynamo package folders. Read-only (D14: paths, names and versions only).
 */
import fs from "node:fs";
import path from "node:path";
import type { DynInspect } from "../dynamo.js";
import { sha256Folder } from "./hash.js";
import type { Finding } from "./scan.js";
import type { GraphDecisions } from "./decisions.js";

export interface InstalledPackage { name: string; version: string; folder: string; has_dll: boolean }

export interface PackageCheckRow {
  name: string; wanted: string; installed: string | null; folder: string | null;
  status: "ok" | "missing" | "older" | "newer"; folder_sha256: string | null; has_dll: boolean; allowed: boolean;
}

export interface PackageCheck {
  ok: boolean;
  folders: string[];
  packages: PackageCheckRow[];
  missing: string[];
  older: string[];
  not_allowed: string[];
  dll_findings: Finding[];
}

function subdirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch { return []; }
}

/** Dynamo package folders on this PC. FMC_DYNAMO_PACKAGE_DIRS (separated by ';') replaces the search for tests. */
export function packageFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (env.FMC_DYNAMO_PACKAGE_DIRS ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (named.length) return named;
  const found: string[] = [];
  const pj = path.win32;
  if (env.APPDATA) for (const v of subdirs(pj.join(env.APPDATA, "Dynamo", "Dynamo Revit"))) found.push(pj.join(v, "packages"));
  const pd = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
  for (const rvt of subdirs(pj.join(pd, "Autodesk"))) {
    if (!/RVT \d{4}$/i.test(rvt)) continue;
    for (const v of subdirs(pj.join(rvt, "Dynamo"))) found.push(pj.join(v, "packages"));
  }
  const pf = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  for (const yr of ["2025", "2026"]) found.push(pj.join(pf, "Autodesk", `Revit ${yr}`, "AddIns", "DynamoForRevit", "Built-In Packages", "packages"));
  return found.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
}

function hasDll(folder: string): boolean {
  const bin = path.join(folder, "bin");
  try { return fs.readdirSync(bin).some((f) => /\.dll$/i.test(f)); } catch { return false; }
}

export function installedPackages(folders: string[]): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  for (const root of folders) {
    for (const folder of subdirs(root)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(folder, "pkg.json"), "utf8").replace(/^\uFEFF/, "")) as { name?: unknown; version?: unknown };
        const name = typeof pkg.name === "string" ? pkg.name : path.basename(folder);
        out.push({ name, version: typeof pkg.version === "string" ? pkg.version : "", folder, has_dll: hasDll(folder) });
      } catch { /* not a package folder */ }
    }
  }
  return out;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function isAllowed(name: string, version: string, decisions?: Pick<GraphDecisions, "allowed_packages" | "third_party_packages">, extra: Array<{ name: string; version?: string }> = []): boolean {
  const list = [...(decisions?.allowed_packages ?? []), ...(decisions?.third_party_packages ?? []), ...extra];
  return list.some((p) => p.name.toLowerCase() === name.toLowerCase() && (!p.version || !version || p.version === version));
}

/** Only real packages: a dependency whose reference type is a package, or not stated. */
export function graphPackages(inspect: Pick<DynInspect, "packages">): Array<{ name: string; version: string }> {
  return inspect.packages.filter((p) => !p.reference || /package/i.test(p.reference)).map((p) => ({ name: p.name, version: p.version }));
}

export function checkPackages(inspect: Pick<DynInspect, "packages">, installed: InstalledPackage[], folders: string[] = [],
  decisions?: Pick<GraphDecisions, "allowed_packages" | "third_party_packages">, allowlisted: Array<{ name: string; version?: string }> = [], withHashes = true): PackageCheck {
  const rows: PackageCheckRow[] = [];
  const findings: Finding[] = [];
  for (const want of graphPackages(inspect)) {
    const hits = installed.filter((p) => p.name.toLowerCase() === want.name.toLowerCase());
    const best = hits.sort((a, b) => compareVersions(b.version, a.version))[0];
    let status: PackageCheckRow["status"] = "missing";
    if (best) {
      const c = want.version ? compareVersions(best.version, want.version) : 0;
      status = c === 0 ? "ok" : c < 0 ? "older" : "newer";
    }
    const row: PackageCheckRow = {
      name: want.name, wanted: want.version, installed: best?.version ?? null, folder: best?.folder ?? null, status,
      folder_sha256: best && withHashes ? sha256Folder(best.folder) : null, has_dll: best?.has_dll ?? false,
      allowed: isAllowed(want.name, best?.version ?? want.version, decisions, allowlisted),
    };
    rows.push(row);
    if (row.has_dll) findings.push({ node_id: "", node_name: want.name, kind: "package_dll", rule: `Package ${want.name} ships a DLL (code that is not read)`, severity: "high" });
  }
  const missing = rows.filter((r) => r.status === "missing").map((r) => r.name);
  const older = rows.filter((r) => r.status === "older").map((r) => r.name);
  const notAllowed = rows.filter((r) => !r.allowed).map((r) => r.name);
  return { ok: missing.length === 0 && older.length === 0, folders, packages: rows, missing, older, not_allowed: notAllowed, dll_findings: findings };
}
