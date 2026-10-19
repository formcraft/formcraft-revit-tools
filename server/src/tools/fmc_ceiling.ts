import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseKeynotes } from "../fmc/library.js";
import {
  CeilingInput, Csv, Evaluated, KINDS, Kind, STYLES, boq, boqCsv, checksCsv, designs, evaluate, inputProblems, setoutCsv, slug, standardFor, tally,
} from "../fmc/ceiling/engine.js";
import { CeilingKit, emptyKit, parseLibrary } from "../fmc/ceiling/standard.js";
import { packPlan } from "../fmc/ceiling/pack.js";
import { PlacePlan, placementPlan } from "../fmc/ceiling/place.js";
import { rcpSheet, rcpSpec, registerFamilies, sectionView, setoutView } from "../fmc/ceiling/drawings.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

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
    "are listed as kit change requests. " +
    "place (CL2): builds the design in the open model in one transaction (one Undo): a ceiling of the kit's I.CLG type " +
    "(the type whose keynote is brief.board, or place.ceiling_type) for each part of each zone at its height (field, " +
    "bulkhead soffit, raft, coffers); the step faces, cove, cornice and coffer mouldings with line-based families when " +
    "the model has them loaded (otherwise listed as kit change requests, never invented); fixtures as marked positions " +
    "only (model-line marks and a list): lights and fans are the electrical engineer's design. edit: replaces what the " +
    "last place made for this room with the design as it is now. drawings (CL4): the board set-out and a schematic " +
    "section as drafting views, the reflected ceiling plan (VT_I_RCP, 1:50) with the kit's FMC_SYM_* symbols, height " +
    "symbols and a key, and the RCP sheet from the kit's sheet register with its views. place, edit and drawings send a " +
    "dry run (the real run rolled back in Revit) unless dry_run is false, and dry_run=false needs confirm=true after a " +
    "person said yes; the real run goes through the live-model lock (new documents, _Staging and _ChainTests; in a live " +
    "project a person presses Place in the pane). Needs place.level and place.origin_mm (where the room's corner is).";

export const FMC_CEILING_SHAPE = {
  action: z.enum(["designs", "checks", "setout", "quantities", "boq", "pack", "place", "edit", "drawings"]),
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
  place: z.object({
    level: z.string().describe("The level the room is on (by name); heights are above it"),
    origin_mm: POINT.optional().default({ x: 0, y: 0 }).describe("Where the room's corner (0, 0) is in the model, in mm"),
    ceiling_type: z.string().optional().default("").describe("A ceiling type by name. Empty: the type whose keynote is brief.board"),
  }).optional().describe("place, edit, drawings: where the room is in the model"),
  drawings: z.object({
    sheet_number: z.string().optional().default("").describe("Empty: the kit sheet register's VT_I_RCP sheet"),
    sheet_name: z.string().optional().default(""),
    title_block: z.string().optional().default("").describe("A loaded title block (family or type name). Empty: the first FMC_TB_* loaded"),
  }).optional().default({}),
  project_folder: z.string().optional().default("").describe("pack: the project folder (the pack goes into its 01_WIP); place, edit: where the record of what was placed is kept"),
  kit_folder: z.string().optional().default("").describe("The kit folder. Empty: the files named in fmc_guard.json"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("pack, place, edit, drawings with dry_run=false: true only once a person said yes to the dry run"),
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
  // CL4: the registers the drawings read (their absence only matters to drawings, which says so)
  try { kit.families = registerFamilies(read(win.join(master, "FMC_Family_Register.csv"))); } catch { kit.families = null; }
  try { kit.rcp_sheet = rcpSheet(read(win.join(master, "FMC_Sheet_Register.csv"))); } catch { kit.rcp_sheet = null; }
  return kit;
}

// ---------- CL2 placement records ----------

export interface PlacedRecord { room: string; design: string; level: string; placed_at: string; made: string[]; elements: Array<{ unique_id: string; key: string }> }

export const placedRecordFile = (project: string, room: string) =>
  win.join(expandEnv(project.trim()), "01_WIP", "_Ceilings", "_Placed", `FMC_Ceiling_${slug(room)}.json`);

function readPlaced(project: string, room: string): PlacedRecord | null {
  if (!project.trim()) return null;
  const f = placedRecordFile(project, room);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : null;
}

/** What the place/edit command gets: the plan in model mm, the ceiling type to use and what to replace. */
export function placeParams(plan: PlacePlan, room: string, level: string, board: string, ceilingType: string, replace: string[], dry: boolean) {
  return {
    room, tag: `FMC:CEILING:${slug(room)}`, level, board, ceiling_type: ceilingType, dry_run: dry, replace,
    ceilings: plan.ceilings, lines: plan.lines, marks: plan.marks,
  };
}

/** The dry run goes straight to Revit (it is rolled back there); the real run goes through the live-model lock. */
async function revit(command: string, params: object, dry: boolean, timeout = 300000): Promise<Record<string, any>> {
  return await withRevitConnection((c) => dry ? c.sendRaw(command, params, timeout) : c.sendCommand(command, params, timeout)) as Record<string, any>;
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
    const writes = ["pack", "place", "edit", "drawings"].includes(args.action);
    if (writes && !dry && args.confirm !== true)
      return reply({ refused: true, reasons: [`dry_run=false ${args.action === "pack" ? "writes the pack" : "changes the model"}: run the dry run, show it, and send confirm=true once the person says yes`] }, true);
    if (["place", "edit", "drawings"].includes(args.action) && !args.place?.level?.trim())
      return reply({ refused: true, reasons: ["place.level is needed: the level the room is on (and place.origin_mm, where its corner is in the model)"] }, true);
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
    log(config, `ceiling_${args.action}`, writes ? dry : true, input.room.name, writes && !dry ? "writing" : "ok", e.design.label);

    if (args.action === "place" || args.action === "edit") return await placeOrEdit(args, input, e, kcr, head, dry, config);
    if (args.action === "drawings") return await drawings(args, input, e, kit, kcr, head, dry, config);

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

const MARKS_NOTE = "Lights, fan, detectors and sprinklers are marked positions only (model-line marks and the list): the electrical " +
  "engineer designs the lighting and the fan supply, the fire engineer the detectors and sprinklers (rule 5). Whether CL2 " +
  "should place fixtures is an open question to the owner (docs/PLAN_CEILINGS.md)";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** CL2: place the design (or, edit, replace what was placed last time) in the open model: a dry run first. */
async function placeOrEdit(args: FmcCeilingArgs, input: CeilingInput, e: Evaluated, kcr: string[], head: object, dry: boolean, config: GuardConfig) {
  const pl = args.place!;
  const room = input.room.name;
  const plan = placementPlan(e.design, input, pl.origin_mm);
  const project = args.project_folder.trim();
  if (!dry || args.action === "edit") {
    if (!project) return reply({ refused: true, reasons: ["Set project_folder: what was placed is recorded in its 01_WIP, so edit can replace exactly that later"] }, true);
    const v = checkWritePath(placedRecordFile(project, room), config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
  }
  const before = readPlaced(project, room);
  if (args.action === "place" && before)
    return reply({ refused: true, reasons: [`${room} was placed on ${before.placed_at} (${before.made.length} elements): use edit to replace them with this design`] }, true);
  if (args.action === "edit" && !before)
    return reply({ refused: true, reasons: [`Nothing is recorded as placed for ${room} in ${project}: use place first`] }, true);
  const replace = before?.made ?? [];
  const command = args.action === "place" ? "fmc_ceiling_place" : "fmc_ceiling_edit";
  const params = placeParams(plan, room, pl.level, input.brief.board, pl.ceiling_type, replace, dry);
  const planOut = {
    summary: plan.summary,
    ceilings: plan.ceilings.map((c) => ({ key: c.key, zone: c.zone, height_mm: c.height_mm, area_m2: c.area_m2, openings: c.loops.length - 1 })),
    lines: plan.lines.map((l) => ({ key: l.key, role: l.role, length_mm: l.length_mm, z_mm: l.z_mm, drop_mm: l.drop_mm })),
    marks: plan.marks.map((m) => ({ key: m.key, label: m.label, x: m.x, y: m.y, z_mm: m.z_mm })),
    problems: plan.problems,
  };
  if (dry) {
    let rv: Record<string, any>;
    try { rv = await revit(command, params, true); } catch (err) { rv = { not_reached: `Revit dry run not run: ${errText(err)}` }; }
    return reply({ ...head, dry_run: true, action: args.action, plan: planOut, would_replace: replace.length, revit: rv,
      kit_change_requests: [...kcr, ...strings(rv.kit_change_requests)], note: MARKS_NOTE,
      next: "Show this to the person; run again with dry_run=false and confirm=true once they say yes (new documents, _Staging and _ChainTests; in a live project a person presses Place in the pane)" });
  }
  const r = await revit(command, params, false);
  const elements: Array<{ unique_id: string; key: string }> = Array.isArray(r.elements) ? r.elements : [];
  const rec: PlacedRecord = { room, design: e.design.kind, level: pl.level, placed_at: new Date().toISOString(), made: elements.map((x) => x.unique_id), elements };
  const file = placedRecordFile(project, room);
  fs.mkdirSync(win.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  log(config, `ceiling_${args.action}`, false, room, "done", `${e.design.label}: ${elements.length} elements, ${r.removed ?? 0} replaced`);
  return reply({ ...head, done: true, action: args.action, made: elements.length, removed: r.removed ?? 0, ceiling_type: r.ceiling_type, not_placed: r.not_placed ?? [],
    notes: r.notes ?? [], warnings: r.warnings ?? [], record: file, kit_change_requests: [...kcr, ...strings(r.kit_change_requests)], note: MARKS_NOTE,
    next: "Check the ceilings in the RCP (fmc_ceiling drawings makes the RCP sheet and the set-out drawing)" });
}

/** CL4: the set-out and section drafting views, the RCP with the kit's symbols, and the RCP sheet: a dry run first. */
async function drawings(args: FmcCeilingArgs, input: CeilingInput, e: Evaluated, kit: CeilingKit, kcr: string[], head: object, dry: boolean, config: GuardConfig) {
  const pl = args.place!;
  const name = slug(input.room.name);
  const sheetNo = args.drawings.sheet_number.trim() || kit.rcp_sheet?.number || "";
  if (!sheetNo) return reply({ refused: true, reasons: ["No RCP sheet: the kit's sheet register (03_Master_Data\\FMC_Sheet_Register.csv) has no row placed with VT_I_RCP; give drawings.sheet_number"] }, true);
  const sheetName = args.drawings.sheet_name.trim() || kit.rcp_sheet?.name || `${input.room.name} reflected ceiling plan`;
  const scale = Number(/1\s*:\s*(\d+)/.exec(kit.rcp_sheet?.scale ?? "")?.[1] ?? 50) || 50;
  const plan = placementPlan(e.design, input, pl.origin_mm);
  const setout = setoutView(e, input, `I-CLG-${name}-SetOut`, scale, undefined, sheetNo);
  const section = sectionView(e.design, input, `I-CLG-${name}-Section`, scale, undefined, sheetNo);
  const rcp = rcpSpec(e.design, plan, input, pl.origin_mm, kit.families ?? null, undefined, scale);
  const reqs = [...kcr, ...rcp.kit_change_requests];
  if (kit.families == null) reqs.push("03_Master_Data\\FMC_Family_Register.csv not readable: the RCP symbols were sent unchecked");
  reqs.push("Ceiling detail items for the section details (bulkhead, cove, cornice, hatch: FMC_DI_I_* or a ceiling detail sheet): the kit has none, so the section is schematic");
  reqs.push("A ceiling setting-out point symbol and hanger/furring/main channel detail items: the set-out drawing draws them with lines until the kit has them");
  const rcpName = `I-RCP-${name}`;
  const params = {
    dry_run: dry, room: input.room.name,
    drafting: { views: [setout, section], dry_run: false },
    rcp: { level: pl.level, view_name: rcpName, template: "VT_I_RCP", scale, crop_mm: rcp.crop_mm, symbols: rcp.symbols, texts: rcp.texts },
    sheet: { number: sheetNo, name: sheetName, title_block: args.drawings.title_block.trim(), views: [rcpName, setout.name, section.name] },
  };
  const out = {
    views: [{ name: rcpName, kind: "RCP", symbols: rcp.symbols.length, texts: rcp.texts.length }, ...[setout, section].map((v) => ({ name: v.name, kind: "drafting", items: v.items.length }))],
    sheet: { number: sheetNo, name: sheetName, from: args.drawings.sheet_number.trim() ? "given" : "kit sheet register" },
    symbols_left_out: rcp.left_out,
  };
  if (dry) {
    let rv: Record<string, any>;
    try { rv = await revit("fmc_ceiling_sheet", params, true, 600000); } catch (err) { rv = { not_reached: `Revit dry run not run: ${errText(err)}` }; }
    return reply({ ...head, dry_run: true, drawings: out, revit: rv, kit_change_requests: [...reqs, ...strings(rv.kit_change_requests)],
      next: "Show this to the person; run again with dry_run=false and confirm=true once they say yes" });
  }
  const r = await revit("fmc_ceiling_sheet", params, false, 600000);
  log(config, "ceiling_drawings", false, input.room.name, "done", `${rcpName}, ${setout.name}, ${section.name} on ${sheetNo}`);
  return reply({ ...head, done: true, drawings: out, revit: r, kit_change_requests: [...reqs, ...strings(r.kit_change_requests)],
    next: "Check the sheet (fmc_doc screenshot); a person arranges the viewports and issues it" });
}

export function registerFmcCeilingTool(server: McpServer) {
  server.tool("fmc_ceiling", FMC_CEILING_DESCRIPTION, FMC_CEILING_SHAPE, (args) => runFmcCeiling(args));
}
