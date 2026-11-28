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
  /** PJ-5: several models, each with its own volume, level, type and number. Overrides roles when given. */
  models?: ModelSpec[];
  /** PJ-3: a role with no template named takes the kit's newest FMC_<Role>_Template (else FMC_Base_Template) from template_roots. */
  templates_from_kit?: boolean;
  /** PJ-3: a template found only in _Staging is used only when this is true. */
  allow_staging?: boolean;
}

export interface ModelSpec { role: string; volume?: string; level?: string; type?: string; number?: number }

export interface PlannedModel { role: string; name: string; path: string; template: string; template_source?: "given" | "kit" | "kit_base" | "none" }

export interface KitTemplate { role: string; version: string; path: string; staging: boolean }

const TEMPLATE_NAME = /^FMC_([A-Za-z0-9]+)_Template(?:_v(\d+(?:\.\d+)*))?\.rte$/i;

/** The kit's project templates under the template roots: the root, 06_Templates and their _Staging folders (PJ-3). */
export function findKitTemplates(roots: string[], reader: FolderReader): KitTemplate[] {
  const out: KitTemplate[] = [];
  const seen = new Set<string>();
  for (const rootDir of roots.map((r) => expandEnv(r)).filter(Boolean)) {
    const dirs = [rootDir, win.join(rootDir, "_Staging"), win.join(rootDir, "06_Templates"), win.join(rootDir, "06_Templates", "_Staging")];
    for (const dir of dirs) {
      if (!reader.exists(dir) || !reader.isDirectory(dir)) continue;
      for (const name of reader.list(dir)) {
        const m = TEMPLATE_NAME.exec(name);
        if (!m) continue;
        const full = win.join(dir, name);
        if (seen.has(full.toLowerCase())) continue;
        seen.add(full.toLowerCase());
        out.push({ role: m[1].toUpperCase(), version: m[2] ?? "", path: full, staging: /\\_staging(\\|$)/i.test(dir) });
      }
    }
  }
  return out;
}

function versionKey(v: string): number[] { return v ? v.split(".").map((n) => Number(n) || 0) : [0]; }
function newer(a: string, b: string): number {
  const x = versionKey(a); const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The role's newest released template, else FMC_Base_Template; staging copies only when allowed. */
export function pickKitTemplate(list: KitTemplate[], role: string, allowStaging = false): { template: KitTemplate | null; source: "kit" | "kit_base" | "none"; note: string } {
  const pick = (want: string) => {
    const mine = list.filter((t) => t.role === want);
    const released = mine.filter((t) => !t.staging).sort((a, b) => newer(b.version, a.version));
    const staged = mine.filter((t) => t.staging).sort((a, b) => newer(b.version, a.version));
    return { best: released[0] ?? (allowStaging ? staged[0] : undefined) ?? null, stagedOnly: !released.length && staged.length > 0 };
  };
  const own = pick(role.toUpperCase());
  if (own.best) return { template: own.best, source: "kit", note: own.best.staging ? "from _Staging (allow_staging true)" : "released" };
  const base = pick("BASE");
  if (base.best) return { template: base.best, source: "kit_base", note: `no FMC_${role}_Template; FMC_Base_Template used${base.best.staging ? " from _Staging" : ""}` };
  const staged = own.stagedOnly || base.stagedOnly;
  return { template: null, source: "none", note: staged ? `FMC_${role}_Template is only in _Staging: pass allow_staging true to use it` : `no FMC_${role}_Template or FMC_Base_Template under the template roots` };
}

/** Revit's own Project Information fields (set by name on every template). */
export const REVIT_PROJECT_INFO = ["Project Name", "Project Number", "Client Name", "Project Address", "Project Status", "Project Issue Date", "Organization Name", "Organization Description", "Building Name", "Author"];

/** PJ-6: which details keys are Revit's, which are the kit's, and which neither knows (they would be reported missing after the run). */
export function detailsCheck(details: Record<string, string>, kitNames: string[] | null): { revit: string[]; kit: string[]; unknown: string[]; kit_list: "read" | "not found" } {
  const revit: string[] = []; const kit: string[] = []; const unknown: string[] = [];
  const kitSet = new Set((kitNames ?? []).map((n) => n.toLowerCase()));
  for (const key of Object.keys(details ?? {})) {
    if (REVIT_PROJECT_INFO.some((n) => n.toLowerCase() === key.toLowerCase())) revit.push(key);
    else if (kitSet.has(key.toLowerCase())) kit.push(key);
    else unknown.push(key);
  }
  return { revit, kit, unknown, kit_list: kitNames ? "read" : "not found" };
}

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
  const specs: ModelSpec[] = (input.models ?? []).length
    ? (input.models ?? []).map((m) => ({ ...m, role: (m.role ?? "").trim().toUpperCase() })).filter((m) => m.role)
    : [];
  const kitList = input.templates_from_kit ? findKitTemplates(cfg.template_roots ?? [], fs) : [];
  const reasons: string[] = [];
  const folder = win.normalize(expandEnv(input.project_folder ?? "")).replace(/[\\/]+$/, "");
  const code = (input.code ?? "").trim().toUpperCase();
  const originator = (input.originator ?? "").trim().toUpperCase();
  const volume = (input.volume ?? "").trim().toUpperCase();
  const level = (input.level ?? "").trim().toUpperCase();
  const type = (input.type ?? "").trim().toUpperCase();
  const roles = specs.length ? [...new Set(specs.map((m) => m.role))] : [...new Set((input.roles ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean))];

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
    const each: ModelSpec[] = specs.length ? specs : roles.map((role) => ({ role }));
    const names = new Set<string>();
    for (const spec of each) {
      const role = spec.role;
      const v = (spec.volume ?? volume).trim().toUpperCase();
      const l = (spec.level ?? level).trim().toUpperCase();
      const t = (spec.type ?? type).trim().toUpperCase();
      const number = Math.max(1, Math.floor(spec.number ?? 1));
      if (specs.length) {
        if (!/^[A-Z0-9]{2}$/.test(v)) reasons.push(`${role}: volume "${v}" must be 2 characters`);
        if (!/^[A-Z0-9]{2}$/.test(l)) reasons.push(`${role}: level "${l}" must be 2 characters`);
        if (!TYPE_CODES.includes(t)) reasons.push(`${role}: type "${t}" is not in Manual 4.2`);
        if (number > 9999) reasons.push(`${role}: number ${number} is more than 4 digits`);
      }
      folders.push(win.join(folder, "01_WIP", role), win.join(folder, "01_WIP", role, "Families"));
      const name = modelName(code, originator, v, l, t, role, number);
      if (names.has(name.toLowerCase())) reasons.push(`${name} is listed twice: give each model its own volume, level, type or number`);
      names.add(name.toLowerCase());
      const target = win.join(folder, "01_WIP", role, name);
      let template = (input.templates ?? {})[role] ?? "";
      let source: PlannedModel["template_source"] = template ? "given" : "none";
      if (!template && input.templates_from_kit) {
        const found = pickKitTemplate(kitList, role, input.allow_staging === true);
        if (found.template) { template = found.template.path; source = found.source; }
        else reasons.push(`No template for role ${role}: ${found.note}`);
      }
      if (!template) {
        if (!input.templates_from_kit) reasons.push(`No template for role ${role}: name one in templates, or set templates_from_kit true to take the kit's FMC_${role}_Template_v*.rte (or FMC_Base_Template)`);
      } else {
        reasons.push(...checkTemplatePath(template, cfg).reasons.map((x) => `${role}: ${x}`));
        if (win.extname(template).toLowerCase() !== ".rte") reasons.push(`${role}: a project model is made from a .rte template`);
        else if (!fs.exists(template)) reasons.push(`${role}: template not found: ${template}`);
      }
      // Path and name rules exactly as fmc_file applies them (01_WIP is a write root; the name follows Manual 4.1).
      reasons.push(...checkWritePath(target, cfg).reasons.map((x) => `${name}: ${x}`));
      models.push({ role, name, path: target, template, template_source: source });
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
