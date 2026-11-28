/**
 * The project-folder jail for graph drafts and outputs. The root is derived from the target document (the folder above
 * 01_WIP); a caller never supplies it. Refuses "..", UNC paths outside a UNC root, and junctions or links that leave it.
 */
import fs from "node:fs";
import { pathOf } from "../dynamo.js";
import { projectFolderOf } from "../aiuse.js";
import { isInside } from "../policy.js";
import { GRAPH_DECISIONS_DEFAULT } from "./decisions.js";

export type JailResult = { ok: true; real: string } | { ok: false; code: "FMC-GRAPH-JAIL"; message: string };

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

/** True when `file` is inside `root`, after links and junctions are resolved. */
export function jailCheck(file: string, root: string): JailResult {
  const no = (why: string): JailResult => ({ ok: false, code: "FMC-GRAPH-JAIL", message: `[FMC-GRAPH-JAIL] ${file || "(no path)"} ${why}` });
  if (!root.trim()) return no("has no project folder to sit in: the target model is not in a project's 01_WIP.");
  if (!file.trim()) return no("is empty.");
  if (/(^|[\\/])\.\.([\\/]|$)/.test(file)) return no("uses '..'.");
  const uncFile = /^\\\\|^\/\//.test(file);
  const uncRoot = /^\\\\|^\/\//.test(root);
  if (uncFile && !uncRoot) return no("is a network (UNC) path; the project folder is local.");
  const p = pathOf(root);
  const abs = p.isAbsolute(file) ? p.normalize(file) : p.join(root, file);
  if (!isInside(abs, root) || abs.replace(/[\\/]+$/, "").length <= root.replace(/[\\/]+$/, "").length) return no(`is outside the project folder ${root}.`);
  const realRoot = realOrNearest(root);
  const real = realOrNearest(abs);
  if (!isInside(real, realRoot)) return no(`leaves the project folder through a link or junction (${real}).`);
  return { ok: true, real: abs };
}

/** Every absolute path among the inputs that is not inside the jail. */
export function pathInputsOutsideJail(inputs: unknown, root: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || (value.startsWith("/") && value.length > 1) || /(^|[\\/])\.\.([\\/]|$)/.test(value)) {
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
