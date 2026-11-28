import crypto from "node:crypto";
import path from "node:path";
import { GuardConfig, ROLE_CODES, csvLine, expandEnv, isInside } from "./policy.js";

const win = path.win32;

/**
 * ISO 19650 project folders (owner voice GO, 28 Nov 2026). Pure planning and a writer behind an interface, so the
 * tree can be tested in a temp folder without Revit.
 *
 *   Containers  00_Info (info + Admin), 01_WIP, 02_Shared, 03_Published, 04_Archive (the ISO "Archived" state), the
 *               names the kit already uses (project.ts PROJECT_FOLDERS), one 01_WIP\<Role> and 02_Shared\<Role> per role.
 *   Robots      robots\<robot-id>\ holding rights.json, settings.json and logs\ for each robot that works on the project.
 *   Dry run     plan returns the tree and a plan_token; create runs only with dry_run=false and that same token.
 *   Never       an existing, non-empty folder (existing projects are never touched), a protected root, A-0001 or
 *               HEBERT HOSTELS. Files are written with "wx": nothing is ever overwritten.
 */
export const ISO_CONTAINERS = [
  { folder: "00_Info", state: "Info", note: "Project information and administration (not a CDE state)" },
  { folder: "01_WIP", state: "WIP", note: "Work in progress (S0): each task team's own container" },
  { folder: "02_Shared", state: "Shared", note: "Shared (S1-S4): checked, reviewed and approved for sharing" },
  { folder: "03_Published", state: "Published", note: "Published (A/B codes): authorised for use" },
  { folder: "04_Archive", state: "Archived", note: "Archived: superseded and historic information, never deleted" },
] as const;

/** Projects no tool may touch (owner's standing rule). Matched on any path segment, case-insensitive. */
export const FORBIDDEN_PROJECTS = ["A-0001", "HEBERT HOSTELS"];

export function forbiddenProjectIn(p: string): string | null {
  const segs = win.normalize(expandEnv(p)).toUpperCase().split(/[\\/]+/);
  for (const f of FORBIDDEN_PROJECTS) if (segs.some((s) => s.includes(f))) return f;
  return null;
}

export interface RobotSpec {
  id: string;
  /** Containers the robot may read (relative to the project folder). Default: all ISO containers. */
  read?: string[];
  /** Containers the robot may write. Default: its roles' 01_WIP folders only. */
  write?: string[];
  /** May this robot create a central file (fmc_central, rule 5)? Default false. */
  central_create?: boolean;
  roles?: string[];
}

export interface IsoFolderInput {
  project_folder: string;
  code: string;
  name?: string;
  roles: string[];
  robots?: RobotSpec[];
  /** People who may create central files (FMC_Access.json, read by fmc_central rule 5). */
  central_creators?: string[];
  created_by?: string;
}

export interface PlannedFile { path: string; content: string }

export interface IsoFolderPlan {
  ok: boolean;
  reasons: string[];
  root: string;
  folders: string[];
  files: PlannedFile[];
  tree: string;
  plan_token: string;
}

export interface TreeReader {
  exists(p: string): boolean;
  isDirectory(p: string): boolean;
  list(p: string): string[];
}

export interface TreeWriter extends TreeReader {
  mkdir(p: string): void;
  /** Must fail when the file exists (flag "wx"). */
  writeNew(p: string, content: string): void;
}

const IGNORABLE = new Set(["desktop.ini", "thumbs.db"]);
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function robotIdProblems(id: string): string[] {
  return ROBOT_ID.test(id ?? "") ? [] : [`Robot id "${id}" must be 2-63 characters: a-z, 0-9 and "-", starting with a letter or digit`];
}

export function accessPath(root: string): string { return win.join(root, "00_Info", "Admin", "FMC_Access.json"); }
export function robotDir(root: string, id: string): string { return win.join(root, "robots", id); }

/** The token ignores the time stamp, so a plan and the create a few minutes later match when nothing else changed. */
export function planToken(folders: string[], files: PlannedFile[]): string {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({ folders, files: files.map((f) => [f.path, f.content]) }));
  return h.digest("hex").slice(0, 16);
}

function renderTree(root: string, folders: string[], files: PlannedFile[]): string {
  const rel = (p: string) => win.relative(root, p);
  const items = [...folders.map((f) => rel(f) + "\\"), ...files.map((f) => rel(f.path))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return [root + "\\", ...items.map((i) => "  " + i)].join("\n");
}

export function planIsoFolders(input: IsoFolderInput, cfg: GuardConfig, fs: TreeReader, now: Date = new Date()): IsoFolderPlan {
  const reasons: string[] = [];
  const root = win.normalize(expandEnv(input.project_folder ?? "")).replace(/[\\/]+$/, "");
  const code = (input.code ?? "").trim().toUpperCase();
  const roles = [...new Set((input.roles ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean))];
  const robots = input.robots ?? [];

  if (!root || !win.isAbsolute(root)) reasons.push("project_folder must be an absolute path");
  const bad = root ? forbiddenProjectIn(root) : null;
  if (bad) reasons.push(`${bad} is a project no tool may touch`);
  if (root && (cfg.protected_roots ?? []).some((r) => isInside(root, r))) reasons.push(`${root} is inside a protected root (originals are never written)`);
  const gate = root ? cfg.blocked_segments.find((s) => root.toLowerCase().split("\\").includes(s.toLowerCase())) : undefined;
  if (gate) reasons.push(`A project folder can't be made inside a CDE gate folder (${gate})`);
  if (root && win.isAbsolute(root)) {
    const parent = win.dirname(root);
    if (!fs.exists(parent) || !fs.isDirectory(parent)) reasons.push(`The parent folder ${parent} doesn't exist`);
    if (fs.exists(root)) {
      if (!fs.isDirectory(root)) reasons.push(`${root} exists and is a file`);
      else {
        const inside = fs.list(root).filter((f) => !IGNORABLE.has(f.toLowerCase()));
        if (inside.length) reasons.push(`${root} isn't empty (${inside.slice(0, 3).join(", ")}${inside.length > 3 ? "…" : ""}). Existing project folders are never touched`);
      }
    }
  }
  if (!/^[A-Z0-9]{2,6}$/.test(code) || code === "FMC") reasons.push(`Project code "${code}" must be 2-6 characters A-Z/0-9 and not FMC (Manual 4.1)`);
  if (!roles.length) reasons.push("Pick at least one role");
  for (const r of roles) if (!ROLE_CODES.includes(r)) reasons.push(`Role ${r} is not in Manual 4.3`);
  const seen = new Set<string>();
  for (const rb of robots) {
    reasons.push(...robotIdProblems(rb.id));
    if (seen.has(rb.id)) reasons.push(`Robot id ${rb.id} is listed twice`);
    seen.add(rb.id);
    for (const r of rb.roles ?? []) if (!roles.includes(r.toUpperCase())) reasons.push(`Robot ${rb.id}: role ${r} is not one of the project's roles`);
  }

  const folders: string[] = [];
  const files: PlannedFile[] = [];
  if (root) {
    folders.push(root);
    for (const c of ISO_CONTAINERS) folders.push(win.join(root, c.folder));
    folders.push(win.join(root, "00_Info", "Admin"));
    for (const r of roles) folders.push(win.join(root, "01_WIP", r), win.join(root, "02_Shared", r));
    folders.push(win.join(root, "robots"));
    const stamp = now.toISOString();
    files.push({
      path: win.join(root, "00_Info", "FMC_Project_Info.json"),
      content: JSON.stringify({
        project: code, name: input.name ?? "", created: stamp, created_by: input.created_by ?? "", standard: "ISO 19650-2 (folder states)",
        containers: ISO_CONTAINERS.map((c) => ({ folder: c.folder, state: c.state, note: c.note })), roles,
      }, null, 2),
    });
    files.push({
      path: win.join(root, "00_Info", "README.txt"),
      content: [`Project ${code}${input.name ? " - " + input.name : ""}`, "", "ISO 19650 containers:",
        ...ISO_CONTAINERS.map((c) => `  ${c.folder.padEnd(13)} ${c.state.padEnd(10)} ${c.note}`), "",
        "robots\\<robot-id>\\  rights.json (what the robot may read and write), settings.json, logs\\", ""].join("\r\n"),
    });
    files.push({
      path: accessPath(root),
      content: JSON.stringify({
        version: 1, project: code,
        central_creators: [...new Set((input.central_creators ?? []).map((s) => s.trim()).filter(Boolean))],
        roles: Object.fromEntries(roles.map((r) => [r, { wip: `01_WIP\\${r}`, shared: `02_Shared\\${r}` }])),
        robots: robots.map((r) => r.id),
      }, null, 2),
    });
    files.push({ path: win.join(root, "00_Info", "Admin", "FMC_Admin_Log.csv"),
      content: csvLine(["timestamp", "action", "by", "detail"]) + csvLine([stamp, "iso_folders_create", input.created_by ?? "", `${code}: ${roles.join(",")}; robots ${robots.map((r) => r.id).join(",") || "none"}`]) });
    for (const rb of robots) {
      const dir = robotDir(root, rb.id);
      const rRoles = (rb.roles ?? roles).map((r) => r.toUpperCase());
      folders.push(dir, win.join(dir, "logs"));
      files.push({ path: win.join(dir, "rights.json"), content: JSON.stringify({
        robot_id: rb.id, project: code,
        read: rb.read ?? ISO_CONTAINERS.map((c) => c.folder),
        write: rb.write ?? rRoles.map((r) => `01_WIP\\${r}`),
        central_create: rb.central_create === true,
        never: ["02_Shared", "03_Published", "04_Archive"],
      }, null, 2) });
      files.push({ path: win.join(dir, "settings.json"), content: JSON.stringify({
        robot_id: rb.id, project: code, roles: rRoles, dry_run_first: true, log_dir: "logs", created: stamp,
      }, null, 2) });
    }
  }
  const uniq = [...new Set(folders)];
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], root, folders: uniq, files, tree: renderTree(root, uniq, files), plan_token: planToken(uniq, files.map((f) => ({ path: f.path, content: f.content.split(now.toISOString()).join("") }))) };
}

export interface ApplyResult { ok: boolean; created_folders: number; created_files: number; error?: string }

/** Creates the planned tree. Re-checks that the folder is still new/empty right before it writes. */
export function applyIsoFolders(plan: IsoFolderPlan, fs: TreeWriter): ApplyResult {
  if (!plan.ok) return { ok: false, created_folders: 0, created_files: 0, error: plan.reasons.join(" | ") };
  if (fs.exists(plan.root) && fs.list(plan.root).filter((f) => !IGNORABLE.has(f.toLowerCase())).length)
    return { ok: false, created_folders: 0, created_files: 0, error: `${plan.root} is no longer empty; nothing was written` };
  let folders = 0;
  let files = 0;
  try {
    for (const f of plan.folders) { if (!fs.exists(f)) { fs.mkdir(f); folders++; } }
    for (const f of plan.files) { fs.writeNew(f.path, f.content); files++; }
    return { ok: true, created_folders: folders, created_files: files };
  } catch (e) {
    return { ok: false, created_folders: folders, created_files: files, error: e instanceof Error ? e.message : String(e) };
  }
}
