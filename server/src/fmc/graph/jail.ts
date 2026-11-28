/**
 * The project-folder jail for graph drafts and outputs. The root is derived from the target document (the folder above
 * 01_WIP); a caller never supplies it. jailCheck refuses device and UNC paths, "..", relative paths without a base,
 * missing files (unless mustExist:false) and junctions or links that leave it.
 */
import fs from "node:fs";
import { pathOf } from "../dynamo.js";
import { projectFolderOf } from "../aiuse.js";
import { isInside } from "../policy.js";
import { GRAPH_DECISIONS_DEFAULT } from "./decisions.js";

export type JailResult = { ok: true; real: string } | { ok: false; code: "FMC-GRAPH-JAIL"; reason: JailReason; message: string };

/** The project folder above 01_WIP of the target document, or "" when the model is not in a project's 01_WIP. */
export function projectRootOf(docPath: string): string {
  if (!docPath.trim()) return "";
  const p = pathOf(docPath);
  if (p === pathOf("C:\\")) return projectFolderOf(docPath);
  // POSIX (tests): the same rule on "/" separators.
  const segs = p.normalize(docPath).split("/");
  const i = segs.findIndex((s) => s.toUpperCase() === "01_WIP");
  return i > 0 ? segs.slice(0, i).join("/") : "";
}

export function graphsDir(projectRoot: string, draftsFolder = GRAPH_DECISIONS_DEFAULT.drafts_folder): string {
  const p = pathOf(projectRoot);
  return p.join(projectRoot, ...draftsFolder.split(/[\\/]+/).filter(Boolean));
}

function realOrNearest(target: string): string {
  const p = pathOf(target);
  let current = target;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? p.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return target;
      tail.push(p.basename(current));
      current = parent;
    }
  }
  return target;
}

export type JailReason = "no_root" | "empty" | "device" | "unc" | "dotdot" | "relative" | "missing" | "outside" | "link";
export interface JailOptions {
  /** Base folder for a relative `file`. Without it a relative path is refused. The result must still be inside `root`. */
  base?: string;
  /** Default true: the file (or folder) must already exist. Only the author op's draft writer passes false; then the
   *  nearest existing parent folder, links and junctions resolved, must still be inside the jail. */
  mustExist?: boolean;
}

const DEVICE = /^(\\\\|\/\/)[.?](\\|\/)/;     // \\.\  \\?\  //./  //?/
const UNC = /^(\\\\|\/\/)/;
const DOTDOT = /(^|[\\/])\.\.([\\/]|$)/;
const ABSOLUTE = /^[a-zA-Z]:[\\/]|^\//;

/**
 * The single jail check every caller relies on (v1.2). Refuses, in order: no project root, empty path, device paths
 * (\\.\ and \\?\), UNC paths, any '..' segment, a relative path without an explicit `base`, a missing file when
 * `mustExist` (default true), a path outside `root` (or equal to it), and links or junctions that leave `root`.
 */
export function jailCheck(file: string, root: string, opts: JailOptions = {}): JailResult {
  const mustExist = opts.mustExist !== false;
  const no = (reason: JailReason, why: string): JailResult => ({ ok: false, code: "FMC-GRAPH-JAIL", reason, message: `[FMC-GRAPH-JAIL] ${file || "(no path)"} ${why}` });
  if (!root.trim()) return no("no_root", "has no project folder to sit in: the target model is not in a project's 01_WIP.");
  if (!file.trim()) return no("empty", "is empty.");
  for (const candidate of [file, opts.base ?? ""]) {
    if (DEVICE.test(candidate)) return no("device", "is a device path (\\\\.\\ or \\\\?\\); use a normal path inside the project folder.");
    if (UNC.test(candidate)) return no("unc", "is a network (UNC) path; graph files must be on the project folder's local path.");
    if (DOTDOT.test(candidate)) return no("dotdot", "uses '..'.");
  }
  const p = pathOf(root);
  let abs: string;
  if (ABSOLUTE.test(file)) abs = p.normalize(file);
  else {
    const base = (opts.base ?? "").trim();
    if (!base || !ABSOLUTE.test(base)) return no("relative", "is a relative path and the caller gave no absolute base folder.");
    abs = p.join(base, file);
  }
  if (!isInside(abs, root) || abs.replace(/[\\/]+$/, "").length <= root.replace(/[\\/]+$/, "").length) return no("outside", `is outside the project folder ${root}.`);
  const realRoot = realOrNearest(root);
  let real: string;
  if (mustExist) {
    try { real = fs.realpathSync.native(abs); } catch { return no("missing", "does not exist."); }
  } else {
    real = p.join(realOrNearest(p.dirname(abs)), p.basename(abs));
  }
  if (!isInside(real, realRoot)) return no("link", `leaves the project folder through a link or junction (${real}).`);
  return { ok: true, real: abs };
}

/** Every absolute path among the inputs that is not inside the jail. */
export function pathInputsOutsideJail(inputs: unknown, root: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if ((ABSOLUTE.test(value) && value.length > 1) || UNC.test(value) || DOTDOT.test(value)) {
        const r = jailCheck(value, root);
        if (!r.ok) found.push(r.message);
      }
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(inputs);
  return found;
}
