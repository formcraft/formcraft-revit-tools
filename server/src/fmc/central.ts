import crypto from "node:crypto";
import path from "node:path";
import { GuardConfig, ROLE_CODES, TYPE_CODES, archivePlan, checkWritePath, csvLine, expandEnv, isInside } from "./policy.js";
import { forbiddenProjectIn, accessPath } from "./iso19650.js";
import { worksetNameProblems } from "./workshare.js";

const win = path.win32;

/**
 * Central file creation (owner voice GO, 28 Nov 2026): the 13 approved rules. Everything here is pure or sits behind
 * an interface (ports), so it is tested offline with mocks and temp folders. Only CentralBuilder needs Revit
 * (tools/fmc_central.ts sends it to the add-in: commandset/Services/Fmc/FmcCentral.cs).
 *
 *   1  ask first      plan returns ask_user: the path, the workset setup and any detach; create needs confirmed_by.
 *   2  existing       an existing central is never overwritten without overwrite=true + override_reason; then it is
 *                     backed up to <folder>\_Archive first (nothing is deleted).
 *   3  worksets       Architecture / Structure / MEP by default; a custom list is allowed.
 *   4  location       only on the shared (network) drive, in the ISO 19650 WIP container <project>\01_WIP\<Role>\.
 *   5  permissions    the project's 00_Info\Admin\FMC_Access.json (central_creators), or a robot whose
 *                     robots\<id>\rights.json has central_create=true; and the guard's write_roots.
 *   6  log            one timestamped line per attempt in 00_Info\Admin\FMC_Central_Log.csv.
 *   7  dry run        plan quotes the preview; create needs the plan_token from that preview.
 *   8  name           [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt.
 *   9  _v2            when the name exists (and no override), the next free _v2, _v3… is the default.
 *  10  drive          the workshare drive must be reachable with enough free space, or the run aborts.
 *  11  queue          a detach blocked by another Revit session is queued behind it (CentralQueue), not forced.
 *  12  one step       built in a local temp folder, self-tested there, promoted onto the share only after it passes;
 *                     a failed promote is quarantined to _Archive and an overridden central is put back.
 *  13  self-test      read-only open, all worksets load, sync through a throwaway local that is then discarded; only
 *                     then is the central marked ready.
 */
export const DEFAULT_WORKSETS = ["Architecture", "Structure", "MEP"];
export const BUSY_CODE = "FMC-CENTRAL-BUSY";
export const DEFAULT_MIN_FREE_GB = 5;

export interface CentralNameParts { project: string; originator: string; volume: string; level: string; type: string; role: string; number: number }

export function centralName(p: CentralNameParts): string {
  return `${p.project}-${p.originator}-${p.volume}-${p.level}-${p.type}-${p.role}-${String(p.number).padStart(4, "0")}.rvt`;
}

export function centralNameProblems(p: CentralNameParts): string[] {
  const out: string[] = [];
  if (!/^[A-Z0-9]{2,6}$/.test(p.project) || p.project === "FMC") out.push(`Project "${p.project}" must be 2-6 characters A-Z/0-9 and not FMC`);
  if (!/^[A-Z0-9]{3,6}$/.test(p.originator)) out.push(`Originator "${p.originator}" must be 3-6 characters A-Z/0-9`);
  if (!/^[A-Z0-9]{2}$/.test(p.volume)) out.push(`Volume "${p.volume}" must be 2 characters (ZZ for all)`);
  if (!/^[A-Z0-9]{2}$/.test(p.level)) out.push(`Level "${p.level}" must be 2 characters (ZZ for all)`);
  if (!TYPE_CODES.includes(p.type)) out.push(`Type "${p.type}" is not in Manual 4.2 (M3 for a 3D model)`);
  if (!ROLE_CODES.includes(p.role)) out.push(`Role "${p.role}" is not in Manual 4.3`);
  if (!Number.isInteger(p.number) || p.number < 1 || p.number > 9999) out.push(`Number ${p.number} must be 1-9999`);
  return out;
}

/** Rule 9: name.rvt, then name_v2.rvt, name_v3.rvt… the first that doesn't exist. */
export function nextFreeName(folder: string, name: string, exists: (p: string) => boolean, max = 99): { name: string; versioned: boolean } {
  if (!exists(win.join(folder, name))) return { name, versioned: false };
  const ext = win.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let v = 2; v <= max; v++) {
    const n = `${stem}_v${v}${ext}`;
    if (!exists(win.join(folder, n))) return { name: n, versioned: true };
  }
  throw new Error(`No free version of ${name} up to _v${max}`);
}

/** Rule 4: the ISO 19650 location of a role's central. */
export function centralFolder(projectRoot: string, role: string): string {
  return win.join(win.normalize(expandEnv(projectRoot)).replace(/[\\/]+$/, ""), "01_WIP", role.toUpperCase());
}

export function worksetProblems(worksets: string[]): { reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!worksets.length) reasons.push("At least one workset is needed");
  const seen = new Set<string>();
  for (const w of worksets) {
    const n = w.trim();
    if (!n) { reasons.push("A workset name is blank"); continue; }
    if (n.length > 64) reasons.push(`Workset "${n}" is longer than 64 characters`);
    if (/[{}[\]|;<>?`~\\:]/.test(n)) reasons.push(`Workset "${n}" has a character Revit doesn't allow`);
    if (seen.has(n.toLowerCase())) reasons.push(`Workset "${n}" is listed twice`);
    if (n.toLowerCase() === "shared levels and grids") reasons.push(`"${n}" is Revit's own workset; it is made automatically`);
    seen.add(n.toLowerCase());
    const kit = worksetNameProblems(n);
    if (kit.length) warnings.push(`${kit[0]}: allowed by the approved default, but the kit's MAN 4.6 naming differs`);
  }
  return { reasons, warnings };
}

// ---------------------------------------------------------------- drive (rule 4 and 10)

export type DriveKind = "network" | "local" | "removable" | "unknown";

export interface DrivePort {
  /** "network" for a UNC path or a mapped network drive. */
  kind(p: string): DriveKind;
  reachable(p: string): boolean;
  freeBytes(p: string): number | null;
}

export function driveRoot(p: string): string {
  const n = win.normalize(p);
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(n);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}\\`;
  const letter = /^([A-Za-z]):/.exec(n);
  return letter ? `${letter[1].toUpperCase()}:\\` : "";
}

export function checkSharedDrive(target: string, drive: DrivePort, minFreeBytes: number): { reasons: string[]; free: number | null; kind: DriveKind } {
  const root = driveRoot(target);
  if (!root) return { reasons: [`${target} is not on a drive or share`], free: null, kind: "unknown" };
  const kind = /^\\\\/.test(root) ? "network" : drive.kind(root);
  const reasons: string[] = [];
  if (kind !== "network") reasons.push(`Rule 4: a central goes only on the shared network drive, never local. ${root} is ${kind}`);
  if (!drive.reachable(root)) {
    reasons.push(`Rule 10: the workshare drive ${root} isn't reachable`);
    return { reasons, free: null, kind };
  }
  const free = drive.freeBytes(root);
  if (free === null) reasons.push(`Rule 10: the free space on ${root} can't be read`);
  else if (free < minFreeBytes) reasons.push(`Rule 10: ${root} has ${(free / 1e9).toFixed(1)} GB free; ${(minFreeBytes / 1e9).toFixed(1)} GB is needed`);
  return { reasons, free, kind };
}

// ---------------------------------------------------------------- permissions (rule 5)

export interface AccessRules { central_creators?: string[]; robots?: string[] }
export interface RobotRights { robot_id?: string; central_create?: boolean }
export interface Actor { user: string; robot_id?: string }

export function permissionProblems(access: AccessRules | null, actor: Actor, robotRights: RobotRights | null): string[] {
  if (!access) return ["Rule 5: the project has no 00_Info\\Admin\\FMC_Access.json, so no one may create its central (create the ISO folders first)"];
  if (actor.robot_id) {
    if (!(access.robots ?? []).includes(actor.robot_id)) return [`Rule 5: robot ${actor.robot_id} isn't listed in the project's access rules`];
    if (!robotRights || robotRights.robot_id !== actor.robot_id || robotRights.central_create !== true)
      return [`Rule 5: robots\\${actor.robot_id}\\rights.json doesn't allow central_create`];
  }
  const people = (access.central_creators ?? []).map((u) => u.toLowerCase());
  if (!actor.user || !people.includes(actor.user.toLowerCase()))
    return [`Rule 5: ${actor.user || "(no user)"} isn't one of the project's central_creators`];
  return [];
}

// ---------------------------------------------------------------- the plan (rules 1-10)

export interface CentralInput {
  project_folder: string;
  project: string;
  originator: string;
  volume: string;
  level: string;
  type: string;
  role: string;
  number: number;
  /** New central from a template (.rte)… */
  template_path?: string;
  /** …or from an existing model, detached. */
  source_model?: string;
  detach?: "preserve" | "discard";
  worksets?: string[];
  overwrite?: boolean;
  override_reason?: string;
  min_free_gb?: number;
  user: string;
  robot_id?: string;
}

export interface FileReader {
  exists(p: string): boolean;
  readJson(p: string): unknown | null;
  list(p: string): string[];
  size(p: string): number | null;
}

export interface CentralPlan {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  folder: string;
  base_name: string;
  name: string;
  target: string;
  versioned: boolean;
  existing: string | null;
  overwrite: boolean;
  backup_moves: Array<[string, string]>;
  worksets: string[];
  source: { kind: "template" | "model"; path: string; detach: "preserve" | "discard" | null };
  temp_dir: string;
  log_path: string;
  ask_user: string;
  plan_token: string;
}

const up = (s: string | undefined) => (s ?? "").trim().toUpperCase();

export function planCentral(input: CentralInput, cfg: GuardConfig, files: FileReader, drive: DrivePort, tempRoot: string, now: Date = new Date()): CentralPlan {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const root = win.normalize(expandEnv(input.project_folder ?? "")).replace(/[\\/]+$/, "");
  const parts: CentralNameParts = { project: up(input.project), originator: up(input.originator), volume: up(input.volume), level: up(input.level),
    type: up(input.type), role: up(input.role), number: input.number ?? 1 };
  reasons.push(...centralNameProblems(parts));
  if (!root || !win.isAbsolute(root)) reasons.push("project_folder must be an absolute path");
  const forbidden = forbiddenProjectIn(root) ?? forbiddenProjectIn(input.source_model ?? "") ?? forbiddenProjectIn(input.template_path ?? "");
  if (forbidden) reasons.push(`${forbidden} is a project no tool may touch`);
  if ((cfg.protected_roots ?? []).some((r) => isInside(root, r))) reasons.push(`${root} is inside a protected root: originals are never written`);

  const folder = centralFolder(root, parts.role);
  const baseName = centralName(parts);
  const worksets = (input.worksets && input.worksets.length ? input.worksets : DEFAULT_WORKSETS).map((w) => w.trim());
  const ws = worksetProblems(worksets);
  reasons.push(...ws.reasons);
  warnings.push(...ws.warnings);

  // source (rule 1: any detach is shown)
  let source: CentralPlan["source"];
  if (input.template_path && input.source_model) reasons.push("Give a template_path or a source_model, not both");
  if (input.source_model) {
    source = { kind: "model", path: input.source_model, detach: input.detach ?? "preserve" };
    if (win.extname(input.source_model).toLowerCase() !== ".rvt") reasons.push("source_model must be a .rvt");
    else if (!files.exists(input.source_model)) reasons.push(`source_model not found: ${input.source_model}`);
    if (isInside(input.source_model, folder)) reasons.push("The source model can't be in the central's own folder");
  } else {
    source = { kind: "template", path: input.template_path ?? "", detach: null };
    if (!input.template_path) reasons.push("Give a template_path (.rte) or a source_model to detach");
    else if (win.extname(input.template_path).toLowerCase() !== ".rte") reasons.push("template_path must be a .rte");
    else if (!files.exists(input.template_path)) reasons.push(`Template not found: ${input.template_path}`);
  }

  // rule 4 + 10: the shared drive, reachable, with space (3× the source, at least min_free_gb)
  const srcSize = source.path ? files.size(source.path) ?? 0 : 0;
  const minFree = Math.max((input.min_free_gb ?? DEFAULT_MIN_FREE_GB) * 1e9, srcSize * 3);
  reasons.push(...checkSharedDrive(folder, drive, minFree).reasons);
  // the guard's write roots (rule 5, part 2); the name is checked by rule 8 above
  reasons.push(...checkWritePath(win.join(folder, baseName), cfg, { checkName: false }).reasons.map((r) => `Guard: ${r}`));
  if (!files.exists(folder)) reasons.push(`The ISO 19650 folder ${folder} doesn't exist (run fmc_iso_folders first)`);

  // rule 5: project access rules
  const access = files.readJson(accessPath(root)) as AccessRules | null;
  const rights = input.robot_id ? files.readJson(win.join(root, "robots", input.robot_id, "rights.json")) as RobotRights | null : null;
  reasons.push(...permissionProblems(access, { user: input.user, robot_id: input.robot_id }, rights));

  // rules 2 + 9
  const existingPath = win.join(folder, baseName);
  const existing = files.exists(existingPath) ? existingPath : null;
  let name = baseName;
  let versioned = false;
  let backup: Array<[string, string]> = [];
  const overwrite = input.overwrite === true;
  if (existing && overwrite) {
    if (!(input.override_reason ?? "").trim()) reasons.push("Rule 2: overwriting an existing central needs an override_reason");
    backup = archivePlan(existing, files.list(folder), now).moves;
    const backupDir = win.join(folder, baseName.replace(/\.rvt$/i, "_backup"));
    const stamp = win.basename(backup[0][1]).split("_")[0];
    if (files.exists(backupDir)) backup.push([backupDir, win.join(folder, "_Archive", `${stamp}_${win.basename(backupDir)}`)]);
  } else if (existing) {
    try { ({ name, versioned } = nextFreeName(folder, baseName, (p) => files.exists(p))); } catch (e) { reasons.push(String((e as Error).message)); }
  } else if (overwrite) warnings.push("overwrite=true but there is no existing central; it is ignored");

  const target = win.join(folder, name);
  if (target.length >= 200) reasons.push(`Rule 8: the full path is ${target.length} characters; Manual 4.1 keeps it under 200`);
  const logPath = win.join(root, "00_Info", "Admin", "FMC_Central_Log.csv");
  const plan0 = { target, worksets, source, overwrite: overwrite && !!existing, existing };
  const token = crypto.createHash("sha256").update(JSON.stringify(plan0)).digest("hex").slice(0, 16);
  const tempDir = win.join(tempRoot, `fmc_central_${token}`);
  const ask = [
    `Create central file ${name}?`,
    `  Path:     ${target}`,
    `  Worksets: ${worksets.join(", ")}${input.worksets?.length ? " (custom)" : " (default)"} + Revit's "Shared Levels and Grids"`,
    source.kind === "model"
      ? `  Detach:   ${source.path} (${source.detach === "discard" ? "detach and DISCARD its worksets" : "detach and preserve its worksets"}); the source file isn't changed`
      : `  From:     template ${source.path} (no detach)`,
    existing && overwrite ? `  OVERRIDE: the existing ${baseName} is backed up to ${win.join(folder, "_Archive")} first. Reason: ${input.override_reason ?? ""}`
      : versioned ? `  ${baseName} exists, so this is a new version: ${name} (the existing central is not touched)` : "",
    `  Steps:    build in ${tempDir}, self-test, move onto the share, self-test again (read-only open, all worksets, sync through a throwaway local), mark ready`,
  ].filter(Boolean).join("\n");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], warnings, folder, base_name: baseName, name, target, versioned, existing,
    overwrite: overwrite && !!existing, backup_moves: backup, worksets, source, temp_dir: tempDir, log_path: logPath, ask_user: ask, plan_token: token };
}

// ---------------------------------------------------------------- queue (rule 11)

export interface QueuedCentral { id: string; queued_at: string; target: string; plan_token: string; input: CentralInput; confirmed_by: string; blocked_by: string }

export interface CentralQueue {
  list(): QueuedCentral[];
  enqueue(job: Omit<QueuedCentral, "id" | "queued_at">, now: Date): QueuedCentral;
  remove(id: string): boolean;
}

/** In-memory queue (tests); tools/fmc_central.ts persists the same shape as JSON (fileQueue). */
export function memoryQueue(start: QueuedCentral[] = []): CentralQueue {
  const items = [...start];
  return {
    list: () => [...items],
    enqueue: (job, now) => {
      const existing = items.find((i) => i.target.toLowerCase() === job.target.toLowerCase());
      if (existing) return existing;
      const q = { ...job, id: crypto.createHash("sha1").update(job.target + now.toISOString()).digest("hex").slice(0, 10), queued_at: now.toISOString() };
      items.push(q);
      return q;
    },
    remove: (id) => { const i = items.findIndex((x) => x.id === id); if (i < 0) return false; items.splice(i, 1); return true; },
  };
}

export interface JsonStore { read(): string | null; write(text: string): void }

export function fileQueue(store: JsonStore): CentralQueue {
  const load = (): QueuedCentral[] => { try { const t = store.read(); return t ? JSON.parse(t) as QueuedCentral[] : []; } catch { return []; } };
  return {
    list: load,
    enqueue: (job, now) => { const q = memoryQueue(load()); const r = q.enqueue(job, now); store.write(JSON.stringify(q.list(), null, 2)); return r; },
    remove: (id) => { const q = memoryQueue(load()); const r = q.remove(id); if (r) store.write(JSON.stringify(q.list(), null, 2)); return r; },
  };
}

// ---------------------------------------------------------------- log (rule 6)

export interface LogSink { append(line: string): void }

export const CENTRAL_LOG_HEADER = ["timestamp", "user", "robot", "target", "result", "detail"];

export function logLine(now: Date, actor: Actor, target: string, result: string, detail: string): string {
  return csvLine([now.toISOString(), actor.user, actor.robot_id ?? "", target, result, detail]);
}

// ---------------------------------------------------------------- the one transaction (rules 11-13)

export interface BuildRequest { temp_path: string; worksets: string[]; source: CentralPlan["source"] }
export interface SelfTestResult { ok: boolean; read_only_open: boolean; worksets_loaded: string[]; missing_worksets: string[]; sync_verified: boolean; local_discarded: boolean; detail: string }

/** The Revit side. Throws an Error whose message starts with [FMC-CENTRAL-BUSY] when another session blocks the detach. */
export interface CentralBuilder {
  build(req: BuildRequest): Promise<void>;
  selfTest(centralPath: string, worksets: string[], throwawayDir: string): Promise<SelfTestResult>;
  /** Moves the tested temp central onto the share at target (never overwriting). */
  promote(tempPath: string, target: string): Promise<void>;
}

export interface TxFs {
  exists(p: string): boolean;
  mkdir(p: string): void;
  move(from: string, to: string): void;
  /** Removes a folder the transaction created itself (the temp build and throwaway locals). Never used on the share. */
  removeOwnTemp(p: string): void;
}

export interface CentralPorts { builder: CentralBuilder; fs: TxFs; drive: DrivePort; queue: CentralQueue; log: LogSink; now: () => Date }

export type CentralOutcome =
  | { status: "ready"; target: string; steps: string[]; self_test: SelfTestResult }
  | { status: "queued"; job: QueuedCentral; position: number; steps: string[] }
  | { status: "aborted"; reason: string; steps: string[]; rolled_back: string[] };

export function isBusy(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes(`[${BUSY_CODE}]`);
}

/**
 * Runs a confirmed plan as one transaction. The share sees nothing until the temp build passed its self-test, and
 * a failure after that point is rolled back: the half-made central is quarantined to _Archive (never deleted) and an
 * overridden central is moved back.
 */
export async function runCentral(plan: CentralPlan, input: CentralInput, confirmedBy: string, ports: CentralPorts): Promise<CentralOutcome> {
  const steps: string[] = [];
  const rolled: string[] = [];
  const actor: Actor = { user: input.user, robot_id: input.robot_id };
  const log = (result: string, detail: string) => { try { ports.log.append(logLine(ports.now(), actor, plan.target, result, detail)); } catch { /* never blocks */ } };
  const abort = (reason: string): CentralOutcome => { log("aborted", reason); return { status: "aborted", reason, steps, rolled_back: rolled }; };

  if (!plan.ok) return abort(plan.reasons.join(" | "));
  if (!confirmedBy.trim()) return abort("Rule 1: the person's yes (confirmed_by) is missing");

  // rule 10 again, right before the work
  const drive = checkSharedDrive(plan.folder, ports.drive, Math.max((input.min_free_gb ?? DEFAULT_MIN_FREE_GB) * 1e9, 0));
  if (drive.reasons.length) return abort(drive.reasons.join(" | "));
  // rule 2/9 race: the target appeared since the plan
  if (ports.fs.exists(plan.target) && !plan.overwrite) return abort(`${plan.target} appeared since the dry run; plan again`);
  steps.push("Drive and target checked");

  const tempCentral = win.join(plan.temp_dir, plan.name);
  try {
    if (!ports.fs.exists(plan.temp_dir)) ports.fs.mkdir(plan.temp_dir);
    await ports.builder.build({ temp_path: tempCentral, worksets: plan.worksets, source: plan.source });
    steps.push(`Built in temp: ${tempCentral}`);
  } catch (e) {
    try { ports.fs.removeOwnTemp(plan.temp_dir); } catch { /* temp only */ }
    if (isBusy(e)) {
      const job = ports.queue.enqueue({ target: plan.target, plan_token: plan.plan_token, input, confirmed_by: confirmedBy, blocked_by: (e as Error).message }, ports.now());
      const position = ports.queue.list().findIndex((j) => j.id === job.id) + 1;
      steps.push(`Queued behind the Revit session that holds the source (position ${position})`);
      log("queued", (e as Error).message);
      return { status: "queued", job, position, steps };
    }
    return abort(`Build failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const throwaway = win.join(plan.temp_dir, "throwaway_local");
  let test = await safeTest(ports.builder, tempCentral, plan.worksets, throwaway);
  if (!test.ok) {
    try { ports.fs.removeOwnTemp(plan.temp_dir); } catch { /* temp only */ }
    return abort(`Self-test in temp failed: ${test.detail}`);
  }
  steps.push("Self-test in temp passed");

  // rule 2: back up the overridden central
  const moved: Array<[string, string]> = [];
  try {
    for (const [from, to] of plan.backup_moves) {
      if (!ports.fs.exists(from)) continue;
      const dir = win.dirname(to);
      if (!ports.fs.exists(dir)) ports.fs.mkdir(dir);
      ports.fs.move(from, to);
      moved.push([from, to]);
    }
    if (moved.length) steps.push(`Backed up the existing central: ${moved.map((m) => m[1]).join(", ")}`);
  } catch (e) {
    restore(ports.fs, moved, rolled);
    try { ports.fs.removeOwnTemp(plan.temp_dir); } catch { /* temp only */ }
    return abort(`Backup of the existing central failed: ${(e as Error).message}`);
  }

  const quarantine = () => {
    if (ports.fs.exists(plan.target)) {
      const q = win.join(plan.folder, "_Archive", `FAILED_${ports.now().toISOString().replace(/[:.]/g, "")}_${plan.name}`);
      try { if (!ports.fs.exists(win.dirname(q))) ports.fs.mkdir(win.dirname(q)); ports.fs.move(plan.target, q); rolled.push(`quarantined ${plan.target} → ${q}`); }
      catch (err) { rolled.push(`could not quarantine ${plan.target}: ${(err as Error).message}`); }
    }
    restore(ports.fs, moved, rolled);
    try { ports.fs.removeOwnTemp(plan.temp_dir); } catch { /* temp only */ }
  };

  if (ports.fs.exists(plan.target)) {
    // someone else's file appeared: it is not ours to quarantine
    restore(ports.fs, moved, rolled);
    try { ports.fs.removeOwnTemp(plan.temp_dir); } catch { /* temp only */ }
    return abort(`${plan.target} exists; a promote never overwrites`);
  }
  try {
    await ports.builder.promote(tempCentral, plan.target);
    steps.push(`Moved onto the share: ${plan.target}`);
  } catch (e) {
    quarantine();
    return abort(`Move onto the share failed: ${(e as Error).message}`);
  }

  test = await safeTest(ports.builder, plan.target, plan.worksets, throwaway);
  if (!test.ok) {
    quarantine();
    return abort(`Self-test on the share failed: ${test.detail}`);
  }
  steps.push("Self-test on the share passed (read-only open, all worksets, sync via throwaway local, local discarded)");
  try { ports.fs.removeOwnTemp(plan.temp_dir); } catch { /* temp only */ }
  log("ready", `worksets ${plan.worksets.join("/")}; ${plan.source.kind} ${plan.source.path}${plan.overwrite ? "; override: " + (input.override_reason ?? "") : ""}; confirmed by ${confirmedBy}`);
  steps.push("Marked ready");
  return { status: "ready", target: plan.target, steps, self_test: test };
}

async function safeTest(b: CentralBuilder, p: string, worksets: string[], throwaway: string): Promise<SelfTestResult> {
  try {
    const r = await b.selfTest(p, worksets, throwaway);
    const missing = worksets.filter((w) => !r.worksets_loaded.map((x) => x.toLowerCase()).includes(w.toLowerCase()));
    const ok = r.ok && r.read_only_open && r.sync_verified && r.local_discarded && missing.length === 0;
    return { ...r, ok, missing_worksets: missing, detail: ok ? r.detail : [r.detail, missing.length ? `missing worksets: ${missing.join(", ")}` : "",
      !r.read_only_open ? "read-only open failed" : "", !r.sync_verified ? "sync not verified" : "", !r.local_discarded ? "throwaway local not discarded" : ""].filter(Boolean).join("; ") };
  } catch (e) {
    return { ok: false, read_only_open: false, worksets_loaded: [], missing_worksets: worksets, sync_verified: false, local_discarded: false, detail: (e as Error).message };
  }
}

function restore(fs: TxFs, moved: Array<[string, string]>, rolled: string[]) {
  for (const [from, to] of [...moved].reverse()) {
    try { fs.move(to, from); rolled.push(`restored ${from}`); } catch (e) { rolled.push(`could not restore ${from}: ${(e as Error).message}`); }
  }
  moved.length = 0;
}
