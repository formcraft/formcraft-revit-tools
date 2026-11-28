/**
 * TODO-builder6: stand-ins for Builder 6's graph modules, so fmc_graph_form.spec (Builder 7) builds and tests on its own.
 *
 * Contract: INTERFACES-builder6.md v1 (branch builder6/dynamo-graph-tools, 28 Nov 2026). Every export below has the
 * name and shape of the Builder 6 export it stands in for. When Builder 6's branch lands, replace this file's body with
 * re-exports and delete the stand-ins:
 *
 *   export { PYTHON_ALWAYS_NEEDS_PERSON, graphDecisions } from "./decisions.js";
 *   export { sha256File, sha256Text, stableJson } from "./hash.js";
 *   export { projectRootOf, graphsDir, jailCheck } from "./jail.js";
 *   export { checkPackages, packageFolders, installedPackages } from "./packages.js";
 *   export { readLock, lockCheck } from "./lib.js";
 *
 * Until then: no package check (status "pending_builder6"), no lock check ("unknown"), no approvals, no plan_hash.
 * Nothing here writes a file, starts Revit or Dynamo, or reads anything outside the path it is given.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathOf } from "../dynamo.js";

/** TODO-builder6: fmc/graph/decisions.ts. Hard rule, not config: Python always needs a person, in every run mode. */
export const PYTHON_ALWAYS_NEEDS_PERSON = true as const;

/** TODO-builder6: the D4 default of fmc/graph/decisions.ts GRAPH_DECISIONS_DEFAULT.drafts_folder. */
export const DRAFTS_FOLDER = ["00_Formcraft", "Graphs"] as const;

/** TODO-builder6: fmc/graph/hash.ts. Keys sorted recursively, no whitespace. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    const body = value as Record<string, unknown>;
    return `{${Object.keys(body).sort().filter((key) => body[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(body[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** TODO-builder6: fmc/graph/hash.ts. */
export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** TODO-builder6: fmc/graph/hash.ts. SHA-256 of the file bytes, lower-case hex. */
export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** TODO-builder6: fmc/graph/jail.ts. The project root is the folder above 01_WIP of the target document; "" when none. */
export function projectRootOf(docPath: string): string {
  const raw = (docPath ?? "").trim();
  if (!raw) return "";
  const p = pathOf(raw);
  const segs = p.normalize(raw).split(p.sep);
  const i = segs.findIndex((seg) => seg.toUpperCase() === "01_WIP");
  if (i <= 0) return "";
  const root = segs.slice(0, i).join(p.sep);
  return root || p.sep;
}

/** TODO-builder6: fmc/graph/jail.ts. <project>\00_Formcraft\Graphs (D4). */
export function graphsDir(projectRoot: string): string {
  const p = pathOf(projectRoot);
  return p.join(projectRoot, ...DRAFTS_FOLDER);
}

export type JailResult = { ok: true; real: string } | { ok: false; code: "FMC-GRAPH-JAIL"; message: string };

function looksUnc(raw: string): boolean {
  return /^[\\/]{2}/.test(raw);
}

function inside(child: string, root: string, p: path.PlatformPath): boolean {
  const a = p === path.win32 ? child.toLowerCase() : child;
  const b = p === path.win32 ? root.toLowerCase() : root;
  const rel = p.relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
}

function realOrNull(target: string): string | null {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

/**
 * TODO-builder6: fmc/graph/jail.ts jailCheck(file, root). Refuses UNC and device paths, any ".." segment, relative
 * paths, a file that does not exist, and a file whose real path (junctions and links followed) leaves the real root.
 */
export function jailCheck(file: string, root: string): JailResult {
  const raw = (file ?? "").trim();
  const refuse = (why: string): JailResult => ({ ok: false, code: "FMC-GRAPH-JAIL", message: `[FMC-GRAPH-JAIL] ${raw || "(no path)"}: ${why}` });
  if (!raw) return refuse("no path given.");
  if (looksUnc(raw)) return refuse("network (UNC) and device paths are refused; use a local path inside the project or the kit.");
  if (raw.split(/[\\/]+/).some((seg) => seg === "..")) return refuse("a \"..\" segment is refused.");
  const p = pathOf(raw);
  if (!p.isAbsolute(raw) || (p === path.win32 && !/^[A-Za-z]:[\\/]/.test(raw))) return refuse("give an absolute local path.");
  if (!(root ?? "").trim()) return refuse("there is no jail root for this call.");
  if (!inside(p.normalize(raw), p.normalize(root), p)) return refuse(`it is outside ${root}.`);
  const realRoot = realOrNull(root);
  if (!realRoot) return refuse(`the folder ${root} does not exist.`);
  const real = realOrNull(raw);
  if (!real) return refuse("the file does not exist.");
  const rp = pathOf(realRoot);
  if (looksUnc(real) || !inside(real, realRoot, rp)) return refuse(`it resolves to ${real}, outside ${root} (junction or link).`);
  return { ok: true, real };
}

/** TODO-builder6: shape of fmc/graph/packages.ts PackageCheck (section 4). Builder 7 reports what the graph asks for only. */
export interface PackageCheck {
  ok: boolean;
  folders: string[];
  packages: Array<{ name: string; wanted: string; installed: string | null; folder: string | null;
    status: "ok" | "missing" | "older" | "newer"; folder_sha256: string | null; has_dll: boolean; allowed: boolean }>;
  missing: string[];
  older: string[];
}

/** TODO-builder6: replace with checkPackages(inspect, installedPackages(packageFolders(env))). */
export function packageCheckPending(): { status: "pending_builder6"; check: PackageCheck | null; note: string } {
  return { status: "pending_builder6", check: null, note: "Installed-package check (DT-26, fmc_graph_guard.packages) is Builder 6's; not run here." };
}

/** TODO-builder6: replace with lockCheck(kit, file, sha) from fmc/graph/lib.ts. */
export function lockStatusPending(): "unknown" {
  return "unknown";
}
