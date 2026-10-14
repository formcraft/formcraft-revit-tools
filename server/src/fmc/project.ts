import path from "node:path";
import { GuardConfig, ROLE_CODES, TYPE_CODES, checkTemplatePath, checkWritePath, expandEnv } from "./policy.js";

const win = path.win32;

/**
 * Start a project (board manage/PaneProject, U13). Pure planning: what folders, models and manifest a start would make,
 * and every reason it may not. The tool (tools/fmc_project.ts) runs the plan.
 *
 *   D5     the person creates the project folder; the tree is built inside it, and only into an empty folder.
 *   4.1    model names [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt, project code 2-6 A-Z/0-9.
 *   CLM 2  models and the manifest are written only inside the write roots (01_WIP); the other tree folders are
 *          created empty and nothing is ever written into them by a tool.
 */
export const PROJECT_FOLDERS = ["00_Info", "01_WIP", "02_Shared", "03_Published", "04_Archive", "05_Incoming", "06_QA", "07_Cost"];

/** Files Windows leaves in folders; a folder holding only these counts as empty. */
const IGNORABLE = new Set(["desktop.ini", "thumbs.db"]);

export interface ProjectInput {
  project_folder: string;
  code: string;
  originator: string;
  volume: string;
  level: string;
  type: string;
  roles: string[];
  /** Template per role code (.rte), chosen from the kit by the pane or named by Claude. */
  templates: Record<string, string>;
  /** Project Information: kit parameter or built-in name → value. Blanks stay blank. */
  details: Record<string, string>;
  stage?: string;
  issue_set?: string;
  standard?: string;
}

export interface PlannedModel { role: string; name: string; path: string; template: string }

export interface ProjectPlan {
  ok: boolean;
  reasons: string[];
  folders: string[];
  models: PlannedModel[];
  manifest_path: string;
  manifest: Record<string, unknown>;
}

export interface FolderReader {
  exists(p: string): boolean;
  isDirectory(p: string): boolean;
  list(p: string): string[];
}

export function modelName(code: string, originator: string, volume: string, level: string, type: string, role: string, number = 1): string {
  return `${code}-${originator}-${volume}-${level}-${type}-${role}-${String(number).padStart(4, "0")}.rvt`;
}

export function codeProblems(code: string): string[] {
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return [`Project code "${code}" must be 2–6 characters, A–Z and 0–9 (Manual 4.1)`];
  if (code === "FMC") return ["FMC marks the kit library; a project needs its own code"];
  return [];
}

/**
 * The project tree from the kit (PST-002 "folders", MAN 7.4), for these roles. <Role> becomes each role; a folder made
 * at its own time (<Stage>, <Date>_<Milestone>, <Party>\<Date>) stops at its parent, which is made now. Rule 7: the
 * kit's list wins; without it the plugin's own top folders are used and the plan says so.
 */
export function treeFolders(kitTree: string[] | null, roles: string[]): string[] {
  const out: string[] = [];
  for (const entry of kitTree ?? []) {
    const segs = entry.split(/[\\/]+/).filter(Boolean);
    let paths: string[][] = [[]];
    for (const seg of segs) {
      if (seg === "<Role>") { paths = paths.flatMap((p) => roles.map((r) => [...p, r])); continue; }
      if (/<[^>]+>/.test(seg)) break;
      paths = paths.map((p) => [...p, seg]);
    }
    for (const p of paths) if (p.length) out.push(p.join("\\"));
  }
  return [...new Set(out)];
}

export function planProject(input: ProjectInput, cfg: GuardConfig, fs: FolderReader, now: Date = new Date(), kitTree: string[] | null = null): ProjectPlan {
  const reasons: string[] = [];
  const folder = win.normalize(expandEnv(input.project_folder ?? "")).replace(/[\\/]+$/, "");
  const code = (input.code ?? "").trim().toUpperCase();
  const originator = (input.originator ?? "").trim().toUpperCase();
  const volume = (input.volume ?? "").trim().toUpperCase();
  const level = (input.level ?? "").trim().toUpperCase();
  const type = (input.type ?? "").trim().toUpperCase();
  const roles = [...new Set((input.roles ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean))];

  if (!folder || !win.isAbsolute(folder)) reasons.push("Choose the project folder (an absolute path you created)");
  else if (!fs.exists(folder) || !fs.isDirectory(folder))
    reasons.push(`${folder} doesn't exist. Create the project folder yourself; the tree is built inside it (D5)`);
  else {
    const inside = fs.list(folder).filter((f) => !IGNORABLE.has(f.toLowerCase()));
    if (inside.length) reasons.push(`${folder} isn't empty (${inside.slice(0, 3).join(", ")}${inside.length > 3 ? "…" : ""}). The tree is only built in an empty folder (D5)`);
  }
  reasons.push(...codeProblems(code));
  if (!/^[A-Z0-9]{3,6}$/.test(originator)) reasons.push(`Originator "${originator}" must be 3–6 characters, A–Z and 0–9 (Manual 4.1)`);
  if (!/^[A-Z0-9]{2}$/.test(volume)) reasons.push(`Volume "${volume}" must be 2 characters (ZZ for the whole building)`);
  if (!/^[A-Z0-9]{2}$/.test(level)) reasons.push(`Level "${level}" must be 2 characters (ZZ for all levels)`);
  if (!TYPE_CODES.includes(type)) reasons.push(`Type "${type}" is not in Manual 4.2 (M3 for a 3D model)`);
  if (!roles.length) reasons.push("Pick at least one discipline model (role)");
  for (const r of roles) if (!ROLE_CODES.includes(r)) reasons.push(`Role ${r} is not in Manual 4.3`);

  const folders: string[] = [];
  const models: PlannedModel[] = [];
  if (folder) {
    folders.push(...PROJECT_FOLDERS.map((f) => win.join(folder, f)));
    folders.push(...treeFolders(kitTree, roles).map((f) => win.join(folder, f)));
    for (const role of roles) {
      folders.push(win.join(folder, "01_WIP", role), win.join(folder, "01_WIP", role, "Families"));
      const name = modelName(code, originator, volume, level, type, role);
      const target = win.join(folder, "01_WIP", role, name);
      const template = (input.templates ?? {})[role] ?? "";
      if (!template) reasons.push(`No template for role ${role}: the kit has no FMC_${role}_Template or FMC_Base_Template in 06_Templates`);
      else {
        reasons.push(...checkTemplatePath(template, cfg).reasons.map((x) => `${role}: ${x}`));
        if (win.extname(template).toLowerCase() !== ".rte") reasons.push(`${role}: a project model is made from a .rte template`);
        else if (!fs.exists(template)) reasons.push(`${role}: template not found: ${template}`);
      }
      // Path and name rules exactly as fmc_file applies them (01_WIP is a write root; the name follows Manual 4.1).
      reasons.push(...checkWritePath(target, cfg).reasons.map((x) => `${name}: ${x}`));
      models.push({ role, name, path: target, template });
    }
  }

  const manifestPath = folder ? win.join(folder, "01_WIP", "FMC_Project.json") : "";
  if (manifestPath) reasons.push(...checkWritePath(manifestPath, cfg, { checkName: false }).reasons.map((x) => `Manifest: ${x}`));
  const manifest = {
    project: code,
    started: now.toISOString(),
    standard: input.standard ?? "FMC-BIM v2.2",
    stage: input.stage ?? "",
    issue_set: input.issue_set ?? "",
    naming: { originator, volume, level, type },
    roles,
    tree: kitTree ? "kit rulebook PST-002" : "plugin top folders (the kit's PST-002 wasn't found)",
    models: models.map((m) => ({ role: m.role, name: m.name, template: win.basename(m.template) })),
    details: Object.fromEntries(Object.entries(input.details ?? {}).filter(([, v]) => (v ?? "").trim().length)),
  };
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], folders: [...new Set(folders)], models, manifest_path: manifestPath, manifest };
}

/**
 * Project Information for a new model: Revit's own fields plus the kit's parameters. Revit's names: Project Name,
 * Number, Client Name, Address, Status. Anything else is set by parameter name where the template has it.
 */
export function projectInfo(input: ProjectInput): Record<string, string> {
  const d = input.details ?? {};
  const info: Record<string, string> = {
    "Project Number": input.code.trim().toUpperCase(),
    "Project Name": d.FMC_Project_Name ?? "",
    "Client Name": d.FMC_Client ?? "",
    "Project Address": d.FMC_Site_Address ?? "",
    "Project Status": input.stage ?? "",
  };
  for (const [k, v] of Object.entries(d)) info[k] = v;
  return Object.fromEntries(Object.entries(info).filter(([, v]) => (v ?? "").trim().length));
}
