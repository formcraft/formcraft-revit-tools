/**
 * Federation (hub step H3): the project's discipline models found by container name (Manual 4.1), planned into one
 * Navisworks file. Reading models from 02_Shared or 01_WIP is fine; the federated .nwf is written only into the project's
 * 01_WIP\_Navisworks, after a dry run, and an older .nwf there is archived first (rule 2: nothing is overwritten).
 */
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, ROLE_CODES, checkWritePath } from "./policy.js";

const win = path.win32;

/** A discipline model's container name with any extension Navisworks reads (the .rvt rule of Manual 4.1). */
const CONTAINER = /^([A-Z0-9]{2,6})-([A-Z0-9]{3,6})-([A-Z0-9]{2})-([A-Z0-9]{2})-([A-Z0-9]{2})-([A-Z]{1,2})-(\d{4})\.(rvt|nwc|nwd|nwf)$/i;
/** NWC first (Navisworks' own cache, fastest), then NWD, then the Revit file itself. */
const EXT_RANK: Record<string, number> = { ".nwc": 0, ".nwd": 1, ".rvt": 2 };
const SKIP_DIRS = /^(_archive|04_archive|05_incoming|backup|_backup|revit_temp|.*_backup)$/i;

export interface FoundModel { file: string; stem: string; role: string; project: string; originator: string; area: "shared" | "wip"; ext: string }

export function parseContainer(file: string) {
  const m = CONTAINER.exec(win.basename(file));
  return m ? { project: m[1].toUpperCase(), originator: m[2].toUpperCase(), volume: m[3], level: m[4], type: m[5], role: m[6].toUpperCase(), number: m[7] } : null;
}

function walk(dir: string, depth: number, out: string[]) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = win.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIRS.test(e.name)) walk(full, depth - 1, out); }
    else out.push(full);
  }
}

/**
 * The project's discipline models: container-named NWC, NWD or RVT files in 02_Shared and 01_WIP (source picks one or
 * both), one per container (02_Shared wins over 01_WIP, then NWC over NWD over RVT). Federated files (role Z) and
 * Revit backups are left out.
 */
export function findDisciplineModels(projectFolder: string, opts: { source?: "shared" | "wip" | "both"; roles?: string[] } = {}): FoundModel[] {
  const source = opts.source ?? "both";
  const roles = new Set((opts.roles ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean));
  const areas: Array<["shared" | "wip", string]> = [];
  if (source !== "wip") areas.push(["shared", win.join(projectFolder, "02_Shared")]);
  if (source !== "shared") areas.push(["wip", win.join(projectFolder, "01_WIP")]);
  const best = new Map<string, FoundModel>();
  for (const [area, dir] of areas) {
    const files: string[] = [];
    walk(dir, 4, files);
    for (const file of files) {
      const ext = win.extname(file).toLowerCase();
      if (!(ext in EXT_RANK)) continue;
      const c = parseContainer(file);
      if (!c || c.role === "Z" || !ROLE_CODES.includes(c.role)) continue;
      if (roles.size && !roles.has(c.role)) continue;
      const stem = win.basename(file, win.extname(file)).toUpperCase();
      const found: FoundModel = { file, stem, role: c.role, project: c.project, originator: c.originator, area, ext };
      const have = best.get(stem);
      const better = !have || (have.area !== area ? area === "shared" : EXT_RANK[ext] < EXT_RANK[have.ext]);
      if (better) best.set(stem, found);
    }
  }
  return [...best.values()].sort((a, b) => a.role.localeCompare(b.role) || a.stem.localeCompare(b.stem));
}

/** The default federated file: <project>\01_WIP\_Navisworks\<Project>-<Originator>-ZZ-ZZ-M3-Z-0001.nwf (role Z: federated). */
export function defaultFederatedFile(projectFolder: string, models: FoundModel[]): string {
  const first = models[0];
  const name = first ? `${first.project}-${first.originator}-ZZ-ZZ-M3-Z-0001.nwf` : "";
  return name ? win.join(projectFolder, "01_WIP", "_Navisworks", name) : "";
}

/** May the federated model be saved here? Only an .nwf with a container name, inside the guard's write roots and 01_WIP. */
export function federatedPathProblems(file: string, cfg: GuardConfig): string[] {
  if (!file) return ["No discipline models found, so there is no federated file name: name the .nwf (output)"];
  const p: string[] = [];
  if (win.extname(file).toLowerCase() !== ".nwf") p.push(`The federated model is saved as an .nwf (got ${win.extname(file) || "no extension"})`);
  else if (!parseContainer(file)) p.push(`${win.basename(file)} is not a container name [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].nwf (Manual 4.1)`);
  if (!file.toLowerCase().split(/[\\/]/).includes("01_wip")) p.push("The federated model is saved only in the project's 01_WIP (rule 2)");
  p.push(...checkWritePath(file, cfg, { checkName: false }).reasons);
  return p;
}

const sameStem = (a: string, b: string) => win.basename(a, win.extname(a)).toLowerCase() === win.basename(b, win.extname(b)).toLowerCase();

/** The plan: which models to append (not already in the open document) and which are there already. */
export function federationPlan(models: FoundModel[], inDocument: string[]) {
  const already = models.filter((m) => inDocument.some((d) => d && sameStem(d, m.file)));
  const append = models.filter((m) => !already.includes(m));
  const byRole: Record<string, number> = {};
  for (const m of models) byRole[m.role] = (byRole[m.role] ?? 0) + 1;
  return { append, already, by_role: byRole };
}
