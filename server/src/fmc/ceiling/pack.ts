/**
 * Where the ceiling pack goes: <project>\01_WIP\_Ceilings\<date>_<room>_<design>, only when the guard's write roots
 * allow it (rule 2), never over an earlier pack. Pure: the caller passes the config and an exists() check.
 */
import path from "node:path";
import { GuardConfig, checkWritePath, isInside } from "../policy.js";
import { Kind, slug } from "./engine.js";

const win = path.win32;

export interface PackPlan { ok: boolean; reasons: string[]; folder: string; files: { setout: string; boq: string; checks: string } }

export function packPlan(projectFolder: string, room: string, kind: Kind, cfg: GuardConfig, today: string, exists: (p: string) => boolean): PackPlan {
  const reasons: string[] = [];
  const project = projectFolder.trim();
  const name = slug(room);
  const empty = { setout: "", boq: "", checks: "" };
  if (!project) return { ok: false, reasons: ["Set project_folder: the pack is saved in the project's 01_WIP"], folder: "", files: empty };
  if (!win.isAbsolute(project)) return { ok: false, reasons: [`project_folder must be an absolute path: ${project}`], folder: "", files: empty };
  const wip = win.join(project, "01_WIP");
  const root = win.join(wip, "_Ceilings");
  let folder = win.join(root, `${today}_${name}_${kind}`);
  for (let n = 2; exists(folder); n++) folder = win.join(root, `${today}_${name}_${kind}_${n}`);
  if (!isInside(folder, wip)) reasons.push("The pack goes only into the project's 01_WIP");
  reasons.push(...checkWritePath(win.join(folder, "x.csv"), cfg, { checkName: false }).reasons);
  const base = `FMC_Ceiling_${name}_${kind}`;
  return { ok: reasons.length === 0, reasons, folder,
    files: { setout: win.join(folder, `${base}_SetOut.csv`), boq: win.join(folder, `${base}_BoQ.csv`), checks: win.join(folder, `${base}_Checks.csv`) } };
}
