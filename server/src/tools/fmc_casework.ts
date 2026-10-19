import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import {
  Casework, KitRequest, LibMaterial, Run, STANDARD_FIELDS, Standards, Unit, checkStandards, checkUnits, compute, costs, layoutRun,
  mergeStandards, packFiles, packLabel, packNames, readLibrary, summaryOf,
} from "../fmc/casework.js";
import {
  KitFamily, RoomRead, a3Frame, coordinationChecks, kitParams, matchWalls, placementPlan, registerFamily, registerSheet, registerSheetFor,
  runFromRoom, shopLayout,
} from "../fmc/casework_place.js";
import { workshopPackPdf } from "../fmc/casework_pdf.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { csvRow } from "./fmc_sheets.js";

/** Native paths: on the pilot PC that is win32, and tests on other systems write real files. */
function log(cfg: GuardConfig, dryRun: boolean, target: string, result: string, detail: string, action = "casework_pack") {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

/** The kit's master data folder (03_Master_Data, beside the family specs). */
function masterDir(cfg: GuardConfig): string {
  return path.dirname(expandEnv(cfg.specs_path));
}

function readCsv(file: string): string[][] | null {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow); } catch { return null; }
}

/** The room as Revit reads it (fmc_casework_room: read only, so it works on live models too). */
async function readRoom(room: string): Promise<RoomRead> {
  return await withRevitConnection((c) => c.sendRaw("fmc_casework_room", { room }, 120000)) as RoomRead;
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_CASEWORK_DESCRIPTION =
  "Formcraft Casework Assistant engine (Engineer › Casework, +Model). Pure computation, no Revit. From a run (walls with " +
    "lengths, window and door openings, a fixed sink and appliance gaps, the corner unit, a tall unit at one end, and the " +
    "unit widths to fill with) or a unit list: units (greedy fill), parts (panels per unit with board and edge banding), " +
    "nest (guillotine nesting per board on the standard sheet with the kerf), cutlist (rows per assembly mark), hardware, " +
    "summary (counts, sheets and yield, edge metres, worktop, cost from the kit's material library: missing prices show " +
    "\"price needed\", never a guess, and boards missing from the library come back as kit change requests). pack writes " +
    "the cut list, nesting, hardware and BoQ as CSV into <project>\\01_WIP\\_Casework (write roots only; dry run first, " +
    "then dry_run=false), and the workshop pack PDF beside them (summary, unit elevations, cut list per assembly mark, " +
    "nesting drawings per sheet, hardware, cost with its sources). In Revit (CW2): room reads a room's walls, doors, " +
    "windows and services points into a run's walls with their place in the model (read only); check flags the services " +
    "against the layout (waste and water at the sink, gas at the cooker, sockets behind tall units or over the cooker, " +
    "window sills) and never decides (rule 5); place puts the units in the model as the kit's FMC_I_Casework_* family " +
    "types with FMC_Assembly_Mark, FMC_Carcass_Spec and FMC_Worktop_Spec, in one Undo (the dry run is the real run rolled " +
    "back; the real run is behind the live-model lock); shop_drawings makes a front elevation per placed unit on the " +
    "register's A3 joinery sheets, places the I11_Joinery_Cutlist schedule and exports the sheets as PDF beside the pack. " +
    "Workshop standards (sizes, boards, construction and hardware rules) are design inputs: from the " +
    "kit's 03_Master_Data\\FMC_Casework_Standards.json when it exists, else from `standards`; nothing is defaulted. " +
    "Families, types, parameters and sheets come from the kit's register files; what the kit lacks is a kit change " +
    "request. It never decides gas, electrical or structural items.";

const OPENING = z.object({ kind: z.enum(["window", "door"]), offset: z.number(), width: z.number().positive() });
const FIXED = z.object({
  kind: z.enum(["sink", "cooker", "fridge", "dishwasher", "washer", "appliance"]),
  offset: z.number(), width: z.number().positive(),
  hood: z.boolean().optional().describe("cooker: a hood above (a gap in the wall units)"),
  tall: z.boolean().optional().describe("rises above the worktop (fridge is tall unless false)"),
  fronts: z.string().optional(),
});
const WALL = z.object({
  name: z.string(), length: z.number().positive(),
  corner: z.enum(["start", "end"]).optional().describe("this wall holds the corner unit at this end"),
  after_corner: z.enum(["start", "end"]).optional().describe("the next wall's corner unit returns along this end"),
  openings: z.array(OPENING).optional(),
  fixed: z.array(FIXED).optional(),
  tall: z.object({ at: z.enum(["start", "end"]), width: z.number().positive(), fronts: z.string().optional() }).optional(),
  start: z.array(z.number()).length(2).optional().describe("place: where the wall's room-side face starts in the model, mm (room gives it)"),
  end: z.array(z.number()).length(2).optional().describe("place: where it ends; the units stand on the left of start → end"),
  side: z.enum(["left", "right"]).optional().describe("place: the room's side of start → end, when it isn't the left"),
  wall_id: z.number().optional(),
});
const RUN = z.object({
  walls: z.array(WALL).min(1),
  modules: z.array(z.number().positive()).min(1).describe("unit widths the fill may use, mm"),
  wall_modules: z.array(z.number().positive()).optional(),
  corner_width: z.number().positive().optional(),
  fronts: z.record(z.string(), z.string()).optional().describe("by mark: door, 2door, <n>drawer, none"),
  drawer_heights: z.record(z.string(), z.array(z.number().positive())).optional(),
  mark_prefix: z.object({ base: z.string().optional(), wall: z.string().optional() }).optional(),
});
const UNIT = z.object({
  mark: z.string(), kind: z.enum(["corner", "base", "sink", "tall", "wall", "gap"]), width: z.number().positive(),
  wall: z.string().optional().default(""), offset: z.number().optional().default(0), fronts: z.string().optional().default(""),
  layer: z.enum(["base", "wall"]).optional(), drawer_heights: z.array(z.number().positive()).optional(),
});

export const FMC_CASEWORK_SHAPE = {
  action: z.enum(["units", "parts", "nest", "cutlist", "hardware", "summary", "pack", "room", "check", "place", "shop_drawings"]),
  run: RUN.optional().describe("The run to lay out (or give units)"),
  units: z.array(UNIT).optional().describe("A unit list instead of a run (the unit editor's)"),
  standards: z.record(z.string(), z.unknown()).optional()
    .describe(`Workshop standards over the kit's (mm and counts): ${STANDARD_FIELDS.join(", ")}; optional edge_band, worktop (kit material names)`),
  board: z.string().optional().default("").describe("nest: only this board material"),
  sheet: z.number().int().positive().optional().describe("nest: only this sheet number"),
  project_folder: z.string().optional().default("").describe("pack: the project folder (the files go to 01_WIP\\_Casework)"),
  project_code: z.string().optional().default("").describe("pack: the project code (Manual 4.1)"),
  label: z.string().optional().default("").describe("pack, place, shop_drawings: what this is, e.g. K-01 Kitchen; the file names come from it, and a re-run replaces what the same label placed"),
  room: z.string().optional().default("").describe("room, check (and place's dry run): the room's number or name in the active model"),
  level: z.string().optional().default("").describe("place: the level the units stand on"),
  family: z.string().optional().default("FMC_I_Casework_KitchenUnit").describe("place: the kit's unit family (FMC_I_Casework_*, from FMC_Family_Register.csv)"),
  type_for: z.record(z.string(), z.string()).optional().describe("place: your choice of register type for a unit kind the family has no type for, e.g. {\"sink\": \"Base\"}"),
  wall_unit_bottom: z.number().positive().optional().describe("place: underside of the wall units above the level, mm (a design input)"),
  sheets: z.array(z.string()).optional().default([]).describe("shop_drawings: the register's joinery sheets to use, e.g. [\"I-4001\"]"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcCaseworkArgs = z.infer<z.ZodObject<typeof FMC_CASEWORK_SHAPE>>;

/** The kit's casework standards sit with the master data: <kit>\03_Master_Data\FMC_Casework_Standards.json. */
export function kitStandardsFile(cfg: GuardConfig): string {
  return path.join(path.dirname(path.dirname(expandEnv(cfg.materials_file))), "03_Master_Data", "FMC_Casework_Standards.json");
}

function readJson(file: string): unknown | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; }
}

const STANDARDS_REQUEST: KitRequest = {
  item: "Casework workshop standards",
  request: "Add 03_Master_Data\\FMC_Casework_Standards.json (sheet, kerf, boards, carcass sizes, construction allowances, drawer heights, hardware rules)",
  why: "The kit has no casework standards, so every call has to carry them",
};

interface Prepared {
  standards: Standards;
  from: string;
  casework: Casework;
  lib: Map<string, LibMaterial> | null;
  libProblem: string;
  requests: KitRequest[];
}

function prepare(args: FmcCaseworkArgs, config: GuardConfig): { ok: Prepared } | { refused: object } {
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
    layout = layoutRun(args.run as Run, s);
    units = layout.units;
  } else if (args.units?.length) {
    units = args.units.map((u) => ({ ...u, layer: u.layer ?? (u.kind === "wall" || (u.kind === "gap" && u.fronts === "hood") ? "wall" : "base") })) as Unit[];
    layout = { units, fillers: [], worktop: [], problems: checkUnits(units), notes: ["A unit list has no walls, so the worktop isn't measured"] };
  } else {
    return { refused: { refused: true, reasons: ["Give a run (walls, openings, fixed items, modules) or a unit list"] } };
  }
  const libFile = expandEnv(config.materials_file);
  const lib = (() => { const j = readJson(libFile); return j ? readLibrary(j) : null; })();
  return { ok: { standards: s, from: kit ? (args.standards ? `${kitFile} with the call's values over it` : kitFile) : "the call (the kit has none)",
    casework: compute(units, layout, s), lib, libProblem: lib ? "" : `The kit's material library isn't readable at ${libFile}`, requests } };
}

function costOf(p: Prepared) {
  const c = p.casework;
  const cost = costs({ boards: c.nests.map((n) => ({ material: n.material, sheets: n.sheets.length })), edge_m: c.edge_m, worktop_m: c.worktop_m, hardware: c.hardware }, p.standards, p.lib);
  return { ...cost, kit_requests: [...p.requests, ...cost.kit_requests] };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A pack file's plan: new, unchanged or replaced (text or bytes). */
function fileAction(target: string, content: string | Buffer): string {
  if (!fs.existsSync(target)) return "new";
  const old = fs.readFileSync(target);
  const now = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return old.equals(now) ? "unchanged" : "replace (the old one moves to _Archive)";
}

function projectCode(args: FmcCaseworkArgs, reasons: string[]): string {
  const code = args.project_code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code) || code === "FMC") reasons.push("The project code is 2-6 letters or digits and not FMC (Manual 4.1)");
  return code;
}

/** The kit's family for placing, from the register; or the refusal with its kit change request. */
function kitFamily(config: GuardConfig, family: string): { family: KitFamily } | { refused: object } {
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
async function checksFor(args: FmcCaseworkArgs, p: Prepared) {
  const read = await readRoom(args.room.trim());
  const r = runFromRoom(read);
  const walls = args.run?.walls ?? [];
  const names = matchWalls(r.walls, walls as Parameters<typeof matchWalls>[1]);
  const sills = r.sills.flatMap((x) => (names.has(x.wall) ? [{ ...x, wall: names.get(x.wall)! }] : []));
  const unmatched = walls.filter((w) => ![...names.values()].includes(w.name)).map((w) => w.name);
  const flags = coordinationChecks(p.casework.layout.units, walls as Parameters<typeof coordinationChecks>[1], r.services, sills, p.standards);
  return { room: read.room, flags, services: r.services.length, notes: [...r.notes,
    ...(unmatched.length ? [`Wall(s) ${unmatched.join(", ")} don't run along the room's boundary, so their window sills aren't checked`] : [])] };
}

export async function runFmcCasework(args: FmcCaseworkArgs) {
  const { config, problem } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    // room reading needs no standards: it gives the run's walls, which the person completes
    if (args.action === "room") {
      if (!args.room.trim()) return reply({ refused: true, reasons: ["Name the room (its number or name in the active model)"] }, true);
      const read = await readRoom(args.room.trim());
      const r = runFromRoom(read);
      const count = (k: string) => r.services.filter((s) => s.kind === k).length;
      return reply({ room: read.room, run: { walls: r.walls }, services: { water: count("water"), waste: count("waste"), gas: count("gas"), sockets: count("socket"), other: count("other") },
        window_sills: r.sills, notes: r.notes,
        next: "Add the unit widths (modules), the corner, the sink and the appliances to these walls, then lay out (units, summary) and check against the room" });
    }

    const prep = prepare(args, config);
    if ("refused" in prep) return reply(prep.refused, true);
    const p = prep.ok;
    const c = p.casework;
    const head = { standards_from: p.from, problems: c.problems, notes: c.layout.notes };

    switch (args.action) {
      case "units":
        return reply({ ...head, units: c.layout.units, fillers: c.layout.fillers, worktop: c.layout.worktop, worktop_m: c.worktop_m });
      case "parts":
        return reply({ ...head, part_lines: c.parts.length, pieces: c.parts.reduce((a, x) => a + x.qty, 0), parts: c.parts });
      case "nest": {
        const nests = c.nests.filter((n) => !args.board || n.material === args.board)
          .map((n) => ({ ...n, sheets: n.sheets.filter((s) => !args.sheet || s.index === args.sheet) }));
        if (args.board && !nests.length) return reply({ refused: true, reasons: [`No parts on ${args.board}; boards: ${c.nests.map((n) => n.material).join(", ")}`] }, true);
        return reply({ ...head, sheet: p.standards.sheet, kerf: p.standards.kerf, boards: nests });
      }
      case "cutlist":
        return reply({ ...head, rows: c.cutlist, edge_m: c.edge_m });
      case "hardware":
        return reply({ ...head, hardware: c.hardware });
      case "summary": {
        const cost = costOf(p);
        return reply({ ...head, ...summaryOf(c), cost: { lines: cost.lines, total: cost.total }, kit_requests: cost.kit_requests,
          ...(p.libProblem ? { library: p.libProblem } : {}) });
      }
      case "check": {
        if (!args.room.trim()) return reply({ refused: true, reasons: ["Name the room to check against (its number or name)"] }, true);
        if (!args.run) return reply({ refused: true, reasons: ["Checks need a run whose walls have their place in the model (start, end): read the room first"] }, true);
        const ch = await checksFor(args, p);
        return reply({ ...head, ...ch, flagged: ch.flags.filter((f) => f.state === "flag").length,
          next: "Each flag is for a person to decide; the tool moves no service and no unit (rule 5)" });
      }
      case "place": {
        const reasons: string[] = [];
        if (problem && !dry) reasons.push(problem);
        if (!packLabel(args.label)) reasons.push("Name what this is (label), e.g. K-01 Kitchen: a re-run replaces what the same label placed");
        if (!args.level.trim()) reasons.push("Name the level the units stand on");
        if (c.problems.length) reasons.push("Fix the problems first; nothing is placed from a run that doesn't fit");
        if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
        const fam = kitFamily(config, args.family.trim());
        if ("refused" in fam) return reply(fam.refused, true);
        const mdFile = path.join(masterDir(config), "FMC_Master_Data.json");
        const md = readJson(mdFile);
        if (!md) return reply({ refused: true, reasons: [`The kit's master data isn't readable at ${mdFile}`] }, true);
        const kp = kitParams(md);
        const plan = placementPlan(c.layout.units, (args.run?.walls ?? []) as Parameters<typeof placementPlan>[1], p.standards,
          { family: fam.family, type_for: args.type_for, wall_unit_bottom: args.wall_unit_bottom, params: kp.found, lib: p.lib });
        const kit_requests = [...p.requests, ...kp.requests, ...plan.kit_requests];
        if (plan.problems.length || !plan.ops.length)
          return reply({ refused: true, reasons: plan.problems.length ? plan.problems : ["Nothing to place: every unit was skipped"], skipped: plan.skipped, kit_requests }, true);
        const widthParam = fam.family.key_parameters.includes("Width") ? "Width" : "";
        const tag = `FMC:casework:${packLabel(args.label)}`;
        const payload = { dry_run: dry, level: args.level.trim(), family: plan.family, tag, width_param: widthParam,
          ops: plan.ops.map((o) => ({ mark: o.mark, type: o.type, width: o.width, at: o.at, facing: o.facing, params: o.params })), type_params: plan.type_params };
        const checks = dry && args.room.trim() ? await checksFor(args, p) : null;
        // the dry run places and rolls back, so it changes nothing and needs no lock; the real run goes through the lock
        const result = await withRevitConnection((cl) => dry ? cl.sendRaw("fmc_casework_place", payload, 300000) : cl.sendCommand("fmc_casework_place", payload, 300000));
        log(config, dry, args.level, dry ? "dry run" : "done", `${plan.ops.length} units of ${plan.family} (${tag})`, "casework_place");
        return reply({ dry_run: dry, family: plan.family, will_place: plan.ops.map((o) => `${o.mark} ${o.type} ${o.width}`), type_params: plan.type_params,
          skipped: plan.skipped, notes: [...plan.notes, ...(widthParam ? [] : [`${plan.family} has no Width key parameter in the register, so the width isn't set`])],
          kit_requests, ...(checks ? { checks } : {}), result,
          next: dry ? "Show this to the person; run again with dry_run=false once they say yes (one Undo takes it all out)" : "Check the units in the model; then shop_drawings (dry run first)" });
      }
      case "shop_drawings": {
        const reasons: string[] = [];
        if (problem) reasons.push(problem);
        const code = projectCode(args, reasons);
        if (!packLabel(args.label)) reasons.push("Name what this is (label), e.g. K-01 Kitchen");
        if (!args.sheets.length) reasons.push("Name the register's joinery sheet(s) for the drawings, e.g. [\"I-4001\"]");
        if (c.problems.length) reasons.push("Fix the problems first");
        if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
        const regFile = path.join(masterDir(config), "FMC_Sheet_Register.csv");
        const reg = readCsv(regFile);
        if (!reg) return reply({ refused: true, reasons: [`The kit's sheet register isn't readable at ${regFile}`] }, true);
        const rows = args.sheets.map((n) => ({ n, row: registerSheet(reg, n.trim()) }));
        const unknown = rows.filter((r) => !r.row || !r.row.scale).map((r) => r.n);
        if (unknown.length) return reply({ refused: true, reasons: [`Not in the sheet register with a scale: ${unknown.join(", ")}`] }, true);
        const scales = [...new Set(rows.map((r) => r.row!.scale))];
        if (scales.length > 1) return reply({ refused: true, reasons: [`The sheets have different scales (${scales.map((s) => `1:${s}`).join(", ")}); give sheets of one scale`] }, true);
        const rbFile = path.join(expandEnv(config.rulebooks_dir), "FMC_Rulebook_Sheets.json");
        const { frame, problem: frameProblem } = a3Frame(readJson(rbFile));
        if (!frame) return reply({ refused: true, reasons: [`${frameProblem} (${rbFile})`],
          kit_requests: [{ item: "A3 sheet frame", request: "Give FMC_Rulebook_Sheets.json the A3 title block, margins, drawing area and A3 scale", why: "Shop drawings go on the kit's A3 sheets" }] }, true);
        const margin = 150; // mm of model around each unit: room for its sizes and mark
        const layout = shopLayout(c.layout.units, p.standards, scales[0], frame, rows.map((r) => r.row!.number), margin);
        if (layout.overflow.length) return reply({ refused: true, reasons: [`These don't fit on the sheets given: ${layout.overflow.join(", ")}; add another register sheet`] }, true);
        const cut = registerSheetFor(reg, "I11_Joinery_Cutlist");
        const names = packNames(code, args.label);
        const folder = args.project_folder.trim() ? path.join(args.project_folder.trim(), "01_WIP", "_Casework") : "";
        let exportTo: { folder: string; file: string } | null = null;
        let action = "";
        if (folder) {
          for (const target of [path.join(folder, names.shop), path.join(folder, "_Archive", "x.pdf")]) {
            const v = checkWritePath(target, config, { checkName: false });
            if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
          }
          exportTo = { folder, file: names.shop.replace(/\.pdf$/i, "") };
          action = fs.existsSync(path.join(folder, names.shop)) ? "replace (the old one moves to _Archive)" : "new";
        }
        const payload = {
          dry_run: dry, view_prefix: `CW ${packLabel(args.label)} `, scale: scales[0], margin_mm: margin, title_block: frame.title_block,
          views: layout.views.map((v) => ({ mark: v.mark, sheet: v.sheet, centre: v.centre })),
          sheets: rows.map((r) => ({ number: r.row!.number, name: r.row!.name, view_template: r.row!.placed })),
          // the schedule's top-left corner just inside the drawing area's top-left
          schedule: cut ? { name: "I11_Joinery_Cutlist", sheet: cut.number, sheet_name: cut.name, at: [frame.origin[0] + 5, frame.origin[1] + frame.area[1] - 5] } : null,
          export: dry ? null : exportTo,
        };
        if (!dry && exportTo && action !== "new") {
          const archive = path.join(folder, "_Archive");
          fs.mkdirSync(archive, { recursive: true });
          fs.renameSync(path.join(folder, names.shop), path.join(archive, `${stamp()}_${names.shop}`));
        }
        if (!dry && exportTo) fs.mkdirSync(folder, { recursive: true });
        const result = await withRevitConnection((cl) => dry ? cl.sendRaw("fmc_casework_pack", payload, 600000) : cl.sendCommand("fmc_casework_pack", payload, 600000));
        log(config, dry, folder || rows.map((r) => r.n).join(", "), dry ? "dry run" : "done", `${layout.views.length} elevations on ${rows.length} sheet(s)`, "casework_shop");
        return reply({ dry_run: dry, scale: `1:${scales[0]}`, title_block: `${frame.title_block.family} : ${frame.title_block.type}`,
          sheets: rows.map((r) => ({ number: r.row!.number, name: r.row!.name, views: layout.views.filter((v) => v.sheet === r.row!.number).map((v) => v.mark) })),
          schedule: cut ? `I11_Joinery_Cutlist on ${cut.number}` : "The sheet register names no sheet for I11_Joinery_Cutlist",
          pdf: exportTo ? { folder, file: names.shop, action } : "No project folder, so the sheets aren't exported as PDF",
          result, next: dry ? "Show this to the person; run again with dry_run=false once they say yes" : "Make the workshop pack (pack): its PDF names these sheets" });
      }
      case "pack": {
        const reasons: string[] = [];
        if (problem) reasons.push(problem);
        const code = projectCode(args, reasons);
        if (!packLabel(args.label)) reasons.push("Name what this pack is (label), e.g. K-01 Kitchen");
        if (!args.project_folder.trim()) reasons.push("The pack goes into the project's 01_WIP\\_Casework: set the project folder");
        if (c.problems.length) reasons.push("Fix the problems first; a pack is never made from a run that doesn't fit");
        if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
        const folder = path.join(args.project_folder.trim(), "01_WIP", "_Casework");
        const archive = path.join(folder, "_Archive");
        const cost = costOf(p);
        const names = packNames(code, args.label);
        const files: Array<{ name: string; content: string | Buffer; rows: number }> = packFiles(c, cost, csvLine, code, args.label);
        const shop = fs.existsSync(path.join(folder, names.shop)) ? names.shop : undefined;
        const pdf = workshopPackPdf({ code, label: args.label.trim(), casework: c, cost, standards: p.standards, standards_from: p.from, shop_drawings: shop });
        files.push({ name: names.pdf, content: pdf, rows: (pdf.toString("latin1").match(/\/Type \/Page /g) ?? []).length });
        for (const target of [...files.map((f) => path.join(folder, f.name)), path.join(archive, "x.csv")]) {
          const v = checkWritePath(target, config, { checkName: false });
          if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
        }
        const plan = files.map((f) => ({ file: f.name, ...(f.name.endsWith(".pdf") ? { pages: f.rows } : { rows: f.rows }), action: fileAction(path.join(folder, f.name), f.content) }));
        const summary = { folder, files: plan, ...summaryOf(c), cost_total: cost.total, kit_requests: cost.kit_requests,
          shop_drawings: shop ?? "not made yet (shop_drawings, in Revit)" };
        if (dry) {
          log(config, true, folder, "dry run", `${plan.length} files`);
          return reply({ dry_run: true, ...summary, next: "Run again with dry_run=false to write these files" });
        }
        fs.mkdirSync(folder, { recursive: true });
        const st = stamp();
        for (const f of files) {
          const target = path.join(folder, f.name);
          const step = plan.find((x) => x.file === f.name)!;
          if (step.action === "unchanged") continue;
          if (step.action !== "new") {
            fs.mkdirSync(archive, { recursive: true });
            fs.renameSync(target, path.join(archive, `${st}_${f.name}`));
          }
          fs.writeFileSync(target, f.content);
        }
        const written = plan.filter((x) => x.action !== "unchanged").length;
        log(config, false, folder, "done", `${written} written, ${plan.length - written} unchanged`);
        return reply({ done: true, ...summary });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.action === "pack") log(config, dry, args.project_folder, "error", msg);
    else if (args.action === "place" || args.action === "shop_drawings") log(config, dry, args.level || args.project_folder, "error", msg, `casework_${args.action}`);
    return reply({ error: msg }, true);
  }
}

export function registerFmcCaseworkTool(server: McpServer) {
  server.tool("fmc_casework", FMC_CASEWORK_DESCRIPTION, FMC_CASEWORK_SHAPE, (args) => runFmcCasework(args));
}
