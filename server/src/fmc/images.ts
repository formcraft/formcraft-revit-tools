/**
 * Screenshots and exported images. Never beside a model and never on D:.
 * fmc_guard.json image_dir overrides the default. The default is %LOCALAPPDATA%\Formcraft\images,
 * or %USERPROFILE%\agent-tools\images when that default would land on D:.
 */
import os from "node:os";
import path from "node:path";
import type { GuardConfig } from "./policy.js";
import { isInside, expandEnv } from "./policy.js";

const win = path.win32;

export function onDriveD(file: string): boolean {
  return /^d:/i.test(file.trim());
}

export function imageDir(cfg: Pick<GuardConfig, "image_dir"> | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERPROFILE || win.join(os.homedir());
  const local = env.LOCALAPPDATA || win.join(user, "AppData", "Local");
  const preferred = win.join(local, "Formcraft", "images");
  const agentTools = win.join(user, "agent-tools", "images");
  const safe = (dir: string) => (onDriveD(dir) ? "" : dir);
  const configured = typeof cfg?.image_dir === "string" ? cfg.image_dir.trim() : "";
  return safe(configured) || safe(preferred) || safe(agentTools) || "C:\\Users\\Public\\agent-tools\\images";
}

export interface SaveTarget {
  /** Where the picture is kept. */
  target: string;
  /** "name": save_to was a bare file name, kept in the image folder. "path": a full path that was honoured. */
  kept_as: "name" | "path";
  /** Says in words what happened to save_to (put in the reply). */
  note: string;
}

/**
 * SEE-1: where a see_view picture is kept. A bare file name is kept in the image folder (and the reply says so).
 * A full path is honoured only inside the image folder or an allowed write folder (write_roots, not on D:);
 * any other path is refused before Revit is asked for a picture. Never on D: and never beside a model.
 */
export function saveTarget(saveTo: string | undefined, dir: string, writeRoots: string[] = []): SaveTarget | null {
  if (!saveTo || !saveTo.trim()) return null;
  const raw = saveTo.trim();
  if (onDriveD(raw)) throw new Error(`[FMC-SAVE-TO] save_to is on D: (${raw}). Pictures are kept in ${dir} or an allowed write folder not on D:. Nothing was exported.`);
  if (/\.rvt([\\/]|$)/i.test(raw)) throw new Error(`[FMC-SAVE-TO] save_to is next to a model (${raw}). Pictures are kept in ${dir}. Nothing was exported.`);
  if (!/[\\/]/.test(raw) && !/^[a-z]:/i.test(raw)) {
    const target = keptImagePath(raw, dir) as string;
    return { target, kept_as: "name", note: `save_to is a file name: the picture is kept in the image folder as ${target}.` };
  }
  if (!win.isAbsolute(raw) || !/^([a-z]:|\\\\)/i.test(raw)) {
    throw new Error(`[FMC-SAVE-TO] save_to (${raw}) is a relative path. Give a file name (kept in ${dir}) or a full path inside ${dir} or an allowed write folder. Nothing was exported.`);
  }
  let full = win.normalize(expandEnv(raw));
  const base = win.basename(full).replace(/[<>:"|?*]/g, "_");
  full = win.join(win.dirname(full), /\.png$/i.test(base) ? base : `${base || "view"}.png`);
  const roots = [dir, ...writeRoots.filter((r) => typeof r === "string" && r.trim() && !onDriveD(expandEnv(r)))];
  if (!roots.some((r) => isInside(full, r))) {
    throw new Error(`[FMC-SAVE-TO] save_to (${raw}) is not inside the image folder (${dir}) or an allowed write folder (${writeRoots.length ? writeRoots.join("; ") : "none in fmc_guard.json write_roots"}). Nothing was exported. Give a file name, or a path inside one of those folders.`);
  }
  return { target: full, kept_as: "path", note: `save_to honoured: the picture is kept at ${full}.` };
}

/** A file name kept inside the image folder. A path on D: or beside a model is refused. */
export function keptImagePath(saveTo: string | undefined, dir: string): string | null {
  if (!saveTo || !saveTo.trim()) return null;
  const raw = saveTo.trim();
  if (onDriveD(raw)) throw new Error(`save_to is on D: (${raw}). Pictures are kept in ${dir}.`);
  if (/\.rvt([\\/]|$)/i.test(raw)) throw new Error(`save_to is next to a model (${raw}). Pictures are kept in ${dir}.`);
  const base = win.basename(raw).replace(/[<>:"|?*]/g, "_");
  const name = /\.png$/i.test(base) ? base : (base ? `${base}.png` : "view.png");
  return win.join(dir, name === ".png" ? "view.png" : name);
}
