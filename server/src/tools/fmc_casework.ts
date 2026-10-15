import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import {
  Casework, KitRequest, LibMaterial, Run, STANDARD_FIELDS, Standards, Unit, checkStandards, checkUnits, compute, costs, layoutRun,
  mergeStandards, packFiles, packLabel, readLibrary, summaryOf,
} from "../fmc/casework.js";

/** Native paths: on the pilot PC that is win32, and tests on other systems write real files. */
function log(cfg: GuardConfig, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), "casework_pack", dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
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
    "then dry_run=false). Workshop standards (sizes, boards, construction and hardware rules) are design inputs: from the " +
    "kit's 03_Master_Data\\FMC_Casework_Standards.json when it exists, else from `standards`; nothing is defaulted. It " +
    "never decides gas, electrical or structural items.";

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
  action: z.enum(["units", "parts", "nest", "cutlist", "hardware", "summary", "pack"]),
  run: RUN.optional().describe("The run to lay out (or give units)"),
  units: z.array(UNIT).optional().describe("A unit list instead of a run (the unit editor's)"),
  standards: z.record(z.string(), z.unknown()).optional()
    .describe(`Workshop standards over the kit's (mm and counts): ${STANDARD_FIELDS.join(", ")}; optional edge_band, worktop (kit material names)`),
  board: z.string().optional().default("").describe("nest: only this board material"),
  sheet: z.number().int().positive().optional().describe("nest: only this sheet number"),
  project_folder: z.string().optional().default("").describe("pack: the project folder (the files go to 01_WIP\\_Casework)"),
  project_code: z.string().optional().default("").describe("pack: the project code (Manual 4.1)"),
  label: z.string().optional().default("").describe("pack: what this is, e.g. K-01 Kitchen; the file names come from it"),
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

export async function runFmcCasework(args: FmcCaseworkArgs) {
  const { config, problem } = loadConfig();
  const dry = args.dry_run !== false;
  try {
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
      case "pack": {
        const reasons: string[] = [];
        if (problem) reasons.push(problem);
        const code = args.project_code.trim().toUpperCase();
        if (!/^[A-Z0-9]{2,6}$/.test(code) || code === "FMC") reasons.push("The project code is 2-6 letters or digits and not FMC (Manual 4.1)");
        if (!packLabel(args.label)) reasons.push("Name what this pack is (label), e.g. K-01 Kitchen");
        if (!args.project_folder.trim()) reasons.push("The pack goes into the project's 01_WIP\\_Casework: set the project folder");
        if (c.problems.length) reasons.push("Fix the problems first; a pack is never made from a run that doesn't fit");
        if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
        const folder = path.join(args.project_folder.trim(), "01_WIP", "_Casework");
        const archive = path.join(folder, "_Archive");
        const cost = costOf(p);
        const files = packFiles(c, cost, csvLine, code, args.label);
        for (const target of [...files.map((f) => path.join(folder, f.name)), path.join(archive, "x.csv")]) {
          const v = checkWritePath(target, config, { checkName: false });
          if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
        }
        const plan = files.map((f) => {
          const target = path.join(folder, f.name);
          const old = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
          const action = old === null ? "new" : old === f.content ? "unchanged" : "replace (the old one moves to _Archive)";
          return { file: f.name, rows: f.rows, action };
        });
        const summary = { folder, files: plan, ...summaryOf(c), cost_total: cost.total, kit_requests: cost.kit_requests };
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
    return reply({ error: msg }, true);
  }
}

export function registerFmcCaseworkTool(server: McpServer) {
  server.tool("fmc_casework", FMC_CASEWORK_DESCRIPTION, FMC_CASEWORK_SHAPE, (args) => runFmcCasework(args));
}
