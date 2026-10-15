import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseKeynotes } from "../fmc/library.js";
import {
  CeilingInput, Csv, Evaluated, KINDS, Kind, STYLES, boq, boqCsv, checksCsv, designs, evaluate, inputProblems, setoutCsv, standardFor, tally,
} from "../fmc/ceiling/engine.js";
import { CeilingKit, emptyKit, parseLibrary } from "../fmc/ceiling/standard.js";
import { packPlan } from "../fmc/ceiling/pack.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

const XY = { x: z.number(), y: z.number() };
const POINT = z.object(XY);

export const FMC_CEILING_DESCRIPTION =
  "Formcraft Ceiling Design Assistant engine (Engineer › Ceilings, step CL1): pure computation from a room and a brief; " +
    "it never reads or changes a model. designs: up to three options (tray with bulkhead and cove, flat with a floating " +
    "raft, coffered; the brief's first) with heights, board area and sheets, an indicative light level and the checks. " +
    "checks (one design): clearance to the ties or slab, hangers on the ties, AC supply in the drop, fan centre, sweep " +
    "and blade height, detector placement, access to drivers, board joints and slivers, sprinklers, headroom; the light " +
    "level is always 'Engineer' (CA-E-03: the electrical engineer designs lighting). setout: numbered boards per ceiling " +
    "zone with no slivers and staggered end joints, main channel and furring lines, hanger points, vertical faces. " +
    "quantities and boq: boards, channels, hangers, screws, tape, cornice, cove LED, downlights, hatch, paint; keynotes " +
    "from the kit and prices from the kit's material library (07_Materials\\FMC_Materials.json); a missing price shows " +
    "'price needed', never a guess. pack writes the set-out, BoQ and checks CSVs into <project>\\01_WIP\\_Ceilings\\<date>_" +
    "<room>_<design>: a dry run unless dry_run is false, and dry_run=false needs confirm=true after a person said yes. " +
    "Coordinates in mm from the room's corner, x along the width, y along the depth. Values the kit doesn't hold yet " +
    "are listed as kit change requests.";

export const FMC_CEILING_SHAPE = {
  action: z.enum(["designs", "checks", "setout", "quantities", "boq", "pack"]),
  room: z.object({
    name: z.string().optional().default("Room"),
    // not z.tuple: the Claude API rejects tuple schemas ("items" as an array) and drops the tool (schemas.test.ts)
    outline_mm: z.array(z.array(z.number()).length(2)).optional()
      .describe("Corners of an orthogonal outline in mm, in order. Or give width_mm and depth_mm for a rectangle"),
    width_mm: z.number().optional(),
    depth_mm: z.number().optional(),
    structure_height_mm: z.number().describe("Underside of the truss ties or slab above, from the floor"),
    structure: z.enum(["ties", "slab"]).optional().default("ties"),
    tie_spacing_mm: z.number().optional().describe("Tie centres, to check the hangers land on them"),
    tie_direction: z.enum(["x", "y"]).optional().default("y").describe("The direction the ties run in plan"),
    tie_offset_mm: z.number().optional().default(0).describe("Where the first tie's centre line is"),
  }),
  fixtures: z.object({
    fan: z.object({ ...XY, sweep_mm: z.number().optional().default(1200), drop_mm: z.number().optional().default(350)
      .describe("Ceiling to blades") }).optional(),
    downlights: z.array(POINT).optional().default([]),
    detectors: z.array(z.object({ ...XY, kind: z.string().optional().default("smoke") })).optional().default([]),
    ac_grilles: z.array(z.object({ ...XY, width_mm: z.number().optional().default(600), depth_mm: z.number().optional().default(160),
      duct_height_mm: z.number().optional().default(150) })).optional().default([]),
    hatch: z.object({ ...XY, size_mm: z.number().optional().default(600) }).optional(),
    sprinklers: z.array(POINT).optional().default([]),
  }).optional().default({}),
  brief: z.object({
    styles: z.array(z.enum(STYLES)).optional().default([]).describe("flat, tray, bulkhead, cove, raft, coffer, cornice"),
    board: z.string().optional().default("I.CLG_02").describe("The ceiling build-up: a kit keynote in I.CLG"),
    field_height_mm: z.number().optional().describe("The main (highest) ceiling. Empty: the structure less the kit's void"),
    bulkhead_width_mm: z.number().optional().default(600),
    bulkhead_drop_mm: z.number().optional().default(300),
    raft_drop_mm: z.number().optional().default(150),
    raft: z.object({ ...XY, width_mm: z.number(), depth_mm: z.number() }).optional().describe("Raft centre and size. Empty: centred, half the room"),
    coffer_drop_mm: z.number().optional().default(200),
    coffer_margin_mm: z.number().optional().default(450),
    coffer_beam_mm: z.number().optional().default(250),
    coffer_grid: z.object({ nx: z.number().int().min(1), ny: z.number().int().min(1) }).optional(),
    paint_material: z.string().optional().describe("A material name from the library for the emulsion"),
  }).optional().default({}),
  design: z.enum(KINDS).optional().describe("checks, setout, quantities, boq, pack: which design. Empty: the recommended one"),
  project_folder: z.string().optional().default("").describe("pack: the project folder (the pack goes into its 01_WIP)"),
  kit_folder: z.string().optional().default("").describe("The kit folder. Empty: the files named in fmc_guard.json"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("pack with dry_run=false: true only once a person said yes to the dry run"),
};

export type FmcCeilingArgs = z.infer<z.ZodObject<typeof FMC_CEILING_SHAPE>>;

/** The kit files the engine reads: material library, keynotes, master data (waste) and the proposed ceiling standard. */
export function loadCeilingKit(kitFolder: string, cfg: GuardConfig, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): CeilingKit {
  const k = kitFolder.trim();
  const master = k ? win.join(k, "03_Master_Data") : win.dirname(expandEnv(cfg.specs_path));
  const files = {
    materials: k ? win.join(k, "07_Materials", "FMC_Materials.json") : expandEnv(cfg.materials_file),
    keynotes: k ? win.join(k, "02_Keynotes", "FMC_Keynotes.txt") : expandEnv(cfg.keynote_file),
    master: win.join(master, "FMC_Master_Data.json"),
    standard: win.join(master, "FMC_Ceiling_Standard.json"),
  };
  const kit = emptyKit();
  const json = (p: string) => JSON.parse(read(p).replace(/^﻿/, ""));
  try { kit.materials = parseLibrary(json(files.materials)); } catch { kit.problems.push(`Material library not readable at ${files.materials}: every price shows "price needed"`); }
  try { kit.keynotes = parseKeynotes(read(files.keynotes)); } catch { kit.problems.push(`Keynote file not readable at ${files.keynotes}`); }
  try { kit.codes = json(files.master)?.codes ?? {}; } catch { kit.problems.push(`Master data not readable at ${files.master}`); }
  try { kit.standard = json(files.standard); } catch { kit.standard = null; } // proposed file: its absence is a kit change request
  return kit;
}

const dateOf = () => new Date().toISOString().slice(0, 10);
const csvText = (rows: Csv) => rows.map((r) => csvLine(r)).join("");

export async function runFmcCeiling(args: FmcCeilingArgs, kitOverride?: CeilingKit) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    const input = { room: args.room, fixtures: args.fixtures, brief: args.brief } as CeilingInput;
    const problems = inputProblems(input);
    if (problems.length) return reply({ refused: true, reasons: problems }, true);
    if (args.action === "pack" && !dry && args.confirm !== true)
      return reply({ refused: true, reasons: ["dry_run=false writes the pack: run the dry run, show it, and send confirm=true once the person says yes"] }, true);
    const kit = kitOverride ?? loadCeilingKit(args.kit_folder, config);
    const resolved = standardFor(input, kit);
    const std = resolved.std;
    const kcr = [...resolved.kit_change_requests];
    const base = { room: input.room.name, kit_problems: kit.problems };

    if (args.action === "designs") {
      const out = designs(input, std);
      log(config, "ceiling_designs", true, input.room.name, "ok", out.options.map((o) => `${o.id} ${o.kind}`).join("; "));
      return reply({ ...base, ...out, kit_change_requests: kcr,
        next: "checks, setout, quantities or boq with design=<kind>; pack writes the CSVs into the project's 01_WIP (a dry run first)" });
    }

    let kind: Kind | undefined = args.design;
    if (!kind) {
      const d = designs(input, std);
      kind = (d.options.find((o) => o.recommended) ?? d.options[0])?.kind;
      if (!kind) return reply({ refused: true, reasons: d.skipped.map((s) => `${s.kind}: ${s.why}`) }, true);
    }
    const ev = evaluate(kind, input, std, kind);
    if ("skipped" in ev) return reply({ refused: true, reasons: [`${ev.kind}: ${ev.skipped}`] }, true);
    const e = ev as Evaluated;
    const head = { ...base, design: { kind: e.design.kind, label: e.design.label, heights_mm: [...new Set(e.design.zones.map((x) => x.height))] } };
    log(config, `ceiling_${args.action}`, args.action === "pack" ? dry : true, input.room.name, args.action === "pack" && !dry ? "writing" : "ok", e.design.label);

    if (args.action === "checks") return reply({ ...head, checks: e.checks, tally: tally(e.checks), kit_change_requests: kcr,
      next: "The checks flag; the person decides. Placing in Revit is step CL2 (behind the live-model lock)" });
    if (args.action === "quantities") return reply({ ...head, quantities: e.q, light_lx_indicative: e.lux, kit_change_requests: kcr });
    if (args.action === "setout") {
      const so = e.setout;
      return reply({ ...head, setout: { ...so, zones: so.zones.map((zz) => ({ ...zz, boards: zz.boards.map(({ pieces, ...b }) => (pieces.length ? { ...b, pieces } : b)) })) },
        totals: { boards: so.zones.reduce((s, zz) => s + zz.boards.length, 0), slivers: so.zones.reduce((s, zz) => s + zz.slivers.length, 0), hangers: so.hangers.length },
        kit_change_requests: kcr });
    }
    const bill = boq(e, input, std, kit);
    kcr.push(...bill.kit_change_requests);
    if (args.action === "boq") return reply({ ...head, lines: bill.lines, priced_total_ugx: bill.priced_total_ugx, lines_price_needed: bill.price_needed,
      note: "Prices come only from the kit's material library, with their date, source and status; a missing price is a kit change request, never a guess",
      kit_change_requests: kcr });

    // pack
    const plan = packPlan(args.project_folder, input.room.name, kind, config, dateOf(), (p) => fs.existsSync(p));
    const csvs = { setout: setoutCsv(e.setout), boq: boqCsv(bill.lines), checks: checksCsv(e.checks) };
    const summary = { folder: plan.folder, files: plan.files, rows: { setout: csvs.setout.length - 1, boq: csvs.boq.length - 1, checks: csvs.checks.length - 1 } };
    if (!plan.ok) return reply({ ...head, refused: true, reasons: plan.reasons, ...summary }, true);
    if (dry) return reply({ ...head, dry_run: true, ...summary, kit_change_requests: kcr,
      next: "Show this to the person; run again with dry_run=false and confirm=true once they say yes" });
    fs.mkdirSync(plan.folder, { recursive: true });
    fs.writeFileSync(plan.files.setout, csvText(csvs.setout));
    fs.writeFileSync(plan.files.boq, csvText(csvs.boq));
    fs.writeFileSync(plan.files.checks, csvText(csvs.checks));
    log(config, "ceiling_pack", false, plan.folder, "done", `${e.design.label}: 3 CSVs`);
    return reply({ ...head, done: true, ...summary, kit_change_requests: kcr });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, `ceiling_${args.action}`, dry, args.room?.name ?? "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcCeilingTool(server: McpServer) {
  server.tool("fmc_ceiling", FMC_CEILING_DESCRIPTION, FMC_CEILING_SHAPE, (args) => runFmcCeiling(args));
}
