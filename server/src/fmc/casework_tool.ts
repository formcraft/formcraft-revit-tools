/** fmc_casework's shared plumbing: config, files, the standards and computation every action starts from, the call context. */
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, csvLine, expandEnv } from "./policy.js";
import { Casework, KitRequest, LibMaterial, Standards, Unit, checkStandards, checkUnits, compute, costs, layoutAny, mergeStandards, missingForKinds, readLibrary, Run } from "./casework.js";
import { KitFamily, RoomRead, coordinationChecks, matchWalls, registerFamily, runFromRoom } from "./casework_place.js";
import { csvRow } from "../tools/fmc_sheets.js";
import { StandardsRevision, standardsRevision, unitsHash } from "./casework_run.js";
import { StoredRun, loadRun, usableRoom } from "./casework_store.js";
import { FmcCaseworkArgs } from "./casework_shape.js";

/** The Revit call: a dry run goes through sendRaw (no lock), a real run through sendCommand (lease, lock, AI gate). */
export type RevitSend = (command: string, payload: object, dry: boolean, timeoutMs: number) => Promise<unknown>;

/** What a test can stand in for: the guard config, and the Revit call. */
export interface CaseworkIo {
  config?: { config: GuardConfig; problem?: string };
  revit?: RevitSend;
  /** Where saved runs go (default %APPDATA%\\Formcraft\\casework\\runs) */
  store?: string;
}

export type Reply = { content: Array<{ type: "text"; text: string }>; isError: boolean };

/** A real run (dry_run=false) of pack, shop_drawings or remove also needs confirm=true: the person has seen the dry run. */
export function needsConfirm(args: FmcCaseworkArgs, dry: boolean, what: string): string | null {
  return !dry && !args.confirm ? `dry_run=false ${what}: show the person the dry run first, then call again with confirm=true` : null;
}

/** One call: its arguments, config, dry run, run id, Revit call and reply (which stamps the run id and standards revision). */
export interface Ctx {
  args: FmcCaseworkArgs;
  config: GuardConfig;
  problem?: string;
  dry: boolean;
  run_id: string;
  send: RevitSend;
  reply: (body: object, isError?: boolean) => Reply;
  store?: string;
  /** What this call saves under its run id when it ends (inputs; a room read) */
  entry: StoredRun;
  /** The saved run named by run_id, when there is one */
  saved?: StoredRun;
}

/**
 * The call's inputs with a saved run filled in: what the call sends wins, the saved run fills the rest; `modules`
 * goes over the run's. A run_id that isn't saved is a refusal, never a guess.
 */
export function resolveInputs(args: FmcCaseworkArgs, store?: string): { args: FmcCaseworkArgs; saved?: StoredRun } | { refused: object } {
  let out: FmcCaseworkArgs = args;
  let saved: StoredRun | undefined;
  if (args.run_id.trim()) {
    const got = loadRun(args.run_id, store);
    if ("problem" in got) return { refused: { refused: true, reasons: [got.problem] } };
    saved = got.run;
    const useUnits = !args.run && !args.units?.length && !!saved.units;
    out = { ...args,
      run: args.run ?? (args.units?.length || useUnits ? undefined : saved.run as FmcCaseworkArgs["run"]),
      units: args.units?.length ? args.units : useUnits ? saved.units as FmcCaseworkArgs["units"] : undefined,
      standards: args.standards ?? saved.standards };
  }
  if (args.modules?.length && out.run) out = { ...out, run: { ...out.run, modules: args.modules } };
  return { args: out, saved };
}

/** Native paths: on the pilot PC that is win32, and tests on other systems write real files. */
/** The detail carries the run id ("run CW-...: ...") so a log row can be tied to the reply that made it. */
export function log(cfg: GuardConfig, dryRun: boolean, target: string, result: string, detail: string, action = "casework_pack", runId = "") {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, runId ? `run ${runId}: ${detail}` : detail]));
  } catch {
    // logging must never block the work
  }
}

/** The kit's master data folder (03_Master_Data, beside the family specs). */
export function masterDir(cfg: GuardConfig): string {
  return path.dirname(expandEnv(cfg.specs_path));
}

export function readCsv(file: string): string[][] | null {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow); } catch { return null; }
}

/** The room as Revit reads it (fmc_casework_room: read only, so it works on live models too; sent as a dry run, so through sendRaw). */
export async function readRoom(send: RevitSend, room: string): Promise<RoomRead> {
  return await send("fmc_casework_room", { room }, true, 120000) as RoomRead;
}

export function replyOf(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** The kit's casework standards sit with the master data: <kit>\03_Master_Data\FMC_Casework_Standards.json. */
export function kitStandardsFile(cfg: GuardConfig): string {
  return path.join(path.dirname(path.dirname(expandEnv(cfg.materials_file))), "03_Master_Data", "FMC_Casework_Standards.json");
}

export function readJson(file: string): unknown | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; }
}

const STANDARDS_REQUEST: KitRequest = {
  item: "Casework workshop standards",
  request: "Add 03_Master_Data\\FMC_Casework_Standards.json (sheet, kerf, boards, carcass sizes, construction allowances, drawer heights, hardware rules)",
  why: "The kit has no casework standards, so every call has to carry them",
};

export interface Prepared {
  standards: Standards;
  from: string;
  casework: Casework;
  lib: Map<string, LibMaterial> | null;
  libProblem: string;
  requests: KitRequest[];
  revision: StandardsRevision;
  /** unitsHash of the laid-out units */
  units_hash: string;
}

export function prepare(args: FmcCaseworkArgs, config: GuardConfig): { ok: Prepared } | { refused: object } {
  const kitFile = kitStandardsFile(config);
  const kit = readJson(kitFile);
  const merged = mergeStandards(kit, args.standards);
  const chk = checkStandards(merged);
  const requests: KitRequest[] = kit ? [] : [STANDARDS_REQUEST];
  if (!chk.standards)
    return { refused: { refused: true, reasons: ["The workshop standards are design inputs and some are missing; nothing is filled in (rules 5 and 7)", ...chk.problems],
      missing: chk.missing, kit_standards: kit ? kitFile : `none at ${kitFile}`, kit_requests: requests } };
  const s = chk.standards;
  let units: Unit[];
  let layout;
  if (args.run) {
    layout = layoutAny(args.run as Run, s);
    units = layout.units;
  } else if (args.units?.length) {
    units = args.units.map((u) => ({ ...u, layer: u.layer ?? (u.kind === "wall" || (u.kind === "gap" && u.fronts === "hood") ? "wall" : "base") })) as Unit[];
    layout = { units, fillers: [], worktop: [], problems: checkUnits(units), notes: ["A unit list has no walls, so the worktop isn't measured"] };
  } else {
    return { refused: { refused: true, reasons: ["Give a run (walls, openings, fixed items, modules) or a unit list"] } };
  }
  const kindMissing = missingForKinds(s, units.map((u) => u.kind));
  if (kindMissing.length)
    return { refused: { refused: true, reasons: ["Wardrobe and vanity sizes are design inputs and some are missing; nothing is filled in (rules 5 and 7)"],
      missing: kindMissing, kit_standards: kit ? kitFile : `none at ${kitFile}`, kit_requests: requests } };
  const libFile = expandEnv(config.materials_file);
  const lib = (() => { const j = readJson(libFile); return j ? readLibrary(j) : null; })();
  const from = kit ? (args.standards ? `${kitFile} with the call's values over it` : kitFile) : "the call (the kit has none)";
  const revision = standardsRevision({ kitFile, kitJson: kit, effective: merged, from, callOverrides: !!args.standards && Object.keys(args.standards).length > 0 });
  return { ok: { standards: s, from, revision, units_hash: unitsHash(units),
    casework: compute(units, layout, s), lib, libProblem: lib ? "" : `The kit's material library isn't readable at ${libFile}`, requests } };
}

export function costOf(p: Prepared) {
  const c = p.casework;
  const cost = costs({ boards: c.nests.map((n) => ({ material: n.material, sheets: n.sheets.length })), edge_m: c.edge_m, worktop_m: c.worktop_m, hardware: c.hardware }, p.standards, p.lib);
  return { ...cost, kit_requests: [...p.requests, ...cost.kit_requests] };
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A pack file's plan: new, unchanged or replaced (text or bytes). */
export function fileAction(target: string, content: string | Buffer): string {
  if (!fs.existsSync(target)) return "new";
  const old = fs.readFileSync(target);
  const now = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return old.equals(now) ? "unchanged" : "replace (the old one moves to _Archive)";
}

export function projectCode(args: FmcCaseworkArgs, reasons: string[]): string {
  const code = args.project_code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code) || code === "FMC") reasons.push("The project code is 2-6 letters or digits and not FMC (Manual 4.1)");
  return code;
}

/** The kit's family for placing, from the register; or the refusal with its kit change request. */
export function kitFamily(config: GuardConfig, family: string): { family: KitFamily } | { refused: object } {
  const file = path.join(masterDir(config), "FMC_Family_Register.csv");
  if (!/^FMC_I_Casework_[A-Za-z0-9]+$/.test(family))
    return { refused: { refused: true, reasons: [`${family} isn't a kit casework unit family (FMC_I_Casework_<Name>)`] } };
  const rows = readCsv(file);
  if (!rows) return { refused: { refused: true, reasons: [`The kit's family register isn't readable at ${file}`] } };
  const f = registerFamily(rows, family);
  if (!f) return { refused: { refused: true, reasons: [`${family} isn't in the kit's family register`],
    kit_requests: [{ item: family, request: `Add ${family} to 03_Master_Data\\FMC_Family_Register.csv`, why: "Casework is placed only as the kit's unit families" }] } };
  if (f.category !== "Casework") return { refused: { refused: true, reasons: [`${family} is ${f.category || "no category"} in the register, not Casework`] } };
  return { family: f };
}

/** Coordination checks for the layout against the room as Revit reads it (walls matched by where they run). */
export async function checksFor(ctx: Ctx, p: Prepared) {
  const { args, send } = ctx;
  const room = args.room.trim();
  // check → place: the room read by the run named in run_id is reused while it is young (fresh_room reads it again)
  const cached = args.fresh_room ? null : usableRoom(ctx.saved?.room_read, room);
  const read = cached ? cached.read : await readRoom(send, room);
  const at = cached ? cached.at : new Date().toISOString();
  ctx.entry.room_read = { room, at, read };
  const room_read = { from: cached ? `the saved run ${ctx.saved!.id} (no new Revit read)` : "Revit, now", at, age_s: Math.round((Date.now() - Date.parse(at)) / 1000) };
  const r = runFromRoom(read);
  const walls = args.run?.walls ?? [];
  const names = matchWalls(r.walls, walls as Parameters<typeof matchWalls>[1]);
  const sills = r.sills.flatMap((x) => (names.has(x.wall) ? [{ ...x, wall: names.get(x.wall)! }] : []));
  const unmatched = walls.filter((w) => ![...names.values()].includes(w.name)).map((w) => w.name);
  const flags = coordinationChecks(p.casework.layout.units, walls as Parameters<typeof coordinationChecks>[1], r.services, sills, p.standards);
  return { room: read.room, room_read, flags, services: r.services.length, notes: [...r.notes,
    ...(unmatched.length ? [`Wall(s) ${unmatched.join(", ")} don't run along the room's boundary, so their window sills aren't checked`] : [])] };
}

