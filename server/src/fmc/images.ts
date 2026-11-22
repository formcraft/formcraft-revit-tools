/**
 * Screenshots and exported images. Never beside a model and never on D:.
 * fmc_guard.json image_dir overrides the default. The default is %LOCALAPPDATA%\Formcraft\images,
 * or %USERPROFILE%\agent-tools\images when that default would land on D:.
 */
import os from "node:os";
import path from "node:path";
import type { GuardConfig } from "./policy.js";

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
